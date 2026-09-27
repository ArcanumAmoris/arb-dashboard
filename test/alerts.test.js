// Alert rules: tiers, dedupe, fill minimum, too-good-to-be-true guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickAlerts } from '../scanner/alertRules.js';

const settings = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url)));
const NOW = Date.parse('2026-10-01T00:00:00Z');

function opp(id, price, days, extra = {}) {
  return { id, title: id, locked: true, minPayoff: 1, maxPayoff: 1, bonusProb: 0, riskLabel: 'Locked-in arbitrage',
    settleTime: new Date(NOW + days * 86400e3).toISOString(), confidence: { level: 'high', why: [] }, fillableDollars: 5000,
    legs: [{ levels: [{ price, size: 100000 }], feeMultiplier: 0, feeType: 'quadratic' }], ...extra };
}
const data = opps => ({ tbill: { yieldPct: 4.18 }, opportunities: opps });

test('Tier 1: 5% locked in 30 days (~61%/yr) alerts', () => {
  const { picked } = pickAlerts(data([opp('a', 0.95, 30)]), {}, settings, '2026-10-01', NOW);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].tier, 1);
});

test('Tier 1: 2% locked over 3 months (~8%/yr) is below the 12%/yr bar → no alert', () => {
  const { picked } = pickAlerts(data([opp('b', 0.98, 91.25)]), {}, settings, '2026-10-01', NOW);
  assert.equal(picked.length, 0);
});

test('low confidence never alerts', () => {
  const { picked } = pickAlerts(data([opp('c', 0.9, 30, { confidence: { level: 'low', why: [] } })]), {}, settings, '2026-10-01', NOW);
  assert.equal(picked.length, 0);
});

test('less than $100 fillable never alerts', () => {
  const { picked } = pickAlerts(data([opp('d', 0.9, 30, { fillableDollars: 60 })]), {}, settings, '2026-10-01', NOW);
  assert.equal(picked.length, 0);
});

test('dedupe: same opportunity is not re-sent unless profit improves by more than 25%', () => {
  const first = pickAlerts(data([opp('e', 0.95, 30)]), {}, settings, '2026-10-01', NOW).picked[0];
  const sent = { sent: { e: { profit: first.ev.opp_profit, at: new Date(NOW).toISOString() } } };
  assert.equal(pickAlerts(data([opp('e', 0.95, 30)]), sent, settings, '2026-10-01', NOW).picked.length, 0);
  // price drops from 95¢ to 93¢: profit on $500 goes from ~$26 to ~$37 (+42%) → re-alert
  assert.equal(pickAlerts(data([opp('e', 0.93, 30)]), sent, settings, '2026-10-01', NOW).picked.length, 1);
});

test('too-good guard: a 40% locked return is still sent, flagged VERIFY FIRST', () => {
  const { picked } = pickAlerts(data([opp('f', 0.70, 30, { confidence: { level: 'medium', why: [] } })]), {}, settings, '2026-10-01', NOW);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].tooGood, true);
});
