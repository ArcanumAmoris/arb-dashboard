// Main scan: fetch everything, find opportunities, write out/data.json.
// Usage: node scanner/run.js [--out out] [--sample]
import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluate, round6 } from '../docs/lib/math.js';
import { spotLinks } from '../docs/lib/links.js';
import { scanEvent, asksFromOrderbook, topSetCost } from './detect.js';
import * as src from './sources.js';
import { checkLinks } from './linkcheck.js';
import { scanOptions } from './options.js';
import { scanPolymarket } from './polymarket.js';

const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'out';
const settings = JSON.parse(await fs.readFile(new URL('../config/settings.json', import.meta.url), 'utf8'));
const V = settings.verdict, S = settings.scan;

const started = Date.now();
const sources = [];      // status of every data source, shown in the UI
const warnings = [];
const note = (id, name, ok, extra = {}) => sources.push({ id, name, ok, checkedAt: new Date().toISOString(), ...extra });

// ---- risk-free rate ---------------------------------------------------------
let tbill = null;
try {
  tbill = await src.tbillRate();
  note('tbill', '3-month T-bill rate', true, { delay: `Daily, end of day. Latest value dated ${tbill.asOf}`, detail: tbill.source + (tbill.note ? ' — ' + tbill.note : '') });
} catch (e) {
  note('tbill', '3-month T-bill rate (Treasury.gov, FRED backup)', false, { error: e.message });
  if (settings.tbillFallbackPct != null) {
    tbill = { yieldPct: settings.tbillFallbackPct, discountPct: null, asOf: null, source: 'fallback from config (FRED failed)' };
    warnings.push(`T-bill rate unavailable from Treasury.gov and FRED; using the fallback ${settings.tbillFallbackPct}% from config/settings.json.`);
  } else {
    warnings.push('T-bill rate unavailable: no opportunity can be rated WORTH IT this run, because the cash hurdle is unknown.');
  }
}

// ---- spot prices (reference) ------------------------------------------------
const crypto = await src.cryptoSpot();
note('crypto', 'Coinbase / Gemini / Kraken public tickers', crypto.rows.length > 0,
  { delay: 'Real time at scan time (seconds old)', error: crypto.errors.join('; ') || undefined });
const metals = await src.metalsSpot();
note('metals', 'gold-api.com (gold, silver, platinum spot)', metals.rows.length > 0,
  { delay: 'Near real time (updates about every minute); indicative spot, not a tradable quote', error: metals.errors.join('; ') || undefined });
if (crypto.errors.length) warnings.push(`Some crypto prices failed: ${crypto.errors.join('; ')}`);
if (metals.errors.length) warnings.push(`Some metal prices failed: ${metals.errors.join('; ')}`);

// ---- Kalshi -----------------------------------------------------------------
let opps = [], checks = [], stats = { events: 0, markets: 0, pages: 0 }, kalshiOk = false, allEvents = [], seriesMapAll = new Map();
try {
  const seriesMap = await src.kalshiSeriesMap(S.categories, S.requestGapMs);
  const { events, pages } = await src.kalshiOpenEvents({ ...S, gapMs: S.requestGapMs });
  allEvents = events; seriesMapAll = seriesMap;
  stats = { events: events.length, markets: events.reduce((s, e) => s + (e.markets?.length || 0), 0), pages, series: seriesMap.size };
  for (const ev of events) {
    const r = scanEvent(ev, seriesMap.get(ev.series_ticker), { roundTo: V.feeRoundTo });
    opps.push(...r.opps); checks.push(...r.checks);
  }
  kalshiOk = true;
  note('kalshi', 'Kalshi public market data API', true, { delay: 'Real time at scan time; the page then shows how old the scan is' });
} catch (e) {
  note('kalshi', 'Kalshi public market data API', false, { error: e.message });
  warnings.push(`Kalshi data failed (${e.message}). Kalshi opportunities are skipped this run.`);
}

// ---- re-price candidates with FULL order books -------------------------------
opps.sort((a, b) => (topSetCost(a.legs, V.feeRoundTo) - a.minPayoff) - (topSetCost(b.legs, V.feeRoundTo) - b.minPayoff));
const bookCache = new Map();
let fetched = 0;
for (const o of opps) {
  for (const leg of o.legs) {
    if (!bookCache.has(leg.ticker) && fetched < S.maxOrderbookFetches) {
      try { bookCache.set(leg.ticker, asksFromOrderbook(await src.kalshiOrderbook(leg.ticker, S.requestGapMs))); fetched++; }
      catch (e) { bookCache.set(leg.ticker, null); warnings.push(`Order book for ${leg.ticker} failed: ${e.message}`); }
    }
    const b = bookCache.get(leg.ticker);
    if (b) { leg.levels = leg.side === 'YES' ? b.yes : b.no; leg.bookSource = 'full order book'; }
    else leg.bookSource = 'top of book only (full book not fetched)';
  }
}

