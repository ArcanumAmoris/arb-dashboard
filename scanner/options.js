// Module: Kalshi vs listed options (Stage 2).
// Compares Kalshi threshold contracts with the probability implied by listed options on
// the matching ETF/index, and builds a hedged trade: the Kalshi side that is too
// expensive/cheap + a debit option spread on Robinhood covering the other side.
import { getJson } from './http.js';
import { fillCost, kalshiFee, round6 } from '../docs/lib/math.js';
import { parseOcc, digitalAbove, impliedVolAt, probAbove, pickSpread, simulateUnit, evaluateOptionsTrade } from '../docs/lib/options.js';
import { kalshiEventUrl, kalshiSeriesUrl, spotLinks } from '../docs/lib/links.js';
import { asksFromOrderbook, topOfBook } from './detect.js';

// Each Kalshi underlying and the listed options that track it.
//   ratio: ETF units per 1 unit of what Kalshi settles on (IBIT ≈ 0.000567 BTC → price ratio)
//   margin: how far inside the Kalshi side's paying region the option strikes must sit
//   basisSigma: typical gap between ETF and ratio × underlying at the option expiry
export const UNDERLYINGS = [
  { id: 'BTC', name: 'Bitcoin', series: ['KXBTCD', 'KXBTC', 'KXBTCY'], chain: 'IBIT', roots: ['IBIT'], etf: 'IBIT',
    ref: { kind: 'coinbase', product: 'BTC-USD' }, margin: 0.004, basisSigma: 0.002, settleNote: 'Kalshi: CF Benchmarks BRTI 60-second average. IBIT: its 4pm ET closing price (NAV tracks CF Benchmarks at 4pm). Options are American-style and settle into shares.' },
  { id: 'ETH', name: 'Ethereum', series: ['KXETHD', 'KXETH', 'KXETHY'], chain: 'ETHA', roots: ['ETHA'], etf: 'ETHA',
    ref: { kind: 'coinbase', product: 'ETH-USD' }, margin: 0.005, basisSigma: 0.003, settleNote: 'Kalshi: CF Benchmarks ERTI 60-second average. ETHA: its 4pm ET closing price. Options are American-style and settle into shares.' },
  { id: 'GOLD', name: 'Gold', series: ['KXGOLDD', 'KXGOLDW', 'KXGOLDMON'], chain: 'GLD', roots: ['GLD'], etf: 'GLD',
    ref: { kind: 'goldapi', symbol: 'XAU' }, margin: 0.004, basisSigma: 0.0015, settleNote: 'Kalshi: Pyth gold spot at 5pm ET. GLD: its 4pm ET closing price. Options are American-style and settle into shares.' },
  { id: 'SILVER', name: 'Silver', series: ['KXSILVERD', 'KXSILVERW', 'KXSILVERMON'], chain: 'SLV', roots: ['SLV'], etf: 'SLV',
    ref: { kind: 'goldapi', symbol: 'XAG' }, margin: 0.005, basisSigma: 0.003, settleNote: 'Kalshi: Pyth silver spot at 5pm ET. SLV: its 4pm ET closing price. Options are American-style and settle into shares.' },
  { id: 'SPX', name: 'S&P 500', series: ['KXINX', 'KXINXY'], chain: '_SPX', roots: ['SPXW'], etf: 'SPX', index: true,
    ref: { kind: 'fixed', ratio: 1 }, margin: 0, basisSigma: 0, settleNote: 'Kalshi and SPXW options both settle on the official S&P 500 close. SPX options are European-style and cash-settled: no early assignment, no shares.' },
  { id: 'XSP', name: 'S&P 500 (mini)', series: ['KXINX', 'KXINXY'], chain: '_XSP', roots: ['XSP'], etf: 'XSP', index: true,
    ref: { kind: 'fixed', ratio: 0.1 }, margin: 0, basisSigma: 0, settleNote: 'XSP is 1/10 of the S&P 500, European-style, cash-settled on the close, so smaller trades are possible.' },
  { id: 'NDX', name: 'Nasdaq-100', series: ['KXNASDAQ100'], chain: '_NDX', roots: ['NDXP'], etf: 'NDX', index: true,
    ref: { kind: 'fixed', ratio: 1 }, margin: 0, basisSigma: 0, settleNote: 'Kalshi and NDXP options both settle on the official Nasdaq-100 close. European-style and cash-settled.' },
];

