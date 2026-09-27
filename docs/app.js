// Dashboard: loads data.json from the `data` branch, re-scores every opportunity
// for YOUR amount and thresholds, and renders cards. Read-only: it never logs in anywhere.
import { evaluate, kalshiFee } from './lib/math.js';
import { tip, escapeHtml as h } from './lib/glossary.js';
import { money, pct, cents, legInstructions, daysText, TYPE_NAMES } from './lib/format.js';
import { initChrome, store, copyText } from './lib/ui.js';

const REFRESH_MS = 10 * 60 * 1000;
const $ = sel => document.querySelector(sel);

const S = {
  data: null, error: null, nextAt: Date.now() + REFRESH_MS, liveSpot: null,
  amount: store.get('amount', null),
  th: store.get('thresholds', null),
  filters: store.get('filters', { module: '', asset: '', platform: '', verdict: '', risk: '' }),
  showNot: store.get('showNot', false),
};

// ---------------------------------------------------------------------------
function dataUrl() {
  if (window.ARB_CONFIG?.dataUrl) return window.ARB_CONFIG.dataUrl;
  const { hostname, pathname } = location;
  if (hostname.endsWith('.github.io')) {
    const owner = hostname.split('.')[0];
    const repo = pathname.split('/').filter(Boolean)[0] || `${owner}.github.io`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/data/data.json`;
  }
  return 'data.json';
}

async function load() {
  S.nextAt = Infinity; // stops the countdown from re-triggering while this request runs
  $('#refresh-btn').disabled = true;
  try {
    if (window.ARB_EMBEDDED_DATA) S.data = window.ARB_EMBEDDED_DATA;
    else {
      const r = await fetch(`${dataUrl()}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No data published yet. Run the “Scan” workflow once (see SETUP.md).' : `HTTP ${r.status}`);
      S.data = await r.json();
    }
    S.error = null;
    if (S.amount == null) S.amount = S.data.settings.verdict.defaultAmount;
    if (!S.th) S.th = pickTh(S.data.settings.verdict);
  } catch (e) {
    S.error = e.message;
  }
  S.nextAt = Date.now() + REFRESH_MS;
  $('#refresh-btn').disabled = false;
  renderAll();
  liveSpot();
}

const pickTh = v => ({ minProfit: v.minProfit, minReturnPct: v.minReturnPct, lockedMarginPct: v.lockedMarginPct, evMarginPct: v.evMarginPct });

// ---------------------------------------------------------------------------
function ageMin() { return S.data ? (Date.now() - Date.parse(S.data.generatedAt)) / 60000 : null; }
function isStale() { const a = ageMin(); return a != null && a > (S.data.settings.staleMinutes ?? 25); }

function tick() {
  const a = ageMin();
  const box = $('#age');
  if (a != null) {
    const m = Math.floor(a);
    box.querySelector('.big').textContent = m < 1 ? '< 1 min' : m < 120 ? `${m} min` : `${(a / 60).toFixed(1)} h`;
    box.className = 'age ' + (a <= 12 ? 'fresh' : a <= (S.data.settings.staleMinutes ?? 25) ? 'aging' : 'old');
  }
  const left = Math.max(0, S.nextAt - Date.now());
  $('#countdown').textContent = Number.isFinite(left)
    ? `Next refresh in ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
    : 'Refreshing…';
  const wasStale = !$('#stale').hidden;
  $('#stale').hidden = !isStale();
  if (wasStale !== isStale()) renderCards();
  if (left <= 0) load();
}

// ---------------------------------------------------------------------------
function settings() {
  const v = S.data.settings.verdict;
  return { ...v, ...S.th };
}

function scored() {
  const set = settings(), tb = S.data.tbill?.yieldPct ?? null;
  return S.data.opportunities.map(o => ({ o, e: evaluate(o, S.amount, tb, set), e100: evaluate(o, 100, tb, set) }));
}

function renderAll() {
  if (S.error && !S.data) {
    $('#main').innerHTML = `<div class="notice bad"><b>Couldn't load data.</b> ${h(S.error)}<br><span class="small">Looking for: <code>${h(dataUrl())}</code></span></div>`;
    return;
  }
  renderControls();
  renderSummary();
  renderNotices();
  renderCards();
  renderNearMisses();
  renderSpot();
  renderSources();
}

