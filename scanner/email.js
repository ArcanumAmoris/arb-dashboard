// Email formatting + sending via Gmail SMTP (free). Credentials come ONLY from
// environment variables that GitHub Actions fills from repository Secrets:
//   GMAIL_USER          your Gmail address (the sender)
//   GMAIL_APP_PASSWORD  a 16-character Google "app password" (not your normal password)
//   ALERT_TO_EMAIL      where alerts go
// Nothing here is ever written to the repo or the public data branch.
import nodemailer from 'nodemailer';
import { legInstructions, legPays, scenarios, profitSource, optionsSides, optionsScenarios, optionsProfitSource } from '../docs/lib/format.js';

export function mailerConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.ALERT_TO_EMAIL);
}

export async function sendMail({ subject, text, html }) {
  if (!mailerConfigured()) throw new Error('Email secrets missing: set GMAIL_USER, GMAIL_APP_PASSWORD and ALERT_TO_EMAIL in GitHub → Settings → Secrets and variables → Actions');
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
  });
  return t.sendMail({ from: `Arb Scanner <${process.env.GMAIL_USER}>`, to: process.env.ALERT_TO_EMAIL, subject, text, html });
}

const $ = x => (x == null ? 'n/a' : `$${Number(x).toFixed(2)}`);
const pct = (x, d = 2) => (x == null ? 'n/a' : `${Number(x).toFixed(d)}%`);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain-English trade instructions, one line per leg. Same wording as the dashboard. */
export function instructions(opp, ev) {
  return legInstructions(opp, ev).map(l => `${l.text} Cost $${l.cost.toFixed(2)} incl. $${l.fee.toFixed(2)} fees. ${l.how}`);
}