const YEAR_MS = 365.25 * 86400000;

// ---- time helpers (America/New_York) -------------------------------------------
export function nyOffsetMinutes(ms) {
  const d = new Date(ms);
  const ny = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((ny - utc) / 60000);
}
/** UTC ms for a New York wall-clock time on a date like '2026-10-02'. */
export function nyTime(dateStr, hh, mm = 0) {
  const guess = Date.parse(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  return guess - nyOffsetMinutes(guess) * 60000;
}
export function optionsMarketOpen(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const mins = Number(p.hour) % 24 * 60 + Number(p.minute);
  return !['Sat', 'Sun'].includes(p.weekday) && mins >= 570 && mins < 960;
}
/** The moment the ETF price in the delayed chain refers to. */
function etfQuoteTime(now) {
  if (optionsMarketOpen(now)) return now - 15 * 60000;
  // last weekday's 4pm close (holidays are rare; a stale close only widens the ratio error)
  for (let back = 0; back < 7; back++) {
    const ms = now - back * 86400000;
    const ds = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ms));
    const close = nyTime(ds, 16);
    if (!['Sat', 'Sun'].includes(wd) && close <= now) return close;
  }
  return now;
}

// ---- data -------------------------------------------------------------------------
export async function fetchChain(sym) {
  const d = await getJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, { gapMs: 300, retries: 2, timeoutMs: 45000 });
  const byExp = new Map();
  for (const o of d.data.options) {
    const p = parseOcc(o.option);
    if (!p) continue;
    const key = `${p.root}|${p.expiry}`;
    if (!byExp.has(key)) byExp.set(key, { root: p.root, expiry: p.expiry, calls: [], puts: [] });
    const q = { strike: p.strike, bid: o.bid, ask: o.ask, bid_size: o.bid_size, ask_size: o.ask_size, iv: o.iv, oi: o.open_interest, symbol: o.option };
    (p.type === 'C' ? byExp.get(key).calls : byExp.get(key).puts).push(q);
  }
  return { price: d.data.current_price ?? d.data.close, fileTime: d.timestamp, expiries: [...byExp.values()] };
}