function renderSummary() {
  const d = S.data, list = scored();
  const worth = list.filter(x => x.e.verdict === 'WORTH IT');
  const best = list.map(x => (x.o.locked ? x.e.profitWorst : x.e.profitExpected) ?? -Infinity).reduce((a, b) => Math.max(a, b), -Infinity);
  $('#sum-worth .big').textContent = worth.length;
  $('#sum-worth .sub').textContent = `of ${list.length} found · ${d.stats.checks.toLocaleString()} checks on ${d.stats.markets.toLocaleString()} markets`;
  $('#sum-best .big').textContent = Number.isFinite(best) ? money(best) : '—';
  $('#sum-best .sub').textContent = `after fees, on ${money(S.amount, 0)}`;
  $('#sum-tbill .big').textContent = d.tbill ? pct(d.tbill.yieldPct) : 'n/a';
  $('#sum-tbill .sub').textContent = d.tbill ? `3-month bill, ${d.tbill.asOf ?? ''}` : 'unavailable: nothing can be WORTH IT';
  $('#scan-time').textContent = `Scanned ${new Date(d.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  tick();
}

function renderNotices() {
  const d = S.data, out = [];
  if (S.error) out.push(`<div class="notice bad">Latest refresh failed (${h(S.error)}). Showing the previous data.</div>`);
  for (const w of d.warnings || []) out.push(`<div class="notice warn">${h(w)}</div>`);
  if (d.linkCheck?.broken?.length) out.push(`<div class="notice warn">Link check flagged ${d.linkCheck.broken.length} broken link(s): ${h(d.linkCheck.broken.join('; '))}. Affected buttons fall back to the series page.</div>`);
  $('#notices').innerHTML = out.join('');
}

// ---------------------------------------------------------------------------
function renderControls() {
  const d = S.data, opps = d.opportunities;
  const uniq = f => [...new Set(opps.map(f).filter(Boolean))].sort();
  const opt = (id, vals, lab) => {
    const el = $(id), cur = S.filters[el.dataset.key];
    el.innerHTML = `<option value="">All</option>` + vals.map(v => `<option value="${h(v)}"${v === cur ? ' selected' : ''}>${h(lab ? lab(v) : v)}</option>`).join('');
  };
  opt('#f-module', uniq(o => o.module), v => ({ 'kalshi-consistency': 'Kalshi bracket / ladder' }[v] || v));
  opt('#f-asset', uniq(o => o.asset));
  opt('#f-platform', uniq(o => o.platform));
  opt('#f-verdict', ['WORTH IT', 'MARGINAL', 'NOT WORTH IT']);
  opt('#f-risk', uniq(o => o.riskLabel));
  $('#amount').value = S.amount;
  $('#th-profit').value = S.th.minProfit;
  $('#th-return').value = S.th.minReturnPct;
  $('#th-margin').value = S.th.lockedMarginPct;
  $('#show-not').checked = S.showNot;
}

function bindControls() {
  $('#amount').addEventListener('input', e => { const v = +e.target.value; if (v > 0) { S.amount = v; store.set('amount', v); renderSummary(); renderCards(); } });
  const th = (id, key) => $(id).addEventListener('input', e => { const v = +e.target.value; if (Number.isFinite(v)) { S.th[key] = v; store.set('thresholds', S.th); renderSummary(); renderCards(); } });
  th('#th-profit', 'minProfit'); th('#th-return', 'minReturnPct'); th('#th-margin', 'lockedMarginPct');
  $('#th-reset').addEventListener('click', () => { S.th = pickTh(S.data.settings.verdict); store.set('thresholds', null); renderControls(); renderSummary(); renderCards(); });
  for (const id of ['#f-module', '#f-asset', '#f-platform', '#f-verdict', '#f-risk']) {
    $(id).addEventListener('change', e => { S.filters[e.target.dataset.key] = e.target.value; store.set('filters', S.filters); renderCards(); });
  }
  $('#show-not').addEventListener('change', e => { S.showNot = e.target.checked; store.set('showNot', S.showNot); renderCards(); });
  $('#refresh-btn').addEventListener('click', load);
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.dataset.copy, b);
  });
}

// ---------------------------------------------------------------------------
function renderCards() {
  if (!S.data) return;
  const f = S.filters, stale = isStale();
  const list = scored().filter(({ o, e }) =>
    (!f.module || o.module === f.module) && (!f.asset || o.asset === f.asset) && (!f.platform || o.platform === f.platform) &&
    (!f.risk || o.riskLabel === f.risk) && (!f.verdict || e.verdict === f.verdict) &&
    (S.showNot || f.verdict === 'NOT WORTH IT' || e.verdict !== 'NOT WORTH IT'));
  const order = { 'WORTH IT': 0, 'MARGINAL': 1, 'NOT WORTH IT': 2 };
  list.sort((a, b) => order[a.e.verdict] - order[b.e.verdict] || (b.e.profitWorst ?? -1e9) - (a.e.profitWorst ?? -1e9));
  const hidden = scored().filter(x => x.e.verdict === 'NOT WORTH IT').length;
  $('#cards-count').textContent = `${list.length} shown${!S.showNot && hidden ? ` · ${hidden} NOT WORTH IT hidden` : ''}`;
  $('#cards').innerHTML = list.length ? list.map(x => card(x, stale)).join('') :
    `<div class="empty"><h3>Nothing to act on right now</h3><p class="muted">That's the normal state: markets are usually priced consistently, and real arbitrage is rare. ` +
    `${hidden && !S.showNot ? `${hidden} opportunit${hidden === 1 ? 'y was' : 'ies were'} found but didn't pass your thresholds. Tick “Show NOT WORTH IT” to see ${hidden === 1 ? 'it' : 'them'}. ` : ''}` +
    `The “Closest calls” table below shows how near the market came.</p></div>`;
}

