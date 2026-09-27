// Decide which opportunities deserve an email, dedupe, cap per day, send ONE combined email.
// Usage: node scanner/alerts.js [--data out/data.json] [--prev prev/state/alerts.json] [--out out/state/alerts.json] [--dry-run]
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatAlert, sendMail, mailerConfigured } from './email.js';
import { pickAlerts } from './alertRules.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DATA = arg('--data', 'out/data.json');
const PREV = arg('--prev', 'prev/state/alerts.json');
const OUT = arg('--out', 'out/state/alerts.json');
const DRY = process.argv.includes('--dry-run');

const settings = JSON.parse(await fs.readFile(new URL('../config/settings.json', import.meta.url), 'utf8'));
const A = settings.alerts, V = settings.verdict;
const data = JSON.parse(await fs.readFile(DATA, 'utf8'));
let state = { sent: {}, daily: {} };
try { state = { sent: {}, daily: {}, ...JSON.parse(await fs.readFile(PREV, 'utf8')) }; } catch { /* first run */ }

const today = new Intl.DateTimeFormat('en-CA', { timeZone: A.timezone }).format(new Date());
const { picked, log } = pickAlerts(data, state, settings, today);

await fs.mkdir(path.dirname(OUT), { recursive: true });
if (!A.enabled) {
  console.log('Alerts are switched off in config/settings.json (alerts.enabled = false).');
} else if (!picked.length) {
  console.log('No new alert-worthy opportunities this run.');
} else if ((state.daily[today] ?? 0) >= A.maxEmailsPerDay) {
  console.log(`::warning::${picked.length} alert-worthy opportunities found, but the daily cap of ${A.maxEmailsPerDay} emails is reached.`);
} else if (DRY || !mailerConfigured()) {
  console.log(`${DRY ? 'Dry run' : '::warning::Email secrets not set'}: would email ${picked.length} opportunities:`);
  for (const p of picked) console.log(`  ${p.tierName}: ${p.opp.title} — $${p.ev.opp_profit.toFixed(2)}`);
} else {
  const dataAgeMin = Math.round((Date.now() - Date.parse(data.generatedAt)) / 60000);
  const mail = formatAlert(picked, { dataAgeMin, dashboardUrl: process.env.DASHBOARD_URL, tbill: data.tbill?.yieldPct });
  await sendMail(mail);
  state.daily[today] = (state.daily[today] ?? 0) + 1;
  for (const p of picked) state.sent[p.opp.id] = { profit: p.ev.opp_profit, at: new Date().toISOString(), tier: p.tier };
  console.log(`Sent 1 email with ${picked.length} opportunities.`);
}
for (const l of log) console.log(l);

// keep the state file small
const cutoff = Date.now() - 30 * 86400000;
for (const [id, v] of Object.entries(state.sent)) if (Date.parse(v.at) < cutoff) delete state.sent[id];
for (const d of Object.keys(state.daily)) if (d < new Date(cutoff).toISOString().slice(0, 10)) delete state.daily[d];
await fs.writeFile(OUT, JSON.stringify(state, null, 1));