async function coinbaseAt(product, ms) {
  const end = new Date(ms + 60000).toISOString(), start = new Date(ms - 5 * 60000).toISOString();
  const c = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${start}&end=${end}`, { gapMs: 150, retries: 2 });
  if (!Array.isArray(c) || !c.length) throw new Error(`no ${product} candle near ${new Date(ms).toISOString()}`);
  c.sort((a, b) => Math.abs(a[0] * 1000 - ms) - Math.abs(b[0] * 1000 - ms));
  return c[0][4]; // close of the nearest minute
}

async function refPrices(u, chain, spot, now) {
  if (u.ref.kind === 'fixed') return { ratio: u.ref.ratio, s0: chain.price / u.ref.ratio, ratioSource: u.index ? 'exact (same index)' : 'fixed' };
  if (u.ref.kind === 'coinbase') {
    const t = etfQuoteTime(now);
    const then = await coinbaseAt(u.ref.product, t);
    const live = spot.crypto.find(r => r.venue === 'Coinbase' && `${r.asset}-USD` === u.ref.product)?.last ?? then;
    return { ratio: chain.price / then, s0: live, moveSinceQuote: live / then - 1,
      ratioSource: `${u.etf} $${chain.price} ÷ ${u.name} $${then.toLocaleString('en-US')} on Coinbase at ${new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })} ET` };
  }
  if (u.ref.kind === 'goldapi') {
    const s = spot.metals.find(r => r.asset === u.ref.symbol)?.last;
    if (!s) throw new Error(`no ${u.name} spot price`);
    return { ratio: chain.price / s, s0: s, ratioSource: `${u.etf} $${chain.price} ÷ ${u.name} spot $${s.toLocaleString('en-US')} (gold-api.com)` };
  }
  throw new Error('unknown reference');
}

// ---- main ---------------------------------------------------------------------------
/**
 * @param events  Kalshi events (with nested markets) already fetched by run.js
 * @param seriesMap Kalshi series metadata (fee multipliers)
 * @param spot    { crypto, metals } rows from sources.js
 */
export async function scanOptions({ events, seriesMap, spot, settings, orderbook, tbill = null, now = Date.now() }) {
  const O = settings.options;
  const V = settings.verdict;
  const out = [], comparisons = [], warnings = [], sources = [];
  const open = optionsMarketOpen(now);
  // Option quotes freeze outside 9:30am–4pm ET while Kalshi and crypto keep moving, so hedged
  // trades built on them would be fake. Outside market hours only price comparisons are made.
  const buildTrades = open || process.env.FORCE_OPTIONS === '1';
  const chains = new Map();

  for (const u of UNDERLYINGS) {
    const evs = events.filter(e => u.series.includes(e.series_ticker) && !(u.index && !/H1600$/.test(e.event_ticker) && e.series_ticker !== 'KXINXY'));
    if (!evs.length) continue;
    let chain;
    try {
      chain = chains.get(u.chain) || await fetchChain(u.chain);
      chains.set(u.chain, chain);
    } catch (e) { warnings.push(`${u.etf} options failed to load (${e.message}); ${u.name} comparisons skipped.`); continue; }
    let ref;
    try { ref = await refPrices(u, chain, spot, now); }
    catch (e) { warnings.push(`${u.name} reference price failed (${e.message}); ${u.name} comparisons skipped.`); continue; }
    sources.push({ etf: u.etf, price: chain.price, fileTime: chain.fileTime, ratio: ref.ratio, ratioSource: ref.ratioSource });

    const expiries = chain.expiries.filter(x => u.roots.includes(x.root))
      .map(x => ({ ...x, time: nyTime(x.expiry, 16) })).filter(x => x.time > now).sort((a, b) => a.time - b.time);
    if (!expiries.length) continue;

    for (const ev of evs) {
      const series = seriesMap.get(ev.series_ticker);
      for (const m of ev.markets || []) {
        if (!['active', 'open'].includes(m.status)) continue;
        const st = m.strike_type;
        const K = Number(st?.startsWith('greater') ? m.floor_strike : m.cap_strike);
        if (!['greater', 'greater_or_equal', 'less', 'less_or_equal'].includes(st) || !Number.isFinite(K)) continue;
        const tK = Date.parse(m.close_time);
        if (!(tK > now + O.minMinutesToSettle * 60000)) continue;
        const yesAbove = st.startsWith('greater');
        const tob = topOfBook(m);
        const X = ref.ratio * K;
        // nearest option expiries on either side of the Kalshi time
        const after = expiries.find(x => x.time >= tK), before = [...expiries].reverse().find(x => x.time < tK && x.time > now + 30 * 60000);
        for (const side of ['YES', 'NO']) {
          const levels = side === 'YES' ? tob.yes : tob.no;
          if (!levels.length) continue;
          const paysAbove = side === 'YES' ? yesAbove : !yesAbove;
          const lossDir = paysAbove ? 'down' : 'up';
          const edge = lossDir === 'up' ? X * (1 - u.margin) : X * (1 + u.margin);
          const kPrice = levels[0].price;
          const kFee1 = kalshiFee(kPrice, 1, { multiplier: series?.fee_multiplier ?? 1, feeType: series?.fee_type ?? 'quadratic', roundTo: V.feeRoundTo }) ?? 0;
          let bestHere = null;
          for (const exp of [before, after].filter(Boolean)) {
            const spread = pickSpread({ calls: exp.calls, puts: exp.puts, lossDir, edge, slip: O.slippagePerShare, fee: O.feePerContract, maxWidthFrac: O.maxWidthFrac });
            if (!spread) continue;
            const perUnit = kPrice + kFee1 + spread.perUnit;
            const tailEdge = 1 - perUnit;
            // "Options say": live price, the options' implied volatility at this strike, Kalshi's clock
            const etfNow = ref.s0 * ref.ratio;
            const ivX = impliedVolAt(exp.calls, exp.puts, X, etfNow);
            const sigma = ivX ?? [spread.buy.iv, spread.sell.iv].filter(v => v > 0.01 && v < 5)[0] ?? 0.5;
            const tauO = (exp.time - now) / YEAR_MS, tauK = (tK - now) / YEAR_MS;
            const pAboveAtK = probAbove(etfNow, X, sigma, tauK);
            const pSide = paysAbove ? pAboveAtK : 1 - pAboveAtK;
            const dig = null;
            const cmp = { ticker: m.ticker, underlying: u.name, etf: u.etf, eventTitle: ev.title, outcome: (m.yes_sub_title || '').replace(/\s+/g, ' ').trim(), side, kalshiPrice: kPrice, kalshiFee: kFee1,
              optionsProb: pSide, ev: pSide - kPrice - kFee1, iv: sigma,
              expiry: exp.expiry, gapHours: (exp.time - tK) / 3600000, tailEdge, url: kalshiEventUrl(ev.series_ticker, ev.event_ticker, series?.title), settles: m.close_time,
              paysAbove, strike: K, hedge: describeSpread(u, exp, spread, ref.ratio), hedgeTotalPerDollar: perUnit };
            comparisons.push(cmp);
            if (!buildTrades || tailEdge < O.minTailEdge || Math.abs(exp.time - tK) > O.maxGapHours * 3600000) continue;
            const sim = simulateUnit({ s0: ref.s0, strikeK: K, kalshiPaysAbove: paysAbove, ratio: ref.ratio, spread, sigma,
              tK: tauK, tO: tauO, basisSigma: u.basisSigma, paths: O.paths, seed: hash(`${m.ticker}${side}${exp.expiry}`) });
            const expUnit = sim.meanPayout - perUnit;
            if (!bestHere || expUnit > bestHere.expUnit) bestHere = { exp, spread, perUnit, tailEdge, sim, sigma, pSide, dig, tauO, tauK, expUnit };
          }
          if (!bestHere) continue;
          out.push(buildOpp({ u, ev, m, series, side, levels, paysAbove, K, X, ref, chain, open, tK, now, settings, ...bestHere }));
        }
      }
    }
  }

  // Keep the best few per Kalshi contract/side, then re-price the Kalshi leg on its full order book.
  out.sort((a, b) => b.perUnit.expected - a.perUnit.expected);
  const seen = new Set(), picked = [];
  for (const o of out) { const key = `${o.kalshi.ticker}|${o.kalshi.side}`; if (seen.has(key)) continue; seen.add(key); picked.push(o); if (picked.length >= O.maxCandidates) break; }
  for (const o of picked) {
    try {
      const ob = asksFromOrderbook(await orderbook(o.kalshi.ticker));
      const lv = o.kalshi.side === 'YES' ? ob.yes : ob.no;
      if (lv.length) { o.kalshi.levels = lv; o.kalshi.bookSource = 'full order book'; }
    } catch (e) { warnings.push(`Order book for ${o.kalshi.ticker} failed: ${e.message}`); }
  }
  const helpers = { fillCost };
  const tb = tbill;
  for (const o of picked) {
    o.eval100 = strip(evaluateOptionsTrade(o, 100, tb, { ...V, optionFeePerContract: O.feePerContract, maxLossChance: O.maxLossChance }, helpers, now));
    o.evalDefault = strip(evaluateOptionsTrade(o, V.defaultAmount, tb, { ...V, optionFeePerContract: O.feePerContract, maxLossChance: O.maxLossChance }, helpers, now));
    const max = evaluateOptionsTrade(o, 1e9, tb, { ...V, optionFeePerContract: O.feePerContract, maxLossChance: O.maxLossChance }, helpers, now);
    o.fillableDollars = max.qty ? max.cost : 0;
    o.fillableSets = max.spreads || 0;
    o.minBudget = o.evalDefault.minBudget ?? null;
    // what the same trade makes with Robinhood's published fees ($0.04 ORF, +$0.50 index option fee)
    const pubFee = O.publishedFeePerContract + (o.underlying.index ? O.publishedIndexFeePerContract : 0);
    const withFees = evaluateOptionsTrade(o, V.defaultAmount, tb, { ...V, optionFeePerContract: pubFee, maxLossChance: O.maxLossChance }, helpers, now);
    o.withPublishedFees = { feePerContract: pubFee, profitExpected: withFees.profitExpected ?? null, tailProfit: withFees.tailProfit ?? null };
    const slip1 = { ...o, spread: { ...o.spread, debit: o.spread.debit + 0.02 } };
    const worseFill = evaluateOptionsTrade(slip1, V.defaultAmount, tb, { ...V, optionFeePerContract: O.feePerContract, maxLossChance: O.maxLossChance }, helpers, now);
    o.worseFills = { centsPerShare: 1, profitExpected: worseFill.profitExpected ?? null };
    o.confidence = confidence(o, open, settings);
  }

  // Single bets: for each Kalshi contract, the side that has positive expected value if the
  // options' pricing is right (nearest option expiry). These CAN lose; they are not hedged.
  const bySide = new Map();
  for (const c of comparisons) {
    const key = `${c.ticker}|${c.side}`;
    if (!bySide.has(key) || Math.abs(bySide.get(key).gapHours) > Math.abs(c.gapHours)) bySide.set(key, c);
  }
  const byTicker = new Map();
  for (const c of bySide.values()) if (!byTicker.has(c.ticker) || c.ev > byTicker.get(c.ticker).ev) byTicker.set(c.ticker, c);
  const topComparisons = [...byTicker.values()]
    .filter(c => c.kalshiPrice >= 0.03 && c.kalshiPrice <= 0.97 && c.optionsProb >= 0.01 && c.optionsProb <= 0.99 && c.ev > 0)
    .sort((a, b) => b.ev - a.ev).slice(0, settings.options.comparisonCount)
    .map(c => ({ ...c, stale: !open }));

  return { opps: picked, comparisons: topComparisons, warnings, sources, optionsMarketOpen: open, tradesBuilt: buildTrades };
}

/** Plain-English description of an option spread, shared by trade cards and the single-bet rows. */
export function describeSpread(u, exp, spread, ratio) {
  const optLabel = `${u.etf} ${fmtDate(exp.expiry)}`;
  const kind = spread.type === 'call' ? 'call' : 'put';
  const zone = spread.type === 'call' ? spread.k2 : spread.k1;
  const approx = u.index ? '' : 'about ';
  return {
    type: spread.type, expiry: exp.expiry, expiryTime: new Date(exp.time).toISOString(), root: exp.root,
    k1: spread.k1, k2: spread.k2, width: spread.width, debit: spread.debit, perUnit: spread.perUnit, maxSpreads: spread.maxSpreads,
    buy: { ...spread.buy, label: `${optLabel} $${fmtK(spread.buy.strike)} ${kind}` },
    sell: { ...spread.sell, label: `${optLabel} $${fmtK(spread.sell.strike)} ${kind}` },
    legs: { buy: `${optLabel} $${fmtK(spread.buy.strike)} ${kind}`, sell: `${optLabel} $${fmtK(spread.sell.strike)} ${kind}` },
    paysWhen: spread.type === 'call' ? `${u.etf} ends at or above $${fmtK(zone)}` : `${u.etf} ends at or below $${fmtK(zone)}`,
    underlyingEquivalent: zone / ratio,
    underlyingZone: `${u.name} ${spread.type === 'call' ? 'at' : 'at'} ${approx}$${fmtK(zone / ratio)} or ${spread.type === 'call' ? 'above' : 'below'}`,
    kalshiPerSpread: Math.round(100 * spread.width),
    robinhoodUrl: u.index ? 'https://robinhood.com/' : spotLinks.robinhoodStock(u.etf),
    robinhoodHow: `${u.index ? `In the Robinhood app, search “${u.etf}”` : `Open ${u.etf} on Robinhood`} → Trade → Trade options → Strategy builder → vertical spread. Pick the ${fmtDate(exp.expiry)} expiration, buy the $${fmtK(spread.buy.strike)} ${kind} and sell the $${fmtK(spread.sell.strike)} ${kind}, set a limit price of about $${spread.debit.toFixed(2)}.`,
  };
}

function buildOpp({ u, ev, m, series, side, levels, paysAbove, K, X, ref, chain, open, tK, now, settings, exp, spread, perUnit, tailEdge, sim, sigma, pSide, dig, tauO, tauK, expUnit }) {
  const outcome = (m.yes_sub_title || m.subtitle || m.ticker).replace(/\s+/g, ' ').trim();
  const kalshiRegion = side === 'YES' ? `“${outcome}”` : `anything except “${outcome}”`;
  const holdUntil = Math.max(tK, exp.time);
  const optLabel = `${u.etf} ${fmtDate(exp.expiry)}`;
  const legs = spread.type === 'call'
    ? { buy: `${optLabel} $${fmtK(spread.buy.strike)} call`, sell: `${optLabel} $${fmtK(spread.sell.strike)} call` }
    : { buy: `${optLabel} $${fmtK(spread.buy.strike)} put`, sell: `${optLabel} $${fmtK(spread.sell.strike)} put` };
  const underlyingK = K;
  return {
    module: 'kalshi-vs-options', type: 'options-hedge', platform: 'Kalshi + Robinhood', asset: u.name.toLowerCase().replace(' (mini)', ''),
    id: `options:${m.ticker}:${side}:${u.etf}:${exp.expiry}:${spread.k1}-${spread.k2}`,
    locked: false, riskLabel: 'Positive expected value, can still lose',
    eventTicker: ev.event_ticker, seriesTicker: ev.series_ticker, eventTitle: ev.title,
    title: `${u.name} “${outcome}”: Kalshi prices it at ${pctTxt(side === 'YES' ? levels[0].price : 1 - levels[0].price)}, options at ${pSide == null ? '?' : pctTxt(side === 'YES' ? pSide : 1 - pSide)}`,
    settleTime: new Date(holdUntil).toISOString(), holdUntil: new Date(holdUntil).toISOString(), closeTime: m.close_time,
    underlying: { id: u.id, name: u.name, etf: u.etf, index: !!u.index, s0: ref.s0, ratio: ref.ratio, ratioSource: ref.ratioSource,
      etfPrice: chain.price, quotesAsOf: chain.fileTime, marketOpen: open, settleNote: u.settleNote, margin: u.margin, basisSigma: u.basisSigma,
      moveSinceQuote: ref.moveSinceQuote ?? null },
    kalshi: {
      platform: 'Kalshi', ticker: m.ticker, side, outcome, strike: underlyingK, paysAbove, region: kalshiRegion,
      name: `${m.title} — ${outcome}`.replace(/\s+/g, ' ').trim(),
      pick: `On the event page, find the row “${outcome}” and press “${side === 'YES' ? 'Yes' : 'No'}”.`,
      levels, bookSource: 'top of book only', feeMultiplier: series?.fee_multiplier ?? 1, feeType: series?.fee_type ?? 'quadratic',
      url: kalshiEventUrl(ev.series_ticker, ev.event_ticker, series?.title), fallbackUrl: kalshiSeriesUrl(ev.series_ticker),
      refTime: m.close_time, volume24h: Number(m.volume_24h_fp) || 0,
    },
    spread: { ...describeSpread(u, exp, spread, ref.ratio), etfStrikeEdge: X },
    gapHours: (exp.time - tK) / 3600000,
    probs: { kalshi: levels[0].price, options: pSide, iv: sigma },
    perUnit: { kalshi: round6(perUnit - spread.perUnit), option: round6(spread.perUnit), total: round6(perUnit), tailEdge: round6(tailEdge), expected: round6(expUnit) },
    unhedged: pSide == null ? null : { evPerContract: round6(pSide - (perUnit - spread.perUnit)), pLose: round6(1 - pSide) },
    sim, assumptions: { sigma, drift: 0, basisSigma: u.basisSigma, margin: u.margin, paths: sim.paths,
      yearsToKalshi: tauK, yearsToExpiry: tauO, model: 'Lognormal price moves from the live price, no drift, volatility = the options’ implied volatility at this strike' },
    logic: `Side 1 pays $1 if the result is ${kalshiRegion}. Side 2 pays $1 per unit when ${spread.type === 'call' ? `${u.etf} is at or above $${fmtK(spread.k2)}` : `${u.etf} is at or below $${fmtK(spread.k1)}`}, which is ${u.name} ${spread.type === 'call' ? 'around' : 'around'} ${fmtK((spread.type === 'call' ? spread.k2 : spread.k1) / ref.ratio)}${u.index ? '' : ' at the current ETF ratio'}. Together they cover every result, with a small overlap where both pay.`,
  };
}

function confidence(o, open, settings) {
  const why = []; let level = 'high';
  const down = (to, r) => { why.push(r); if (to === 'low' || (to === 'medium' && level === 'high')) level = to; };
  if (!open) down('low', 'option prices are from the last close (options trade 9:30am–4pm ET); recheck when the market opens');
  const mv = o.underlying.moveSinceQuote;
  if (mv != null && Math.abs(mv) > 0.003) down('low', `${o.underlying.name} moved ${(mv * 100).toFixed(2)}% since the delayed option quotes; the edge may be the delay, not a mispricing`);
  const gap = Math.abs(o.gapHours);
  if (gap > 48) down('low', `option expiry is ${Math.round(gap / 24)} days ${o.gapHours > 0 ? 'after' : 'before'} Kalshi settles`);
  else if (gap > 2) down('medium', `option expiry is ${gap.toFixed(0)} hours ${o.gapHours > 0 ? 'after' : 'before'} Kalshi settles`);
  if (o.sim.pUnderOne > 0.02) down('low', `${(o.sim.pUnderOne * 100).toFixed(1)}% simulated chance of a loss`);
  else if (o.sim.pUnderOne > 0.005) down('medium', `${(o.sim.pUnderOne * 100).toFixed(1)}% simulated chance of a loss`);
  if (o.kalshi.bookSource !== 'full order book') down('low', 'Kalshi order book not fetched');
  if (o.kalshi.volume24h === 0) down('medium', 'the Kalshi contract had no trades in 24h');
  if ((o.spread.maxSpreads || 0) < 1) down('low', 'option quote shows no size');
  if ((o.perUnit.tailEdge ?? 0) > 0.25) down('medium', 'edge above 25¢ per $1 is too good to be true: likely a stale quote');
  return { level, why };
}

const strip = e => { const { legFills, ...r } = e; return r; };
const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const pctTxt = p => (p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`);
const fmtK = k => (k >= 1000 ? Math.round(k).toLocaleString('en-US') : (Math.round(k * 100) / 100).toString());
const fmtDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
