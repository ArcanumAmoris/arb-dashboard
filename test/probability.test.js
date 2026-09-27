// Probability math used today: implied probability from prices, the chance of the
// "bonus" payout, and expected profit. (Stage 2 adds the lognormal model + its tests.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../docs/lib/math.js';
import { mid, scanEvent } from '../scanner/detect.js';

const V = { minProfit: 5, minReturnPct: 2, lockedMarginPct: 1, evMarginPct: 10, minHoldDays: 1, feeRoundTo: 0.0001 };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('implied probability = midpoint of bid and ask: 38¢/42¢ → 40%', () => {
  close(mid({ yes_bid_dollars: '0.38', yes_ask_dollars: '0.42' }), 0.40);
});

test('ladder bonus: P(100k < BTC ≤ 105k) = P(>100k) − P(>105k) from the midpoints', () => {
  const m = (t, f, yb, ya) => ({ ticker: t, event_ticker: 'E', series_ticker: 'S', title: 'x', yes_sub_title: t, status: 'active',
    strike_type: 'greater', floor_strike: f, yes_bid_dollars: String(yb), yes_ask_dollars: String(ya),
    no_ask_dollars: String(1 - yb), yes_bid_size_fp: '100', yes_ask_size_fp: '100', close_time: '2027-01-01T00:00:00Z' });
  const ev = { event_ticker: 'E', series_ticker: 'S', title: 'x', mutually_exclusive: false,
    markets: [m('A', 100000, 0.38, 0.40), m('B', 105000, 0.45, 0.47)] };
  const o = scanEvent(ev, { fee_multiplier: 1, fee_type: 'quadratic' }).opps.find(x => x.type === 'ladder');
  // mids: A = 0.39, B = 0.46 → "negative" probability is clamped to 0
  close(o.bonusProb, 0);
});

test('expected profit = worst case + (extra payout × its probability)', () => {
  // 10 sets, worst case pays $1/set, best $2/set, 25% chance of the bonus. Cost $9.50 (no fees).
  const now = Date.parse('2026-10-01T00:00:00Z');
  const opp = { locked: true, minPayoff: 1, maxPayoff: 2, bonusProb: 0.25, settleTime: '2026-10-11T00:00:00Z',
    legs: [{ levels: [{ price: 0.95, size: 10 }], feeMultiplier: 0, feeType: 'quadratic' }] };
  const e = evaluate(opp, 9.5, 4, V, now);
  close(e.profitWorst, 0.5);
  close(e.profitBest, 10.5);
  close(e.profitExpected, 0.5 + 10 * 1 * 0.25);   // $3.00
});
