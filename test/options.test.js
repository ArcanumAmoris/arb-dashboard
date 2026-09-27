// Kalshi vs options: probability, strike placement, hedge sizing and simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, normInv, probAbove, impliedVolAt, parseOcc, pickSpread, spreadFraction, simulateUnit, sizeOptionsTrade, evaluateOptionsTrade } from '../docs/lib/options.js';
import { fillCost } from '../docs/lib/math.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const V = { minProfit: 5, minReturnPct: 2, lockedMarginPct: 1, evMarginPct: 10, minHoldDays: 1, feeRoundTo: 0.0001, maxLossChance: 0.05, optionFeePerContract: 0 };

test('normal distribution helpers: N(0)=50%, N(1.96)≈97.5%, and N⁻¹ undoes N', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(normInv(0.013)), 0.013, 1e-7);
});

test('probability from implied volatility: BTC $84,455, strike $90,000, 5 days, 45% vol ≈ 10.9% (How-it-works example)', () => {
  close(probAbove(84455, 90000, 0.45, 5 / 365), 0.1087, 5e-4);
});

test('at the money with almost no time left is a coin flip', () => {
  close(probAbove(100, 100, 0.3, 1e-8), 0.5, 1e-3);
});

test('implied volatility is read from the strike itself (keeps the skew)', () => {
  const calls = [{ strike: 50, iv: 0.5, bid: 1, ask: 1.1 }, { strike: 60, iv: 0.6, bid: 0.5, ask: 0.6 }];
  close(impliedVolAt(calls, [], 55, 48), 0.55);
});

test('OCC option symbols are parsed', () => {
  assert.deepEqual(parseOcc('SPXW261002C07700000'), { root: 'SPXW', expiry: '2026-10-02', type: 'C', strike: 7700 });
  assert.deepEqual(parseOcc('IBIT261218C00080000'), { root: 'IBIT', expiry: '2026-12-18', type: 'C', strike: 80 });
});

const q = (strike, bid, ask, size = 50) => ({ strike, bid, ask, bid_size: size, ask_size: size, iv: 0.55 });

test('call-spread hedge sits BELOW the mapped strike so it is fully paid whenever Kalshi NO loses', () => {
  // BTC $150k × 0.0005674 = IBIT $85.11; margin 0.4% → edge $84.77
  const calls = [q(75, 0.32, 0.35), q(79, 0.26, 0.28), q(80, 0.25, 0.26), q(84, 0.21, 0.23), q(85, 0.2, 0.22), q(90, 0.16, 0.18)];
  const s = pickSpread({ calls, puts: [], lossDir: 'up', edge: 84.77 });
  assert.equal(s.type, 'call');
  assert.ok(s.k2 <= 84.77, `short strike ${s.k2} must be at or below the edge`);
  assert.equal(s.sell.strike, s.k2);
  assert.equal(s.buy.strike, s.k1);
  close(s.debit, s.buy.price - s.sell.price);
  close(s.perUnit, s.debit / s.width);
});

test('put-spread hedge sits ABOVE the mapped strike (Kalshi side pays above, loses below)', () => {
  const puts = [q(95, 0.1, 0.12), q(100, 0.3, 0.33), q(101, 0.4, 0.43), q(105, 1.2, 1.3), q(110, 3, 3.2)];
  const s = pickSpread({ calls: [], puts, lossDir: 'down', edge: 100.4 });
  assert.equal(s.type, 'put');
  assert.ok(s.k1 >= 100.4, `short strike ${s.k1} must be at or above the edge`);
  assert.equal(spreadFraction(s, s.k1 - 1), 1);        // fully paid below k1
  assert.equal(spreadFraction(s, s.k2 + 1), 0);        // worthless above k2
});

test('slippage makes the spread more expensive', () => {
  const calls = [q(79, 0.26, 0.28), q(84, 0.21, 0.23)];
  const a = pickSpread({ calls, puts: [], lossDir: 'up', edge: 84.5 });
  const b = pickSpread({ calls, puts: [], lossDir: 'up', edge: 84.5, slip: 0.01 });
  close(b.debit - a.debit, 0.02);
});