// ---- evaluate ------------------------------------------------------------------
const now = Date.now();
const tb = tbill?.yieldPct ?? null;
const results = [];
for (const o of opps) {
  const c1 = topSetCost(o.legs, V.feeRoundTo);
  if (c1 == null || c1 >= (o.locked ? o.minPayoff : o.expectedPayoffPerSet)) continue; // gone after full book
  const perSet = { cost: c1, profit: round6((o.locked ? o.minPayoff : o.expectedPayoffPerSet) - c1) };
  const at100 = evaluate(o, 100, tb, V, now);
  const atDefault = evaluate(o, V.defaultAmount, tb, V, now);
  const atMax = evaluate(o, 1e9, tb, V, now);
  o.perSet = perSet;
  o.eval100 = slim(at100); o.evalDefault = slim(atDefault);
  o.fillableDollars = atMax.qty ? round6(atMax.cost) : 0;
  o.fillableSets = atMax.qty || 0;
  o.riskLabel = o.locked ? 'Locked-in arbitrage' : 'Positive expected value, can still lose';
  o.confidence = confidence(o, atDefault, now);
  results.push(o);
}
results.sort((a, b) => (b.evalDefault.profitWorst ?? -1e9) - (a.evalDefault.profitWorst ?? -1e9));

// ---- Stage 2: Kalshi vs listed options -------------------------------------------------
let optionResult = { opps: [], comparisons: [], warnings: [], sources: [], optionsMarketOpen: null }, optionsOk = false;
if (settings.options?.enabled && kalshiOk) {
  try {
    optionResult = await scanOptions({ events: allEvents, seriesMap: seriesMapAll, spot: { crypto: crypto.rows, metals: metals.rows },
      settings, tbill: tb, orderbook: t => src.kalshiOrderbook(t, S.requestGapMs) });
    optionsOk = true;
    warnings.push(...optionResult.warnings);
    note('cboe', 'CBOE delayed option quotes (IBIT, ETHA, GLD, SLV, SPX, XSP, NDX)', optionResult.sources.length > 0,
      { delay: optionResult.optionsMarketOpen ? 'About 15 minutes delayed' : 'Options market closed: prices are from the last close (9:30am–4pm ET trading)',
        detail: optionResult.sources.map(x => `${x.etf} ${x.price}`).join(' · ') });
    results.push(...optionResult.opps);
  } catch (e) {
    note('cboe', 'CBOE delayed option quotes', false, { error: e.message });
    warnings.push(`Kalshi-vs-options module failed (${e.message}); those comparisons are skipped this run.`);
  }
}
// ---- Stage 3: Kalshi vs Polymarket US -------------------------------------------------
let pmResult = { opps: [], warnings: [], sources: [] }, pmOk = false;
if (settings.polymarket?.enabled && kalshiOk) {
  try {
    pmResult = await scanPolymarket({ kalshiEvents: allEvents, seriesMap: seriesMapAll, settings, now,
      kalshiOrderbook: t => src.kalshiOrderbook(t, S.requestGapMs) });
    pmOk = true;
    warnings.push(...pmResult.warnings);
    note('polymarket', 'Polymarket US public market data API (gateway.polymarket.us)', pmResult.sources.length > 0,
      { delay: 'Real time at scan time', detail: pmResult.sources.map(x => `${x.count} crypto markets`).join(' · ') });
    for (const o of pmResult.opps) {
      const c1 = topSetCost(o.legs, V.feeRoundTo);
      if (c1 == null || c1 >= (o.locked ? o.minPayoff : o.expectedPayoffPerSet)) continue; // gone after full book
      o.perSet = { cost: c1, profit: round6((o.locked ? o.minPayoff : o.expectedPayoffPerSet) - c1) };
      const at100 = evaluate(o, 100, tb, V, now);
      const atDefault = evaluate(o, V.defaultAmount, tb, V, now);
      const atMax = evaluate(o, 1e9, tb, V, now);
      o.eval100 = slim(at100); o.evalDefault = slim(atDefault);
      o.fillableDollars = atMax.qty ? round6(atMax.cost) : 0;
      o.fillableSets = atMax.qty || 0;
      o.confidence = confidence(o, atDefault, now);
      results.push(o);
    }
  } catch (e) {
    note('polymarket', 'Polymarket US public market data API', false, { error: e.message });
    warnings.push(`Kalshi-vs-Polymarket module failed (${e.message}); those comparisons are skipped this run.`);
  }
}

const oScore = o => (o.module === 'kalshi-vs-options' ? o.evalDefault.profitExpected : o.evalDefault.profitWorst) ?? -1e9;
results.sort((a, b) => oScore(b) - oScore(a));

// near misses: the closest the market came to an arbitrage (shows the scanner is working)
// (single-contract YES+NO sums are left out: they almost always miss by exactly one tick)
const seenEv = new Set();
// Also skip pairs priced at the extremes (99¢ + 1¢): those always miss by one tick and teach nothing.
const informative = c => (c.legs || []).every(l => l.price == null || (l.price >= 0.03 && l.price <= 0.97));
const nearMisses = checks.filter(c => c.gap >= 0 && c.type !== 'yes-plus-no' && informative(c)).sort((a, b) => a.gap - b.gap)
  .filter(c => !seenEv.has(c.eventTicker) && seenEv.add(c.eventTicker)).slice(0, S.nearMissCount);

