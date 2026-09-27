// Arbitrage detection and bracket-sum math with worked examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketInterval, isSubset, coversEverything, bestSize, evaluate, setCost } from '../docs/lib/math.js';
import { scanEvent, asksFromOrderbook, strikeTick, topSetCost } from '../scanner/detect.js';

const V = { minProfit: 5, minReturnPct: 2, lockedMarginPct: 1, evMarginPct: 10, minHoldDays: 1, feeRoundTo: 0.0001 };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// helper: a Kalshi market record with top of book
function mk(ticker, strike, { yb, ya, ybSize = 500, yaSize = 500, status = 'active' } = {}) {
  return { ticker, event_ticker: 'EV', series_ticker: 'KXTEST', title: 'Test price?', yes_sub_title: ticker, status,
    ...strike, yes_bid_dollars: String(yb), yes_ask_dollars: String(ya), no_ask_dollars: String(+(1 - yb).toFixed(4)),
    no_bid_dollars: String(+(1 - ya).toFixed(4)), yes_bid_size_fp: String(ybSize), yes_ask_size_fp: String(yaSize),
    close_time: '2026-12-31T21:00:00Z', expected_expiration_time: '2026-12-31T21:05:00Z', volume_24h_fp: '100', open_interest_fp: '1000' };
}
const series = { ticker: 'KXTEST', title: 'Test', fee_multiplier: 1, fee_type: 'quadratic' };

test('intervals: "above 105k" sits inside "above 100k"', () => {
  const a100 = marketInterval({ strike_type: 'greater', floor_strike: 100000 });
  const a105 = marketInterval({ strike_type: 'greater', floor_strike: 105000 });
  assert.ok(isSubset(a105, a100));
  assert.ok(!isSubset(a100, a105));
});

test('intervals: a bracket 100k-104,999.99 sits inside "above 99,999.99"', () => {
  const br = marketInterval({ strike_type: 'between', floor_strike: 100000, cap_strike: 104999.99 });
  const above = marketInterval({ strike_type: 'greater', floor_strike: 99999.99 });
  assert.ok(isSubset(br, above));
});

test('coverage: below 100k + 100k–104,999.99 + above 104,999.99 covers every price', () => {
  const iv = [
    marketInterval({ strike_type: 'less', cap_strike: 100000 }),
    marketInterval({ strike_type: 'between', floor_strike: 100000, cap_strike: 104999.99 }),
    marketInterval({ strike_type: 'greater', floor_strike: 104999.99 }),
  ];
  assert.ok(coversEverything(iv, 0.01));
});

test('coverage: a missing bracket is detected (YES-on-everything would NOT be locked)', () => {
  const iv = [
    marketInterval({ strike_type: 'less', cap_strike: 100000 }),
    marketInterval({ strike_type: 'greater', floor_strike: 104999.99 }),
  ];
  assert.ok(!coversEverything(iv, 0.01));
});

test('strike precision: GDP-style strikes in tenths give a 0.1 step', () => {
  assert.equal(strikeTick([{ floor_strike: 0.6, cap_strike: 1.0 }, { floor_strike: 1.1, cap_strike: 1.5 }]), 0.1);
  assert.equal(strikeTick([{ floor_strike: 74250, cap_strike: 74499.99 }]), 0.01);
});

test('order book: Kalshi lists only bids; a 97¢ NO bid means you can BUY YES at 3¢', () => {
  const asks = asksFromOrderbook({ orderbook_fp: { yes_dollars: [['0.20', '50']], no_dollars: [['0.80', '35.5'], ['0.97', '20']] } });
  assert.deepEqual(asks.yes, [{ price: 0.03, size: 20 }, { price: 0.2, size: 35.5 }]);
  assert.deepEqual(asks.no, [{ price: 0.8, size: 50 }]);
});

test('LADDER violation → locked arbitrage. Worked example:', () => {
  // "BTC above 100k" asks 40¢. "BTC above 105k" BIDS 45¢ (higher strike priced ABOVE lower strike).
  // Buy YES "above 100k" at 40¢ and NO "above 105k" at 1 - 0.45 = 55¢.
  // Cost 95¢ + fees (0.07·.4·.6 = 1.68¢; 0.07·.55·.45 = 1.7325¢ rounds UP to 1.74¢) = 98.42¢ for a payout of at least $1.
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'BTC', mutually_exclusive: false, markets: [
    mk('T100', { strike_type: 'greater', floor_strike: 100000 }, { yb: 0.38, ya: 0.40 }),
    mk('T105', { strike_type: 'greater', floor_strike: 105000 }, { yb: 0.45, ya: 0.47 }),
  ] };
  const { opps } = scanEvent(ev, series);
  const lad = opps.find(o => o.type === 'ladder');
  assert.ok(lad, 'ladder arbitrage found');
  assert.deepEqual(lad.legs.map(l => `${l.ticker}:${l.side}`), ['T100:YES', 'T105:NO']);
  close(topSetCost(lad.legs), 0.9842);
  assert.equal(lad.minPayoff, 1);
  assert.equal(lad.maxPayoff, 2);   // lands between 100k and 105k: both legs pay
});

test('a consistent ladder produces no opportunity', () => {
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'BTC', mutually_exclusive: false, markets: [
    mk('T100', { strike_type: 'greater', floor_strike: 100000 }, { yb: 0.58, ya: 0.60 }),
    mk('T105', { strike_type: 'greater', floor_strike: 105000 }, { yb: 0.30, ya: 0.32 }),
  ] };
  assert.equal(scanEvent(ev, series).opps.length, 0);
});