function card({ o, e, e100 }, stale) {
  const vcls = { 'WORTH IT': 'worth', 'MARGINAL': 'marginal', 'NOT WORTH IT': 'not' }[e.verdict];
  const profit = o.locked ? e.profitWorst : e.profitExpected;
  const tb = S.data.tbill?.yieldPct;
  const legs = e.qty ? legInstructions(o, e) : [];
  const winProb = o.locked ? '100% (profits in every outcome)' : '—';
  const bonus = o.locked && o.maxPayoff > o.minPayoff ? `${pct(o.bonusProb * 100, 0)} chance of the extra ${money((o.maxPayoff - o.minPayoff) * e.qty)} (market-implied)` : null;
  const perSet = o.perSet ? `${money(o.perSet.profit, 3)} profit on ${money(o.perSet.cost, 3)}` : '—';
  const per100 = e100.qty ? `${money(o.locked ? e100.profitWorst : e100.profitExpected)} (${e100.qty} sets)` : 'can\'t fill $100';
  const liquidity = e.depthLimited
    ? `Order books only have ${e.maxDepth.toLocaleString()} profitable sets, so the size is cut to ${e.qty} sets (${money(e.cost)}) instead of your ${money(S.amount, 0)}.`
    : `Enough depth: ${e.qty} sets fill at the prices shown. Profitable depth tops out around ${money(o.fillableDollars)}.`;
  const settle = new Date(o.settleTime);
  return `<article class="card v-${vcls}${stale ? ' stale-card' : ''}">
    <div class="chips">
      <span class="chip verdict ${vcls}">${e.verdict}</span>
      <span class="chip ${o.locked ? 'locked' : ''}">${tip(o.locked ? 'locked-in arbitrage' : 'positive expected value', h(o.riskLabel))}</span>
      <span class="chip">${h(o.asset)}</span>
      <span class="chip">${tip('confidence', `confidence: ${h(o.confidence.level)}`)}</span>
      ${stale ? '<span class="chip gone">may no longer exist</span>' : ''}
    </div>
    <div>
      <div class="label">${h(TYPE_NAMES[o.type] || o.type)} · ${h(o.platform)}</div>
      <h3>${h(o.title)}</h3>
      <p class="small muted" style="margin:4px 0 0">${h(e.verdictWhy)}</p>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="label">${o.locked ? tip('worst case', 'Profit (worst case)') : 'Expected profit'}</span><span class="v ${profit > 0 ? 'pos' : 'neg'}">${money(profit)}</span></div>
      <div class="kpi"><span class="label">Return</span><span class="v">${pct(e.returnPct)}</span></div>
      <div class="kpi"><span class="label">${tip('annualized return', 'Per year')}</span><span class="v">${pct(e.annualizedPct, 1)}</span><span class="small muted">vs ${tip('t-bill rate', `T-bill ${pct(tb)}`)}</span></div>
    </div>
    ${e.qty ? whatToBuy(o, e, legs) : `<div class="notice warn">Can't build a trade at this amount.</div>`}
    <dl class="stats">
      <dt>Total cost</dt><dd><b>${money(e.cost)}</b> incl. ${money(e.fees)} fees</dd>
      <dt>Win probability</dt><dd>${winProb}</dd>
      ${bonus ? `<dt>Upside</dt><dd>${bonus}</dd>` : ''}
      <dt>Best / worst case</dt><dd>${money(e.profitBest)} / ${money(e.profitWorst)}</dd>
      <dt>${tip('max loss', 'Max loss')}</dt><dd>${money(e.maxLoss)}${o.locked ? ' (market risk only; see note)' : ''}</dd>
      ${o.locked && o.maxPayoff > o.minPayoff ? `<dt>Expected profit</dt><dd>${money(e.profitExpected)}</dd>` : ''}
      <dt>Per contract set</dt><dd>${perSet}</dd>
      <dt>Per $100</dt><dd>${per100}</dd>
      <dt>${tip('order book depth', 'Liquidity')}</dt><dd>${h(liquidity)}</dd>
      <dt>${tip('settlement', 'Settles')}</dt><dd>${settle.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · money tied up ${daysText(e.days)}</dd>
      <dt>Confidence</dt><dd>${h(o.confidence.level)}${o.confidence.why.length ? ` — ${h(o.confidence.why.join('; '))}` : ''}</dd>
    </dl>
    <p class="fine" style="margin:0">Prices were pulled ${Math.round(ageMin())} min ago and may have moved. Kalshi doesn't allow live re-checks from a browser, so open the contract and confirm the ask before buying. ${o.locked ? 'Buy the legs quickly: until every leg is filled you are exposed. “Locked” still carries platform and rule risk.' : ''}</p>
    <details><summary>Show me the math</summary><div class="math">${h(mathText(o, e))}</div>
      <p class="small" style="margin:8px 0 0">${h(o.logic)}</p></details>
  </article>`;
}

function whatToBuy(o, e, legs) {
  const urls = [...new Map(o.legs.map(l => [l.url, l])).values()];
  const open = urls.map(l => `<a class="btn small" href="${h(l.url)}" target="_blank" rel="noopener">Open on ${h(l.platform)} ↗</a>`).join(' ');
  const copyBtn = l => `<button type="button" class="btn small ghost" data-copy="${h(`${l.leg.side} — ${l.leg.name} (${l.leg.ticker})`)}">Copy</button>`;
  if (legs.length <= 3) {
    return `<div><div class="label" style="margin-bottom:6px">What to buy</div><ol class="steps">${legs.map(l => `
      <li><b>${h(l.text)}</b> <span class="muted">Total ${money(l.cost)} incl. ${money(l.fee)} ${tip('fees', 'fees')}.</span>
        <div class="small muted">${h(l.how)}</div>
        <div class="leg-actions"><a class="btn small" href="${h(l.leg.url)}" target="_blank" rel="noopener">Open on ${h(l.leg.platform)} ↗</a>${copyBtn(l).replace('>Copy<', '>Copy contract name<')}</div></li>`).join('')}</ol></div>`;
  }
  const sides = [...new Set(o.legs.map(l => l.side))].join(' / ');
  const title = o.legs[0].name.split(' — ')[0];
  return `<div><div class="label" style="margin-bottom:6px">What to buy</div>
    <p style="margin:0 0 8px"><b>Buy ${e.qty} ${h(sides)} contracts on each of these ${legs.length} rows of “${h(title)}” on ${h(o.platform)}.</b>
    <span class="muted">Total ${money(e.cost)} incl. ${money(e.fees)} ${tip('fees', 'fees')}. On the event page, press “${sides === 'NO' ? 'No' : 'Yes'}” on each row.</span></p>
    <div class="leg-actions" style="margin:0 0 8px">${open}</div>
    <div class="table-wrap"><table class="legs"><thead><tr><th>Row on the event page</th><th>Side</th><th class="n">Price</th><th class="n">Cost</th><th></th></tr></thead><tbody>${
      legs.map((l, i) => { const f = e.legFills[i]; const px = f.worstPrice != null && Math.abs(f.worstPrice - f.avgPrice) > 1e-9 ? `up to ${cents(f.worstPrice)}` : cents(f.avgPrice);
        return `<tr><td>${h(l.leg.sideLabel || l.leg.ticker)}</td><td>${h(l.leg.side)}</td><td class="n mono">${px}</td><td class="n mono">${money(l.cost)}</td><td>${copyBtn(l)}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

function mathText(o, e) {
  const set = settings();
  const lines = [];
  lines.push(`Fee per fill = round up( ${'M'} × 0.07 × contracts × price × (1 − price) ) to $${set.feeRoundTo}`);
  lines.push('');
  o.legs.forEach((leg, i) => {
    lines.push(`Leg ${i + 1}: BUY ${e.qty} × ${leg.side}  ${leg.ticker}   (fee multiplier M = ${leg.feeMultiplier})`);
    let rem = e.qty;
    for (const l of leg.levels) {
      if (rem <= 0) break;
      const take = Math.min(rem, l.size);
      const fee = kalshiFee(l.price, take, { multiplier: leg.feeMultiplier, feeType: leg.feeType, roundTo: set.feeRoundTo });
      lines.push(`   ${String(+take.toFixed(2)).padStart(7)} @ ${cents(l.price).padEnd(6)} = ${money(take * l.price).padStart(9)}   fee ${money(fee, 4)}`);
      rem -= take;
    }
    const f = e.legFills[i];
    lines.push(`   leg total ${money(f.cost + f.fee)}`);
  });
  lines.push('');
  lines.push(`Total cost          ${money(e.cost)}  (fees ${money(e.fees)})`);
  lines.push(`Guaranteed payout   ${e.qty} sets × $${o.minPayoff} = ${money(e.worstPayout)}`);
  if (o.maxPayoff > o.minPayoff) lines.push(`Best-case payout    ${e.qty} sets × $${o.maxPayoff} = ${money(e.bestPayout)}`);
  lines.push(`Worst-case profit   ${money(e.worstPayout)} − ${money(e.cost)} = ${money(e.profitWorst)}`);
  const p = o.locked ? e.profitWorst : e.profitExpected;
  lines.push(`Return              ${money(p)} ÷ ${money(e.cost)} = ${pct(e.returnPct, 3)}`);
  lines.push(`Hold time           ${e.days.toFixed(2)} days (minimum counted: ${set.minHoldDays})`);
  lines.push(`Annualized          ${pct(e.returnPct, 3)} × 365 ÷ ${e.days.toFixed(2)} = ${pct(e.annualizedPct, 2)}`);
  lines.push(`Cash hurdle         T-bill ${pct(e.tbillPct)} + margin ${pct(o.locked ? set.lockedMarginPct : set.evMarginPct, 1)} = ${pct(e.hurdlePct)}`);
  lines.push(`Your thresholds     profit ≥ $${set.minProfit}, return ≥ ${set.minReturnPct}%, annualized ≥ hurdle`);
  lines.push(`Verdict             ${e.verdict}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
function renderNearMisses() {
  const rows = S.data.nearMisses || [];
  $('#near').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Event</th><th>Check</th><th class="n">Cost of one set incl. fees</th><th class="n">Guaranteed payout</th><th class="n">Missed by</th></tr></thead><tbody>${
    rows.map(r => `<tr><td><a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.eventTitle)}</a><div class="small muted">${h(r.asset)}</div></td>
      <td>${h(TYPE_NAMES[r.type] || r.type)}</td><td class="n mono">${money(r.cost, 4)}</td><td class="n mono">${money(r.payoff, 0)}</td>
      <td class="n mono">${(r.gap * 100).toFixed(2)}¢</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No data.</p>';
}

function renderSpot() {
  const d = S.data, live = S.liveSpot;
  const rows = [];
  const byKey = new Map();
  for (const r of d.spot.crypto) byKey.set(`${r.asset}|${r.venue}`, { ...r, src: 'scan' });
  for (const r of d.spot.metals) byKey.set(`${r.asset}|${r.venue}`, { ...r, src: 'scan' });
  if (live) for (const r of live) byKey.set(`${r.asset}|${r.venue}`, { ...byKey.get(`${r.asset}|${r.venue}`), ...r, src: 'live' });
  for (const r of byKey.values()) rows.push(r);
  const note = { Kraken: ' (price reference only: Kraken does not serve New York residents)' };
  $('#spot').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Venue</th><th class="n">Bid</th><th class="n">Ask</th><th class="n">Last</th><th>As of</th></tr></thead><tbody>${
    rows.map(r => `<tr><td><b>${h(r.name)}</b> <span class="muted mono">${h(r.asset)}</span></td>
      <td>${r.url ? `<a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.venue)}</a>` : h(r.venue)}${note[r.venue] ? `<div class="small muted">${h(note[r.venue])}</div>` : ''}</td>
      <td class="n mono">${r.bid ? fmtPx(r.bid) : '—'}</td><td class="n mono">${r.ask ? fmtPx(r.ask) : '—'}</td><td class="n mono">${fmtPx(r.last)}</td>
      <td class="small"><span class="dot ${r.src === 'live' ? 'live' : ''}"></span>${r.src === 'live' ? 'live, from your browser' : 'from the scan'}</td></tr>`).join('')}</tbody></table></div>`;
}
const fmtPx = x => (x == null ? '—' : x >= 100 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x.toLocaleString('en-US', { maximumFractionDigits: 5 }));

// These public APIs allow browser requests (CORS), so reference prices refresh live.
async function liveSpot() {
  if (!S.data || window.ARB_NO_LIVE) return;
  const out = [];
  const j = async u => (await fetch(u, { cache: 'no-store' })).json();
  const jobs = [];
  for (const r of S.data.spot.crypto) {
    if (r.venue === 'Coinbase') jobs.push(j(`https://api.exchange.coinbase.com/products/${r.asset}-USD/ticker`).then(d => out.push({ asset: r.asset, venue: 'Coinbase', bid: +d.bid, ask: +d.ask, last: +d.price })));
    if (r.venue === 'Gemini') jobs.push(j(`https://api.gemini.com/v1/pubticker/${r.asset.toLowerCase()}usd`).then(d => out.push({ asset: r.asset, venue: 'Gemini', bid: +d.bid, ask: +d.ask, last: +d.last })));
  }
  for (const r of S.data.spot.metals) jobs.push(j(`https://api.gold-api.com/price/${r.asset}`).then(d => out.push({ asset: r.asset, venue: 'gold-api.com', last: +d.price })));
  await Promise.allSettled(jobs);
  if (out.length) { S.liveSpot = out; renderSpot(); }
}

function renderSources() {
  const d = S.data;
  const rows = d.sources.map(s => `<tr><td><span class="dot ${s.ok ? 'ok' : 'err'}"></span>${h(s.name)}</td><td>${s.ok ? 'OK' : `<b>Failed:</b> ${h(s.error)}`}</td><td class="small">${h(s.delay || '')}${s.detail ? `<div class="muted">${h(s.detail)}</div>` : ''}</td></tr>`);
  rows.push(`<tr><td><span class="dot live"></span>Browser live prices (Coinbase, Gemini, gold-api)</td><td>${S.liveSpot ? 'OK' : 'not loaded'}</td><td class="small">Refreshed each time this page reloads data. Kalshi blocks browser requests, so Kalshi quotes only come from the scan.</td></tr>`);
  const lc = d.linkCheck || {};
  $('#sources').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Delay</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="small muted">Link check at scan time: ${lc.ok ?? 0} OK, ${lc.broken?.length ?? 0} broken, ${lc.unverifiable?.length ?? 0} unverifiable because the site blocks automated checks${lc.canary404Detected ? '; the checker proved it can detect a 404' : ''}.
    Modules: ${d.modules.map(m => `${h(m.name)} <b>(${h(m.status)})</b>`).join(' · ')}.</p>`;
}

// ---------------------------------------------------------------------------
initChrome();
if (window.matchMedia('(max-width: 900px)').matches) document.getElementById('filters-box').open = false;
bindControls();
load();
setInterval(tick, 1000);
