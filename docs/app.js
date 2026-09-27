// Dashboard: loads data.json from the `data` branch, re-scores every opportunity
// for YOUR amount and thresholds, and renders cards. Read-only: it never logs in anywhere.
import { evaluate, fillCost } from './lib/math.js';
import { evaluateOptionsTrade } from './lib/options.js';
import { escapeHtml as h } from './lib/glossary.js';
import { money, pct, cents, legInstructions, TYPE_NAMES, legPays } from './lib/format.js';
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

const isOpt = o => o.module === 'kalshi-vs-options';
function evalFor(o, amount) {
  const set = settings(), tb = S.data.tbill?.yieldPct ?? null;
  if (isOpt(o)) {
    const O = S.data.settings.options || {};
    return evaluateOptionsTrade(o, amount, tb, { ...set, optionFeePerContract: O.feePerContract ?? 0, maxLossChance: O.maxLossChance }, { fillCost });
  }
  return evaluate(o, amount, tb, set);
}
const headline = (o, e) => ((o.locked ? e.profitWorst : e.profitExpected) ?? -Infinity);
function scored() {
  return S.data.opportunities.map(o => ({ o, e: evalFor(o, S.amount), e100: evalFor(o, 100) }));
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
  renderOptionBets();
  renderSpot();
  renderSources();
}

function renderSummary() {
  const d = S.data, list = scored();
  const worth = list.filter(x => x.e.verdict === 'WORTH IT');
  const best = list.filter(x => x.e.qty).map(x => headline(x.o, x.e)).reduce((a, b) => Math.max(a, b), -Infinity);
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
  opt('#f-module', uniq(o => o.module), v => ({ 'kalshi-consistency': 'Kalshi bracket / ladder', 'kalshi-vs-options': 'Kalshi vs options' }[v] || v));
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
  list.sort((a, b) => order[a.e.verdict] - order[b.e.verdict] || headline(b.o, b.e) - headline(a.o, a.e));
  const hidden = scored().filter(x => x.e.verdict === 'NOT WORTH IT').length;
  $('#cards-count').textContent = `${list.length} shown${!S.showNot && hidden ? ` · ${hidden} NOT WORTH IT hidden` : ''}`;
  $('#cards').innerHTML = list.length ? list.map(x => card(x, stale)).join('') :
    `<div class="empty"><h3>Nothing to act on right now</h3><p class="muted">That's the normal state: markets are usually priced consistently, and real arbitrage is rare. ` +
    `${hidden && !S.showNot ? `${hidden} opportunit${hidden === 1 ? 'y was' : 'ies were'} found but didn't pass your thresholds. Tick “Show NOT WORTH IT” to see ${hidden === 1 ? 'it' : 'them'}. ` : ''}` +
    `The “Closest calls” table below shows how near the market came.</p></div>`;
}

const VERDICT_LABEL = { 'WORTH IT': 'Worth it', 'MARGINAL': 'Marginal', 'NOT WORTH IT': 'Not worth it' };
const VCLS = { 'WORTH IT': 'worth', 'MARGINAL': 'marginal', 'NOT WORTH IT': 'not' };

/** Normalizes either trade type into the boxes the minimal card renders: N legs, a cost, a profit figure. */
function legBoxesFor(o, e) {
  if (!e.qty) return [];
  if (isOpt(o)) {
    const k = o.kalshi, s = o.spread;
    return [
      { side: k.side, cls: k.side === 'YES' ? 'yes' : 'no', name: k.name, qtyText: `${e.qty.toLocaleString()} contracts`, cost: e.kalshiCost + e.kalshiFee, url: k.url, platform: 'Kalshi' },
      { side: s.type === 'call' ? 'CALL SPREAD' : 'PUT SPREAD', cls: 'spread', name: `${s.legs.buy} / ${s.legs.sell}`, qtyText: `${e.spreads} spread${e.spreads === 1 ? '' : 's'}`, cost: e.optionCost, url: s.robinhoodUrl, platform: 'Robinhood' },
    ];
  }
  return legInstructions(o, e).map(l => ({ side: l.leg.side, cls: l.leg.side === 'YES' ? 'yes' : 'no', name: l.leg.name, qtyText: `${e.qty.toLocaleString()} contracts`, cost: l.cost, url: l.leg.url, platform: l.leg.platform }));
}

