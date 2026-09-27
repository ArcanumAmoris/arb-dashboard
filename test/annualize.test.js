// Annualization + cash hurdle, with worked examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { annualize, holdDays, discountToInvestmentYield } from '../docs/lib/math.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('3% over 3 months (91.25 days) ≈ 12% a year', () => {
  close(annualize(0.03, 91.25), 0.12);
});

test('10% over 3 months ≈ 40% a year (your Tier 2 rule)', () => {
  close(annualize(0.10, 91.25), 0.40);
});

test('a 6-month trade needs twice the total return for the same annual rate', () => {
  close(annualize(0.06, 182.5), annualize(0.03, 91.25));
});

test('simple, not compounded: 1% in 1 day is 365%/yr (not 3,678%)', () => {
  close(annualize(0.01, 1), 3.65);
});

test('hold time is floored at 1 day so hourly markets do not annualize into fantasy', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  close(holdDays(now, now + 3600e3, 1), 1);                 // settles in 1 hour → counted as 1 day
  close(holdDays(now, now + 10 * 86400e3, 1), 10);
});

test('T-bill: 4.08% bank discount (13 weeks) = 4.18% investment yield, matching Treasury.gov', () => {
  close(Math.round(discountToInvestmentYield(4.08) * 100) / 100, 4.18, 1e-9);
});

test('zero or negative hold time → no annualized number', () => {
  assert.equal(annualize(0.05, 0), null);
});