test('same-time, same-index hedge (SPX-style) can never pay less than $1', () => {
  const spread = { type: 'call', k1: 7990, k2: 8000, width: 10 };
  const sim = simulateUnit({ s0: 7950, strikeK: 8000, kalshiPaysAbove: false, ratio: 1, spread, sigma: 0.15, tK: 3 / 365, tO: 3 / 365, basisSigma: 0, paths: 20000 });
  assert.equal(sim.pUnderOne, 0);
  assert.ok(sim.worst >= 1 - 1e-12);
  assert.ok(sim.pBonus > 0);   // results between 7990 and 8000 pay on both sides
});

test('a two-week gap between Kalshi and the option expiry creates a real chance of loss', () => {
  const spread = { type: 'call', k1: 75, k2: 80, width: 5 };
  const sim = simulateUnit({ s0: 84300, strikeK: 150000, kalshiPaysAbove: false, ratio: 0.0005674, spread, sigma: 0.57, tK: 96 / 365, tO: 82 / 365, basisSigma: 0.002, paths: 20000 });
  assert.ok(sim.pUnderOne > 0, 'gap risk must show up');
  assert.ok(sim.pUnderOne < 0.02, 'but it is small for a far-away strike');
});

test('YOUR BTC END-OF-2026 TRADE, worked: Kalshi NO at 97.5¢ + IBIT $75/$80 call spread at 5¢ on $500', () => {
  const opp = {
    kalshi: { levels: [{ price: 0.975, size: 2000 }], feeMultiplier: 0, feeType: 'quadratic' },   // KXBTCY has zero Kalshi fees
    spread: { width: 5, debit: 0.05, maxSpreads: 50 },
    sim: { meanPayout: 1.0114, pUnderOne: 0.0049, worst: 0, p01: 1 },
    holdUntil: '2027-01-01T05:00:00Z',
  };
  const sz = sizeOptionsTrade(opp, 500, { fillCost });
  assert.equal(sz.perSpreadContracts, 500);             // one $5-wide spread pays $500 = 500 Kalshi contracts
  assert.equal(sz.best.spreads, 1);
  close(sz.best.total, 500 * 0.975 + 5);                // $487.50 + $5.00 = $492.50
  close(sz.best.tailProfit, 7.5);                        // $500 back in every normal outcome
  const e = evaluateOptionsTrade(opp, 500, 4.18, V, { fillCost }, Date.parse('2026-09-27T12:00:00Z'));
  close(e.profitExpected, 500 * 1.0114 - 492.5, 1e-6);   // $13.20
  assert.equal(e.verdict, 'MARGINAL');                   // ~10%/yr < T-bill 4.18% + 10 points for a can-lose trade
});

test('too small a budget says how much is needed instead of pretending', () => {
  const opp = { kalshi: { levels: [{ price: 0.975, size: 2000 }], feeMultiplier: 0, feeType: 'quadratic' },
    spread: { width: 5, debit: 0.05, maxSpreads: 50 }, sim: { meanPayout: 1.01, pUnderOne: 0, worst: 1, p01: 1 }, holdUntil: '2027-01-01T05:00:00Z' };
  const e = evaluateOptionsTrade(opp, 200, 4.18, V, { fillCost }, Date.parse('2026-09-27T12:00:00Z'));
  assert.equal(e.qty, 0);
  close(e.minBudget, 492.5);
});

test('a high simulated chance of loss blocks WORTH IT', () => {
  const opp = { kalshi: { levels: [{ price: 0.5, size: 5000 }], feeMultiplier: 0, feeType: 'quadratic' },
    spread: { width: 1, debit: 0.4, maxSpreads: 50 }, sim: { meanPayout: 1.2, pUnderOne: 0.12, worst: 0, p01: 0 }, holdUntil: '2026-10-05T20:00:00Z' };
  const e = evaluateOptionsTrade(opp, 500, 4.18, V, { fillCost }, Date.parse('2026-09-28T14:00:00Z'));
  assert.equal(e.verdict, 'MARGINAL');
  assert.match(e.verdictWhy, /chance of losing/);
});