function cardMeta(o, e) {
  const opt = isOpt(o);
  const subtype = opt ? `Kalshi vs ${o.underlying.etf} options`
    : o.module === 'kalshi-polymarket' ? `Kalshi vs Polymarket US — ${TYPE_NAMES[o.type] || o.type}`
    : (TYPE_NAMES[o.type] || o.type);
  const settle = new Date(opt ? o.holdUntil : o.settleTime);
  let profit, hasFloor;
  if (opt) { profit = e.qty ? e.tailProfit : null; hasFloor = false; }
  else { profit = e.qty ? (o.locked ? e.profitWorst : e.profitExpected) : null; hasFloor = o.locked && o.maxPayoff > o.minPayoff && o.bonusProb >= 0.01; }
  const riskWhy = `${e.verdictWhy} ${o.riskLabel}. Confidence: ${o.confidence.level}${o.confidence.why.length ? ` (${o.confidence.why.join('; ')})` : ''}.`;
  return { subtype, settle, profit, hasFloor, riskWhy, locked: !!o.locked && !opt };
}

function card({ o, e, e100 }, stale) {
  const vcls = VCLS[e.verdict];
  const m = cardMeta(o, e);
  const boxes = legBoxesFor(o, e);
  const expiry = m.settle.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  return `<details class="ocard${stale ? ' stale-card' : ''}">
    <summary class="ocard-head">
      <span class="ocard-chev">▸</span>
      <div class="ocard-left">
        <div class="ocard-title">${h(o.title)}</div>
        <div class="ocard-sub">${h(m.subtype)} · <b class="ocard-expiry mono">${h(expiry)}</b></div>
        <span class="vpill ${vcls}">${VERDICT_LABEL[e.verdict]}${stale ? ' · may no longer exist' : ''}<button type="button" class="tip" aria-label="Why this verdict" data-tip="${h(m.riskWhy)}">?</button></span>
      </div>
      <div class="ocard-right">
        <div class="ocard-apy mono">${e.annualizedPct == null ? '—' : pct(e.annualizedPct, 1)}</div>
        <div class="ocard-apy-label">per yr, if held</div>
      </div>
    </summary>
    <div class="ocard-body">
      ${boxes.length ? `<div class="ocard-legs">${boxes.map(b => `
        <div class="legbox">
          <div class="legbox-top"><span class="side-bet ${b.cls}">${h(b.side)}</span><span class="small muted">${h(b.qtyText)}</span></div>
          <div class="legbox-name">${h(b.name)}</div>
          <div class="legbox-cost mono">${money(b.cost)}</div>
        </div>`).join('')}</div>` : `<div class="notice warn">Can't build a trade at ${money(S.amount, 0)}.</div>`}
      ${boxes.length ? `<div class="ocard-stats">
        <div><span class="label">Total cost</span><span class="v mono">${money(e.cost)}</span></div>
        <div><span class="label">Profit</span><span class="v mono pos">${money(m.profit)}${m.hasFloor ? '+' : ''}</span></div>
      </div>
      <div class="ocard-links">${[...new Map(boxes.map(b => [b.url, b])).values()].map(b => `<a class="btn small" href="${h(b.url)}" target="_blank" rel="noopener">Open on ${h(b.platform)} ↗</a>`).join('')}</div>` : ''}
    </div>
  </details>`;
}

// ---------------------------------------------------------------------------
function renderNearMisses() {
  const rows = S.data.nearMisses || [];
  const legLine = l => `<li>Buy <b>${h(l.side)}</b> on “${h(l.outcome)}” at ${cents(l.price)} → ${h(legPays(l))}</li>`;
  $('#near').innerHTML = rows.length ? `<p class="small muted" style="margin:0 0 8px">Each row is a pair (or set) of contracts that <i>would</i> guarantee a payout. It only becomes free money when the combined cost including fees drops below that payout. Open a row to see both sides.</p>
    <div class="table-wrap"><table><thead><tr><th>Event and the two sides</th><th class="n">Cost incl. fees</th><th class="n">Guaranteed back</th><th class="n">Short by</th></tr></thead><tbody>${
    rows.map(r => `<tr><td><a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.eventTitle)}</a> <span class="small muted">· ${h(r.asset)} · ${h(TYPE_NAMES[r.type] || r.type)}</span>
      ${r.legs ? `<details><summary class="small">Show the ${r.legCount > 2 ? `${r.legCount} legs` : 'two sides'}</summary><ul class="near-legs">${r.legs.map(legLine).join('')}${r.legCount > r.legs.length ? `<li class="muted">…and ${r.legCount - r.legs.length} more</li>` : ''}</ul>
        <p class="small muted" style="margin:4px 0 0">Together they cost ${money(r.cost, 4)} and always pay back at least ${money(r.payoff, 0)}, so you'd <b>lose ${(r.gap * 100).toFixed(2)}¢</b> per set. Not a trade.</p></details>` : ''}</td>
      <td class="n mono">${money(r.cost, 4)}</td><td class="n mono">${money(r.payoff, 0)}</td>
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

function renderOptionBets() {
  const box = document.getElementById('option-bets');
  if (!box) return;
  const d = S.data, rows = d.optionComparisons || [];
  const closed = d.optionsMarketOpen === false;
  if (!rows.length) { box.innerHTML = '<p class="muted">No disagreements with a positive edge this scan.</p>'; return; }
  const fmtDay = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const pctx = p => (p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`);
  box.innerHTML = `${closed ? `<div class="notice warn"><b>Options market closed.</b> Option prices below are from the last close (options trade 9:30am–4pm ET, weekdays), so they may be different when you trade. Check the live price in Robinhood first. Kalshi prices are live.</div>` : ''}
    <div class="bets">${rows.map(r => {
      const yesK = r.side === 'YES' ? r.kalshiPrice : 1 - r.kalshiPrice;
      const yesO = r.side === 'YES' ? r.optionsProb : 1 - r.optionsProb;
      const wins = r.side === 'YES' ? `the result is “${r.outcome}”` : `the result is NOT “${r.outcome}”`;
      const hg = r.hedge;
      const hedgeTotal = r.hedgeTotalPerDollar;
      const hedgeEdge = hg ? 1 - hedgeTotal : null;
      const n = hg ? hg.kalshiPerSpread : 100;
      const gap = Math.abs(r.gapHours);
      const gapH = Math.round(gap), gapD = Math.round(gap / 24);
      const gapTxt = gap < 1 ? 'the same time' : gap < 48 ? `${gapH} ${gapH === 1 ? 'hour' : 'hours'} ${r.gapHours > 0 ? 'after' : 'before'} Kalshi settles` : `${gapD} ${gapD === 1 ? 'day' : 'days'} ${r.gapHours > 0 ? 'after' : 'before'} Kalshi settles`;
      const hedged = hg && hedgeEdge > 0;              // a real locked-in hedge is available and worth using
      const edge = hedged ? hedgeEdge : r.ev;            // ¢ per $1, the number the badge is judged on
      const verdict = edge >= 0.03 ? { l: 'WORTH IT', c: 'worth' } : edge >= 0.01 ? { l: 'MARGINAL', c: 'marginal' } : { l: 'NOT WORTH IT', c: 'not' };
      const typeTag = hedged ? { l: 'ARB · hedged', c: 'locked' } : { l: 'Unhedged bet', c: '' };
      return `<details class="bet">
        <summary class="bet-head">
          <div class="bet-title"><span class="bet-name">${h(r.eventTitle)}</span><span class="small muted">“${h(r.outcome)}” · settles ${h(fmtDay(r.settles))}</span></div>
          <div class="bet-sum">
            <span class="chip verdict ${verdict.c}">${verdict.l}</span>
            <span class="chip ${typeTag.c}">${typeTag.l}</span>
            <span class="bet-probs"><span>Kalshi <b>${pctx(yesK)}</b></span><span>Options <b>${pctx(yesO)}</b></span></span>
            <span class="bet-edge ${edge > 0 ? 'pos' : ''}">${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}¢/$1</span>
          </div>
        </summary>
        <div class="bet-body">
          <ol class="bet-steps">
            <li><span class="step-tag">Step 1 · Kalshi</span>
              <div>Buy <span class="side-bet ${r.side === 'YES' ? 'yes' : 'no'}">${h(r.side)}</span> at <b>${(r.kalshiPrice * 100).toFixed(1)}¢</b>. Wins $1 if ${h(wins)}.</div>
              <div class="leg-actions"><a class="btn small" href="${h(r.url)}" target="_blank" rel="noopener">Open on Kalshi ↗</a></div></li>
            ${hg ? `<li><span class="step-tag">Step 2 · Robinhood (insurance, optional)</span>
              <div><b>Buy</b> ${h(hg.buy.label)} at ${cents(hg.buy.price)} and <b>sell</b> ${h(hg.sell.label)} at ${cents(hg.sell.price)}.
                Net cost <b>${cents(hg.debit)} per share = $${(hg.debit * 100).toFixed(2)} per spread</b>.</div>
              <div class="small muted">Pays $${(hg.width * 100).toFixed(0)} per spread if ${h(hg.paysWhen)} (${h(hg.underlyingZone)}), the case where Step 1 loses. Use 1 spread for every ${n} Kalshi contracts. Expires ${h(gapTxt)}.</div>
              <div class="leg-actions"><a class="btn small" href="${h(hg.robinhoodUrl)}" target="_blank" rel="noopener">Open ${h(r.etf)} on Robinhood ↗</a>
                <button type="button" class="btn small ghost" data-copy="${h(`Buy ${hg.buy.label}, sell ${hg.sell.label}, limit $${hg.debit.toFixed(2)} debit`)}">Copy option order</button></div></li>` : ''}
          </ol>
          <div class="bet-result">
            <div class="bet-verdict-line">${hedged
              ? `<b>Do both:</b> the hedge locks this in whichever way it goes.`
              : `<b>Kalshi bet only</b> — the hedge below costs more than it's worth here, so skip it (or skip the trade).`}</div>
            <div><b>Kalshi alone:</b> +${(r.ev * 100).toFixed(1)}¢ expected per contract if the options are right, but loses ${(r.kalshiPrice * 100).toFixed(1)}¢ about ${pctx(1 - r.optionsProb)} of the time. For ${n} contracts: ${money(r.ev * n)} expected, ${money(r.kalshiPrice * n)} at risk.</div>
            ${hg ? (hedgeEdge > 0
              ? `<div class="pos"><b>Plus the Robinhood hedge:</b> <b>+${(hedgeEdge * 100).toFixed(1)}¢ per $1</b> locked in whichever way it goes (${money(hedgeEdge * n)} on ${n} contracts + 1 spread)${gap >= 1 ? `, except for the small timing risk because the options expire ${h(gapTxt)}` : ''}.</div>`
              : `<div class="muted"><b>Plus the Robinhood hedge:</b> costs ${(hedgeTotal * 100).toFixed(1)}¢ per $1 of payout — more than the $1 it pays back, so it's not worth adding here.</div>`) : ''}
          </div>
        </div>
      </details>`; }).join('')}</div>
    <p class="small muted" style="margin:8px 0 0">Be skeptical when one asset shows edges in the same direction at every strike: that usually means the reference price differs from Kalshi's feed (gold and silver settle on Pyth, crypto on CF Benchmarks), not free money.</p>`;
}
