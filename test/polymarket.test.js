// Kalshi vs Polymarket US: bracket parsing, settlement-methodology diffing, cross-venue
// subset detection, and the fee-formula reuse trick — the pure logic in scanner/polymarket.js.
// (scanPolymarket() itself hits the network for both platforms' live data and isn't unit
// tested here, same as scanOptions() in test/options.test.js — only its building blocks are.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pmInterval, settlementCheck, KALSHI_SETTLEMENT, PM_TAKER_COEFFICIENT,
  parsePmSettlementInstant, settlementGapHours, MAX_SETTLEMENT_GAP_HOURS_TO_PAIR, SETTLEMENT_GAP_HOURS_FOR_LOCK,
  PM_ASSETS } from '../scanner/polymarket.js';
import { isSubset, kalshiFee } from '../docs/lib/math.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---- pmInterval(): real Polymarket US bracket titles (confirmed live, BTC year-end ladder) ----
test('pmInterval parses an open-ended "or above" bracket', () => {
  assert.deepEqual(pmInterval('150,000 or above'), { lo: 150000, loIn: true, hi: Infinity, hiIn: false });
});

test('pmInterval parses an open-ended "or below" bracket', () => {
  assert.deepEqual(pmInterval('19,999.99 or below'), { lo: -Infinity, loIn: false, hi: 19999.99, hiIn: true });
});

test('pmInterval parses a closed "to" bracket, keeping both fractional cents', () => {
  assert.deepEqual(pmInterval('145,000 to 149,999.99'), { lo: 145000, loIn: true, hi: 149999.99, hiIn: true });
});

test('pmInterval returns null for text it does not recognize (never guesses a range)', () => {
  assert.equal(pmInterval('Yes'), null);
  assert.equal(pmInterval(''), null);
  assert.equal(pmInterval(undefined), null);
});

// ---- settlementCheck(): the real trimmed-vs-untrimmed BTC discrepancy found during research ----
test('settlementCheck flags BTC as basis risk: Polymarket describes a trimmed-mean BRTI, Kalshi is untrimmed', () => {
  // Real description text from a live cpc-btc-pricerange-yr-12-31-2026-* market (Sep 2026).
  const pmDescription = 'This market will resolve based on the CF Bitcoin Real-Time Index (BRTI) using a ' +
    'trimmed mean calculation over the sixty second period ending at 4:00pm ET on December 31, 2026, ' +
    'excluding the top 20% and bottom 20% of values.';
  const r = settlementCheck('BTC', pmDescription);
  assert.equal(r.verified, false);
  assert.match(r.note, /trim/i);
});

test('settlementCheck would verify BTC if Polymarket ever describes the same untrimmed BRTI average Kalshi uses', () => {
  const pmDescription = 'This market resolves based on the CF Bitcoin Real-Time Index (BRTI) as a straight average.';
  const r = settlementCheck('BTC', pmDescription);
  assert.equal(r.verified, true);
});

test('settlementCheck refuses to verify when the index family itself is not confirmed in the contract text', () => {
  const r = settlementCheck('BTC', 'This market resolves based on the closing price reported by CoinDesk.');
  assert.equal(r.verified, false);
  assert.match(r.note, /index family/);
});

test('settlementCheck has no documented Kalshi methodology for an unlisted asset, so it never verifies', () => {
  const r = settlementCheck('DOGE', 'Anything at all.');
  assert.equal(r.verified, false);
});

test('KALSHI_SETTLEMENT documents BTC and ETH as untrimmed (the basis for every basis-risk call above)', () => {
  assert.equal(KALSHI_SETTLEMENT.BTC.trimmed, false);
  assert.equal(KALSHI_SETTLEMENT.ETH.trimmed, false);
});

// ---- cross-venue subset detection: the same isSubset() math.js already uses within Kalshi,
//      fed intervals built from one Kalshi market and one Polymarket bracket title ----
test('a Polymarket bracket strictly inside a Kalshi range is a valid cross-venue ladder pairing', () => {
  const kalshiWide = { lo: 100000, loIn: true, hi: Infinity, hiIn: false }; // Kalshi "$100k or above"
  const pmNarrow = pmInterval('145,000 to 149,999.99');                    // Polymarket bracket inside it
  assert.ok(isSubset(pmNarrow, kalshiWide));
  assert.ok(!isSubset(kalshiWide, pmNarrow));
});

test('a Kalshi bracket strictly inside a Polymarket range is caught in the other direction too', () => {
  const pmWide = pmInterval('100,000 or above');
  const kalshiNarrow = { lo: 100000, loIn: true, hi: 105000, hiIn: false }; // Kalshi "$100k-$105k"
  assert.ok(isSubset(kalshiNarrow, pmWide));
});

