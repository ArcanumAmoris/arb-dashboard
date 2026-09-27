// Fee math. Worked examples straight from Kalshi's July 7, 2026 fee schedule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kalshiFee, fillCost, roundUpTo } from '../docs/lib/math.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('100 contracts at 50¢ cost $1.75 in fees (0.07 × 100 × 0.5 × 0.5)', () => {
  close(kalshiFee(0.5, 100), 1.75);
});

test('1 contract at 50¢: 0.07 × 0.25 = $0.0175, already a whole centicent', () => {
  close(kalshiFee(0.5, 1), 0.0175);
});

test('fee is symmetric: 10¢ and 90¢ both cost 0.63¢ per contract', () => {
  close(kalshiFee(0.1, 1), 0.0063);
  close(kalshiFee(0.9, 1), 0.0063);
});

test('20 contracts at 60¢: raw 0.07 × 20 × 0.6 × 0.4 = $0.336', () => {
  close(kalshiFee(0.6, 20), 0.336);
});

test('rounding goes UP to the next centicent: 1 contract at 1¢ = 0.0693¢ → $0.0007', () => {
  close(kalshiFee(0.01, 1), 0.0007);
});

test('old-style rounding to the cent is available for extra caution', () => {
  close(kalshiFee(0.01, 1, { roundTo: 0.01 }), 0.01);
  close(kalshiFee(0.5, 100, { roundTo: 0.01 }), 1.75);
});

test('series multiplier: zero-fee series (e.g. KXETHY) pay nothing', () => {
  assert.equal(kalshiFee(0.3, 500, { multiplier: 0 }), 0);
});

test('unknown fee type returns null instead of guessing', () => {
  assert.equal(kalshiFee(0.3, 10, { feeType: 'flat' }), null);
});

test('roundUpTo does not inflate exact values because of float noise', () => {
  close(roundUpTo(0.07 * 0.5 * 0.5, 0.0001), 0.0175);
});

test('walking the order book: 150 contracts across two price levels', () => {
  // 100 @ 40¢ then 50 @ 42¢
  const r = fillCost([{ price: 0.40, size: 100 }, { price: 0.42, size: 80 }], 150);
  close(r.cost, 40 + 21);                         // $61.00
  close(r.fee, 1.68 + 0.8526);                    // 0.07·100·.4·.6 = 1.68 ; 0.07·50·.42·.58 = 0.8526
  assert.equal(r.filled, 150);
  assert.equal(r.worstPrice, 0.42);
  assert.equal(r.complete, true);
});

test('not enough depth: reports a partial fill', () => {
  const r = fillCost([{ price: 0.40, size: 10 }], 25);
  assert.equal(r.filled, 10);
  assert.equal(r.complete, false);
});