test('BRACKET SUM: YES on all brackets costs 93¢ + fees < $1 → locked', () => {
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'BTC range', mutually_exclusive: true, markets: [
    mk('LOW', { strike_type: 'less', cap_strike: 100000 }, { yb: 0.28, ya: 0.30 }),
    mk('MID', { strike_type: 'between', floor_strike: 100000, cap_strike: 104999.99 }, { yb: 0.38, ya: 0.40 }),
    mk('HIGH', { strike_type: 'greater', floor_strike: 104999.99 }, { yb: 0.21, ya: 0.23 }),
  ] };
  const o = scanEvent(ev, series).opps.find(x => x.type === 'bracket-all-yes');
  assert.ok(o);
  // fees: .07·.3·.7=.0147, .07·.4·.6=.0168, .07·.23·.77=.012397→.0124  => total .0439
  close(topSetCost(o.legs), 0.93 + 0.0147 + 0.0168 + 0.0124);
  assert.equal(o.locked, true);
});

test('named outcomes that might ALL fail are never offered as "buy every YES"', () => {
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'Who will acquire X?', mutually_exclusive: true, markets: [
    mk('A', {}, { yb: 0.04, ya: 0.05 }), mk('B', {}, { yb: 0.05, ya: 0.06 }), mk('C', {}, { yb: 0.05, ya: 0.06 }),
  ] };
  assert.equal(scanEvent(ev, series).opps.filter(o => /yes/.test(o.type) && o.type !== 'yes-plus-no').length, 0);
});

test('NO SET: at most one outcome wins, so 3 NOs always pay ≥ $2. Worked example:', () => {
  // YES bids 40¢, 40¢, 35¢ → NO asks 60¢, 60¢, 65¢ = $1.85 + fees; guaranteed $2 back.
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'Fed decision', mutually_exclusive: true, markets: [
    mk('CUT', {}, { yb: 0.40, ya: 0.42 }), mk('HOLD', {}, { yb: 0.40, ya: 0.42 }), mk('HIKE', {}, { yb: 0.35, ya: 0.37 }),
  ] };
  const o = scanEvent(ev, series).opps.find(x => x.type === 'outcomes-no-set');
  assert.ok(o);
  assert.equal(o.legs.length, 3);
  assert.equal(o.minPayoff, 2);
  close(topSetCost(o.legs), 1.85 + 0.0168 + 0.0168 + 0.0160); // .07·.6·.4=.0168 ; .07·.65·.35=.015925→.016
});

test('YES + NO on the same contract below $1 is locked', () => {
  const ev = { event_ticker: 'EV', series_ticker: 'KXTEST', title: 'x', mutually_exclusive: false, markets: [
    { ...mk('X', {}, { yb: 0.5, ya: 0.5 }), yes_ask_dollars: '0.45', no_ask_dollars: '0.50' } ] };
  const o = scanEvent(ev, series).opps.find(x => x.type === 'yes-plus-no');
  assert.ok(o);
  close(topSetCost(o.legs), 0.95 + 0.0174 + 0.0175); // .07·.45·.55 = .017325 → .0174
});

test('sizing stops where the next contract would lose money', () => {
  // leg A: 10 @ 0.40 then 100 @ 0.60 ; leg B: 200 @ 0.50. Set at (0.40+0.50) is profitable, (0.60+0.50) is not.
  const opp = { locked: true, minPayoff: 1, maxPayoff: 1, settleTime: '2027-01-01T00:00:00Z', legs: [
    { levels: [{ price: 0.40, size: 10 }, { price: 0.60, size: 100 }], feeMultiplier: 1, feeType: 'quadratic' },
    { levels: [{ price: 0.50, size: 200 }], feeMultiplier: 1, feeType: 'quadratic' }] };
  const s = bestSize(opp, 10000);
  assert.equal(s.qty, 10);
  const c = setCost(opp, 10);
  close(s.profitWorst, 10 - c.total);
});

test('sizing respects the budget', () => {
  const opp = { locked: true, minPayoff: 1, maxPayoff: 1, settleTime: '2027-01-01T00:00:00Z', legs: [
    { levels: [{ price: 0.45, size: 1000 }], feeMultiplier: 1, feeType: 'quadratic' },
    { levels: [{ price: 0.45, size: 1000 }], feeMultiplier: 1, feeType: 'quadratic' }] };
  const s = bestSize(opp, 100);
  assert.ok(s.total <= 100);
  assert.ok(setCost(opp, s.qty + 1).total > 100);
});

test('verdict: a locked 1% gain over 90 days loses to T-bills → NOT WORTH IT', () => {
  // cost ~0.99/set, pays $1, 90 days → ~4.1%/yr, T-bill 4.18%
  const now = Date.parse('2026-10-01T00:00:00Z');
  const opp = { locked: true, minPayoff: 1, maxPayoff: 1, settleTime: '2026-12-30T00:00:00Z', legs: [
    { levels: [{ price: 0.99, size: 10000 }], feeMultiplier: 0, feeType: 'quadratic' }] };
  const e = evaluate(opp, 500, 4.18, V, now);
  assert.equal(e.verdict, 'NOT WORTH IT');
});

test('verdict: locked 5% in 30 days on $500 → WORTH IT', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const opp = { locked: true, minPayoff: 1, maxPayoff: 1, settleTime: '2026-10-31T00:00:00Z', legs: [
    { levels: [{ price: 0.95, size: 10000 }], feeMultiplier: 0, feeType: 'quadratic' }] };
  const e = evaluate(opp, 500, 4.18, V, now);
  assert.equal(e.qty, 526);                 // floor(500 / 0.95)
  close(e.profitWorst, 526 * 0.05);         // $26.30
  assert.equal(e.verdict, 'WORTH IT');
});