export function formatAlert(items, { dataAgeMin, dashboardUrl, tbill }) {
  const anyTooGood = items.some(x => x.tooGood);
  const subject = `${anyTooGood ? 'VERIFY FIRST — ' : ''}${items.length} new ${items.length === 1 ? 'opportunity' : 'opportunities'}: ` +
    items.map(x => `${x.tierName} ${$(x.ev.opp_profit)}`).join(', ');
  const lines = [], blocks = [];
  if (anyTooGood) lines.push('VERIFY FIRST: likely stale data or a mispriced/illiquid contract.\n');
  lines.push(`Data was ${dataAgeMin} minutes old when this email was sent. Prices may have moved. Verify on the platform before trading.`);
  lines.push(`3-month T-bill: ${pct(tbill)}\n`);
  for (const x of items) {
    const { opp, ev } = x;
    const isOpt = opp.module === 'kalshi-vs-options';
    const src = isOpt ? optionsProfitSource(opp, ev) : profitSource(opp, ev);
    const sides = isOpt
      ? optionsSides(opp, ev).map(sd => ({ text: `${sd.text} Cost $${sd.cost.toFixed(2)}. ${sd.how}`, pays: sd.pays }))
      : instructions(opp, ev).map((t, i) => ({ text: t, pays: legPays(opp.legs[i]) }));
    const backs = isOpt
      ? optionsScenarios(opp, ev).map(r => `If ${r.when.charAt(0).toLowerCase() + r.when.slice(1)}: ${typeof r.total === 'number' ? `$${r.total.toFixed(2)} back (profit $${(r.total - ev.cost).toFixed(2)})` : `$${r.total} back`} (${r.note})`)
      : scenarios(opp).map(r => `If ${r.when.charAt(0).toLowerCase() + r.when.slice(1)}: $${(r.total * ev.qty).toFixed(2)} back (profit $${(r.total * ev.qty - ev.cost).toFixed(2)})`);
    const links = isOpt
      ? [{ url: opp.kalshi.url, label: 'Open on Kalshi' }, { url: opp.spread.robinhoodUrl, label: `Open ${opp.underlying.etf} on Robinhood` }]
      : opp.legs.map(l => l.url).filter((u, i, a) => a.indexOf(u) === i).map(u => ({ url: u, label: 'Open on Kalshi' }));
    const worst = ev.profitWorst;
    const t = [
      `${x.tooGood ? 'VERIFY FIRST: likely stale data or a mispriced/illiquid contract.\n' : ''}${x.tierName} — ${ev.verdict} — ${opp.riskLabel} — confidence ${opp.confidence.level}`,
      opp.title,
      `Where the profit comes from: ${src}`,
      ...sides.map((sd, i) => `  Side ${i + 1}: ${sd.text} (${sd.pays})`),
      'What you get back:',
      ...backs.map(b => `  ${b}`),
      `Total cost: ${$(ev.cost)} (fees ${$(ev.fees)})`,
      `Expected profit: ${$(x.ev.opp_profit)} (${pct(ev.returnPct)} return) — worst case ${$(worst)}, best case ${$(ev.profitBest)}, max loss ${$(ev.maxLoss)}`,
      `Annualized: ${pct(ev.annualizedPct, 1)} vs T-bill ${pct(tbill)} — money tied up about ${ev.days.toFixed(1)} days (settles ${new Date(opp.settleTime).toUTCString()})`,
      `Why it works: ${opp.logic}`,
      `Links: ${links.map(l => `${l.label}: ${l.url}`).join('  ')}`,
    ].join('\n');
    lines.push(t + '\n');
    blocks.push(`<div style="border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0">
      ${x.tooGood ? '<p style="background:#fff3cd;padding:8px;font-weight:700">VERIFY FIRST: likely stale data or a mispriced/illiquid contract.</p>' : ''}
      <p style="margin:0 0 6px"><b>${esc(x.tierName)}</b> · ${esc(ev.verdict)} · ${esc(opp.riskLabel)} · confidence ${esc(opp.confidence.level)}</p>
      <h3 style="margin:4px 0 10px">${esc(opp.title)}</h3>
      <p style="background:#e6f3f0;padding:8px 10px;border-radius:6px"><b>Where the profit comes from:</b> ${esc(src)}</p>
      <ol>${sides.map((sd, i) => `<li><b>Side ${i + 1}:</b> ${esc(sd.text)} <i>(${esc(sd.pays)})</i></li>`).join('')}</ol>
      <p style="margin:6px 0 2px"><b>What you get back:</b></p>
      <ul>${backs.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      <table cellpadding="4" style="font-size:14px">
        <tr><td>Total cost</td><td><b>${$(ev.cost)}</b> (fees ${$(ev.fees)})</td></tr>
        <tr><td>Expected profit</td><td><b>${$(x.ev.opp_profit)}</b> (${pct(ev.returnPct)})</td></tr>
        <tr><td>Worst / best / max loss</td><td>${$(worst)} / ${$(ev.profitBest)} / ${$(ev.maxLoss)}</td></tr>
        <tr><td>Annualized vs T-bill</td><td>${pct(ev.annualizedPct, 1)} vs ${pct(tbill)}</td></tr>
        <tr><td>Money tied up</td><td>~${ev.days.toFixed(1)} days (settles ${esc(new Date(opp.settleTime).toUTCString())})</td></tr>
      </table>
      <p style="font-size:13px;color:#555">${esc(opp.logic)}</p>
      <p>${links.map(l => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(' · ')}</p>
    </div>`);
  }
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
  lines.push('Not financial advice. Prices move fast. Verify on the platform before trading.');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:680px">
    ${anyTooGood ? '<p style="background:#fff3cd;padding:10px;font-weight:700">VERIFY FIRST: likely stale data or a mispriced/illiquid contract.</p>' : ''}
    <p>Data was <b>${dataAgeMin} minutes old</b> when this email was sent. Prices may have moved. Verify on the platform before trading.<br>3-month T-bill: ${pct(tbill)}</p>
    ${blocks.join('')}
    ${dashboardUrl ? `<p><a href="${esc(dashboardUrl)}">Open the dashboard</a></p>` : ''}
    <p style="color:#777;font-size:12px">Not financial advice. Prices move fast. Verify on the platform before trading.</p></div>`;
  return { subject, text: lines.join('\n'), html };
}