// ---- links ---------------------------------------------------------------------
const spot = {
  crypto: crypto.rows.map(r => ({ ...r, url: r.venue === 'Coinbase' ? spotLinks.coinbase(r.asset) : r.venue === 'Gemini' ? spotLinks.gemini(r.asset) : spotLinks.kraken(r.asset),
    robinhood: spotLinks.robinhoodCrypto(r.asset) })),
  metals: metals.rows,
};
let linkCheck;
try { linkCheck = await checkLinks(results, spot); }
catch (e) { linkCheck = { error: e.message }; warnings.push(`Link check failed to run: ${e.message}`); }
for (const o of results) for (const leg of (o.legs || [o.kalshi].filter(Boolean))) {
  if (linkCheck.brokenEvents?.includes(o.eventTicker)) { leg.linkBroken = true; leg.url = leg.fallbackUrl; }
}

// ---- write ---------------------------------------------------------------------
const data = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  scanSeconds: Math.round((Date.now() - started) / 1000),
  stage: 2,
  settings: { verdict: V, staleMinutes: S.staleMinutes, alertsEnabled: settings.alerts.enabled, options: settings.options, polymarket: settings.polymarket },
  tbill, sources, warnings, stats: { ...stats, checks: checks.length, orderbooksFetched: fetched, candidates: opps.length, opportunities: results.length },
  spot, opportunities: results, nearMisses, linkCheck,
  optionComparisons: optionResult.comparisons, optionSources: optionResult.sources, optionsMarketOpen: optionResult.optionsMarketOpen,
  modules: [
    { id: 'kalshi-consistency', name: 'Kalshi bracket / ladder consistency', status: kalshiOk ? 'live' : 'error' },
    { id: 'kalshi-vs-options', name: 'Kalshi vs listed options (Robinhood)', status: optionsOk ? 'live' : settings.options?.enabled ? 'error' : 'off' },
    { id: 'kalshi-vs-polymarket', name: 'Kalshi vs Polymarket US', status: pmOk ? 'live' : settings.polymarket?.enabled ? 'error' : 'off' },
    { id: 'etf-vs-metal', name: 'ETF vs actual metal price', status: 'stage 2' },
    { id: 'crypto-basis', name: 'Crypto futures basis', status: 'stage 3' },
    { id: 'fed-vs-futures', name: 'Fed & economic contracts vs futures', status: 'stage 3' },
    { id: 'cash-hurdle', name: 'Cash-hurdle comparison', status: tbill ? 'live' : 'error' },
  ],
};
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'data.json'), JSON.stringify(data));
console.log(`Scanned ${stats.events} events / ${stats.markets} markets in ${data.scanSeconds}s. ` +
  `${checks.length} checks, ${opps.length} top-of-book candidates, ${results.length} confirmed on full books. ` +
  `T-bill ${tb ?? 'n/a'}%. Warnings: ${warnings.length}`);
for (const w of warnings) console.log(`::warning::${w}`);
if (linkCheck.broken?.length) for (const b of linkCheck.broken) console.log(`::warning::Broken link (404): ${b}`);

// ---------------------------------------------------------------------------------
function slim(e) {
  const { size, legFills, ...rest } = e;
  return { ...rest, legFills: legFills?.map(l => ({ filled: l.filled, cost: l.cost, fee: l.fee, avgPrice: l.avgPrice, worstPrice: l.worstPrice })) };
}

function confidence(o, ev, nowMs) {
  const why = [];
  let level = 'high';
  const down = (to, reason) => { why.push(reason); if (to === 'low' || (to === 'medium' && level === 'high')) level = to; };
  const minsToClose = (Date.parse(o.closeTime) - nowMs) / 60000;
  if ((ev.returnPct ?? 0) > settings.alerts.tooGoodReturnPct) down('medium', `return above ${settings.alerts.tooGoodReturnPct}% is too good to be true: likely a stale or mispriced quote`);
  if (o.legs.some(l => l.bookSource !== 'full order book')) down('low', 'full order book not fetched for every leg');
  if (!o.locked) down('low', 'not a locked-in trade: depends on outcomes being exhaustive');
  if (minsToClose < 30) down('low', `trading closes in ${Math.max(0, Math.round(minsToClose))} min`);
  else if (minsToClose < 180) down('medium', `trading closes in ${Math.round(minsToClose / 60 * 10) / 10} h`);
  if (o.strikeTick > 0.01) down('medium', `assumes results are reported in steps of ${o.strikeTick}`);
  if (o.legs.some(l => l.volume24h === 0)) down('medium', 'a leg had no trades in the last 24h (quotes may be sitting unattended)');
  if (o.legs.some(l => l.openInterest === 0 && l.volume24h === 0)) down('low', 'a leg has never traded');
  if ((o.fillableDollars ?? 0) < settings.alerts.minFillDollars) down('medium', `only $${(o.fillableDollars ?? 0).toFixed(2)} fillable at profitable prices`);
  return { level, why };
}