test('identical ranges on both venues are never treated as a subset pairing (no ladder edge to exploit)', () => {
  const a = pmInterval('150,000 or above');
  const b = { lo: 150000, loIn: true, hi: Infinity, hiIn: false };
  assert.ok(isSubset(a, b) && isSubset(b, a)); // equal, so scanPolymarket's `isSubset(A,B) && !isSubset(B,A)` guard skips it
});

// ---- fee formula reuse: Polymarket's Θ×C×p×(1-p) via Kalshi's M×0.07×C×p×(1-p) with M = Θ/0.07 ----
test('folding Polymarket’s fee coefficient into an equivalent Kalshi multiplier reproduces Polymarket’s own fee formula exactly', () => {
  const theta = PM_TAKER_COEFFICIENT; // 0.0695, published at docs.polymarket.us/fees
  const price = 0.42, contracts = 100;
  const direct = theta * contracts * price * (1 - price); // Polymarket's own formula, unrounded
  const viaKalshiFee = kalshiFee(price, contracts, { multiplier: theta / 0.07, feeType: 'quadratic', roundTo: 1e-9 });
  close(viaKalshiFee, direct, 1e-6);
});

test('a market-specific feeCoefficient (not the default taker rate) is honored the same way', () => {
  const theta = 0.05; // hypothetical per-market override
  const price = 0.3, contracts = 10;
  const direct = theta * contracts * price * (1 - price);
  const viaKalshiFee = kalshiFee(price, contracts, { multiplier: theta / 0.07, feeType: 'quadratic', roundTo: 1e-9 });
  close(viaKalshiFee, direct, 1e-6);
});

// ---- settlement TIMESTAMP verification (not just index/method) ---------------------------
// Regression coverage for a real bug found in live testing: pairing Kalshi's *daily* BTC
// brackets against Polymarket's *year-end* brackets produced "arbitrage" across two
// completely different settlement dates (a $1 that pays out in October compared against a
// $1 that pays out in January is not the same dollar). The fix was twofold: (1) only ever
// pair Kalshi's year-end series (PM_ASSETS below), and (2) this independent timestamp gate.
const REAL_PM_DESCRIPTION = 'This market will resolve based on the CF Bitcoin Real-Time Index (BRTI) using a ' +
  'trimmed mean calculation over the sixty second period ending at 4:00pm ET on December 31, 2026, ' +
  'excluding the top 20% and bottom 20% of values.';

test('parsePmSettlementInstant reads "4:00pm ET on December 31, 2026" as that exact UTC instant', () => {
  const t = parsePmSettlementInstant(REAL_PM_DESCRIPTION);
  assert.equal(new Date(t).toISOString(), '2026-12-31T21:00:00.000Z'); // 4pm EST = 21:00 UTC
});

test('parsePmSettlementInstant returns null when the text does not state a plain instant', () => {
  assert.equal(parsePmSettlementInstant('This market resolves based on the closing price.'), null);
  assert.equal(parsePmSettlementInstant(''), null);
});

test('settlementGapHours: real Kalshi KXBTCY settle time (Jan 1, 05:05 UTC) is ~8 hours from Polymarket’s stated Dec 31 4pm ET instant', () => {
  const gap = settlementGapHours(REAL_PM_DESCRIPTION, '2027-01-01T05:05:00Z');
  assert.ok(gap > 7 && gap < 9, `expected ~8h, got ${gap}`);
  // Close enough to record as a pairing at all, but too far apart to call it genuinely
  // locked — this is exactly the real BTC year-end case: same event, small timing basis risk.
  assert.ok(gap <= MAX_SETTLEMENT_GAP_HOURS_TO_PAIR);
  assert.ok(gap > SETTLEMENT_GAP_HOURS_FOR_LOCK);
});

test('settlementGapHours: the real bug — a daily Kalshi contract settling in October is months from a Dec 31 Polymarket instant', () => {
  const gap = settlementGapHours(REAL_PM_DESCRIPTION, '2026-10-02T21:00:00Z');
  assert.ok(gap > MAX_SETTLEMENT_GAP_HOURS_TO_PAIR, 'a multi-month gap must never be treated as a valid pairing');
});

test('settlementGapHours is null (never a silent zero) when Polymarket’s text has no parseable instant, so callers skip rather than guess', () => {
  assert.equal(settlementGapHours('no instant stated here', '2027-01-01T05:05:00Z'), null);
});

test('PM_ASSETS only pairs Kalshi’s year-end series, never the daily ones, per the regression above', () => {
  for (const a of PM_ASSETS) {
    assert.ok(a.kalshiSeries.every(s => /Y$/.test(s)), `${a.id} lists a non-yearly series: ${a.kalshiSeries}`);
  }
});
