// Module: Kalshi vs Polymarket US bracket/ladder consistency.
//
// Polymarket US (polymarket.us, operated by QCX LLC) is a CFTC-regulated Designated
// Contract Market — a different legal entity from the offshore polymarket.com and not
// subject to the geoblocking that keeps NY residents off it. Its public retail API
// (gateway.polymarket.us, no key needed) lists the same kind of year-end BTC/ETH price
// brackets Kalshi does.
//
// The check we run is exactly the "ladder mispricing" logic scanner/detect.js already
// runs *within* Kalshi (part b of scanEvent): if outcome interval B is a strict subset of
// interval A, then owning YES on A + NO on B always returns at least $1 (and $2 if the
// result lands in A but not B), because every outcome in B is also in A. We reuse
// isSubset()/marketInterval()'s interval shape from docs/lib/math.js unchanged — the only
// new code is building the same {lo, loIn, hi, hiIn} shape from Polymarket's bracket titles,
// and pricing a Polymarket leg. Everything downstream (evaluate(), card rendering, alerts)
// is the same opportunity object detect.js produces, just with legs from two platforms.
//
// Settlement verification (required before ANY cross-venue pairing counts as locked, per
// the same caution the Kalshi-vs-options module applies): Polymarket states its settlement
// methodology in plain English on every market's `description` field — we treat that as the
// contract's rulebook text and diff it against Kalshi's documented methodology for the
// matching series (KALSHI_SETTLEMENT below, sourced from Kalshi's public series endpoint and
// contract terms). If the index family or the averaging method (plain vs trimmed mean)
// don't provably match, the pairing is basis risk — can lose — never a locked trade.
import { getJson } from './http.js';
import { kalshiFee, isSubset, round6, fillCost, depthOf } from '../docs/lib/math.js';
import { kalshiEventUrl } from '../docs/lib/links.js';

export const PM_BASE = 'https://gateway.polymarket.us/v1';
export const PM_TAKER_COEFFICIENT = 0.0695; // Polymarket US published taker fee: fee = Θ × C × p × (1-p)

// Kalshi's own documented settlement methodology per asset (from its public series endpoint's
// settlement_sources + published contract terms). Compared against Polymarket's live per-market
// description to decide whether a pairing can ever be treated as locked.
export const KALSHI_SETTLEMENT = {
  BTC: { index: /\bBRTI\b|bitcoin real-?time index/i, trimmed: false, // Kalshi: CF Benchmarks BRTI, a straight average — no documented trimming
    note: 'Kalshi settles BTC contracts on CF Benchmarks’ BRTI as a straight (untrimmed) average.' },
  ETH: { index: /\bERTI\b|ethereum real-?time index/i, trimmed: false,
    note: 'Kalshi settles ETH contracts on CF Benchmarks’ ERTI as a straight (untrimmed) average.' },
};

// Which Kalshi series to pair against which Polymarket crypto-market family. Only the
// YEAR-END series belong here (KXBTCY/KXETHY) — Polymarket's brackets in pmSlugPrefix are
// year-end brackets too, and the daily series (KXBTCD/KXETHD) settle on a completely
// different date, so pairing them would compare two unrelated events, not a mispricing.
// (An earlier version of this list included the daily series and produced exactly that
// bug: an Oct-2 Kalshi contract "priced against" a Dec-31 Polymarket one. The timestamp
// gap check below is a second, independent guard against the same mistake.)
export const PM_ASSETS = [
  { id: 'BTC', name: 'Bitcoin', kalshiSeries: ['KXBTCY'], pmSlugPrefix: 'cpc-btc-pricerange-yr' },
  { id: 'ETH', name: 'Ethereum', kalshiSeries: ['KXETHY'], pmSlugPrefix: 'cpc-eth-pricerange-yr' },
];

// How far apart two platforms' settlement instants may sit and still be treated as "the
// same event" at all. Beyond this, we don't even record it as a basis-risk pairing — it's
// simply not a comparison of the same underlying question.
export const MAX_SETTLEMENT_GAP_HOURS_TO_PAIR = 72;
// Within this much tighter window, a pairing whose index+method already match can be
// called genuinely locked. Outside it (but inside the pairing window above), the prices
// can still diverge in the gap, so it's basis risk even with matching methodology.
export const SETTLEMENT_GAP_HOURS_FOR_LOCK = 3;

/** Best-effort parse of a plain-English settlement instant out of Polymarket's own
 *  contract text, e.g. "...over the sixty second period ending at 4:00pm ET on December
 *  31, 2026...". Returns epoch ms, or null if the text doesn't state one this plainly.
 *  ET is treated as a fixed UTC-5 (EST); real DST doesn't matter here since every BTC/ETH
 *  year-end bracket settles in winter (EST, not EDT). */
export function parsePmSettlementInstant(description = '') {
  const m = String(description).match(/(\d{1,2}):(\d{2})\s*(am|pm)\s*ET\s*(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
  if (!m) return null;
  const [, hh, mm, ap, dateStr] = m;
  let h = Number(hh) % 12;
  if (/pm/i.test(ap)) h += 12;
  const t = Date.parse(`${dateStr.replace(',', '')} ${String(h).padStart(2, '0')}:${mm}:00 GMT-0500`);
  return Number.isFinite(t) ? t : null;
}

/** Hours between Polymarket's stated settlement instant and a Kalshi ISO timestamp
 *  (its expected_expiration_time/close_time). Null if Polymarket's text doesn't state
 *  a parseable instant — callers should treat null as "can't verify, don't pair." */
export function settlementGapHours(pmDescription, kalshiIso) {
  const pmT = parsePmSettlementInstant(pmDescription);
  const kT = Date.parse(kalshiIso);
  if (pmT == null || !Number.isFinite(kT)) return null;
  return Math.abs(kT - pmT) / 3.6e6;
}

// ---- Polymarket US public retail API (gateway.polymarket.us; no auth) --------------------
export async function fetchPmMarkets({ categories = 'crypto', limit = 500, active = true, closed = false } = {}) {
  const out = [];
  for (let offset = 0; ; offset += limit) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), active: String(active), closed: String(closed), categories });
    const d = await getJson(`${PM_BASE}/markets?${qs}`, { gapMs: 200, retries: 2, timeoutMs: 20000 });
    const page = d.markets || [];
    out.push(...page);
    if (page.length < limit || offset > 4500) break; // sanity cap: this module only needs a few hundred crypto markets
  }
  return out;
}

export async function fetchPmBook(slug) {
  const d = await getJson(`${PM_BASE}/markets/${slug}/book`, { gapMs: 150, retries: 2, timeoutMs: 15000 });
  const md = d.marketData || {};
  const lv = arr => (arr || []).map(l => ({ price: Number(l.px?.value), size: Number(l.qty) }))
    .filter(l => Number.isFinite(l.price) && l.price > 0 && l.price < 1 && l.size > 0).sort((a, b) => a.price - b.price);
  const yesAsks = lv(md.offers), yesBids = lv(md.bids);
  // Same complementary-pricing convention Kalshi uses (detect.js asksFromOrderbook): a resting
  // bid on YES at price p is equivalent to a resting ask on NO at price 1-p, and vice versa.
  const round = x => Math.round(x * 1e6) / 1e6;
  const noAsks = yesBids.map(l => ({ price: round(1 - l.price), size: l.size })).filter(l => l.price > 0 && l.price < 1).sort((a, b) => a.price - b.price);
  return { yes: yesAsks, no: noAsks, state: md.state };
}

// ---- bracket parsing --------------------------------------------------------------------
const num = s => Number(String(s).replace(/,/g, ''));

/** Parse Polymarket's "145,000 to 149,999.99" / "150,000 or above" / "19,999.99 or below"
 *  bracket titles into the same {lo, loIn, hi, hiIn} interval shape marketInterval() returns
 *  for Kalshi, so isSubset() works unmodified on either side. */
export function pmInterval(titleShort) {
  const t = (titleShort || '').trim();
  let m;
  if ((m = t.match(/^([\d,.]+)\s+or\s+above$/i))) return { lo: num(m[1]), loIn: true, hi: Infinity, hiIn: false };
  if ((m = t.match(/^([\d,.]+)\s+or\s+below$/i))) return { lo: -Infinity, loIn: false, hi: num(m[1]), hiIn: true };
  if ((m = t.match(/^([\d,.]+)\s+to\s+([\d,.]+)$/i))) return { lo: num(m[1]), loIn: true, hi: num(m[2]), hiIn: true };
  return null;
}

/** Diff Polymarket's own (per-market, plain-English) settlement text against Kalshi's
 *  documented methodology for the same asset. Returns {verified, note} — verified is only
 *  true when both the index family and the averaging method provably match; anything short
 *  of that is basis risk, never a locked pairing. */
export function settlementCheck(assetId, pmDescription = '') {
  const k = KALSHI_SETTLEMENT[assetId];
  if (!k) return { verified: false, note: 'No documented Kalshi settlement methodology on file for this asset.' };
  const sameIndex = k.index.test(pmDescription);
  const pmTrimmed = /trim/i.test(pmDescription);
  if (!sameIndex) return { verified: false, note: `Polymarket's own contract text doesn't confirm the same index family (expected ${k.index}). ${k.note}` };
  if (pmTrimmed !== k.trimmed) {
    return { verified: false, note: `Same index family, but Polymarket's contract text ${pmTrimmed ? 'describes a trimmed mean' : "doesn't mention trimming"} while ${k.note.toLowerCase()} Different averaging methods can disagree by real money near a close call — basis risk, not a lock.` };
  }
  return { verified: true, note: `Both platforms settle on the same index (${assetId === 'BTC' ? 'BRTI' : 'ERTI'}) with the same averaging method, per Polymarket's contract text and Kalshi's published settlement source.` };
}

// ---- leg builders (same shape legFrom() in detect.js builds, so every downstream
//      function — evaluate(), the card renderer, alert emails — needs no special-casing) ---
function kalshiLeg(m, series, side, levels) {
  return {
    platform: 'Kalshi', ticker: m.ticker, side,
    name: `${m.title} — ${m.yes_sub_title || m.subtitle || m.ticker}`.replace(/\s+/g, ' ').trim(),
    pick: `On the event page, find the row “${m.yes_sub_title || m.subtitle || m.ticker}” and press “${side === 'YES' ? 'Yes' : 'No'}”.`,
    outcome: (m.yes_sub_title || m.subtitle || m.ticker || '').replace(/\s+/g, ' ').trim(),
    levels, feeMultiplier: series?.fee_multiplier ?? 1, feeType: series?.fee_type ?? 'quadratic',
    url: kalshiEventUrl(m.series_ticker || series?.ticker, m.event_ticker, series?.title),
    settleTime: m.expected_expiration_time || m.close_time, closeTime: m.close_time,
    volume24h: Number(m.volume_24h_fp) || 0,
  };
}
function pmLeg(pm, side, levels) {
  // Polymarket's fee is Θ×C×p×(1-p) — the same shape as Kalshi's M×0.07×C×p×(1-p), just a
  // different combined coefficient. Folding Θ into an equivalent "M" lets us reuse Kalshi's
  // own fee/fillCost math (docs/lib/math.js) unchanged instead of forking a parallel copy —
  // fillCost({multiplier, feeType:'quadratic'}) then computes M×0.07×... = Θ×... exactly.
  // Polymarket's docs don't state a rounding rule; we round up like Kalshi does, which is
  // conservative (never understates cost).
  const feeCoefficient = Number(pm.market.feeCoefficient) || PM_TAKER_COEFFICIENT;
  return {
    platform: 'Polymarket US', ticker: pm.market.slug, side,
    name: `${pm.market.question} — ${pm.market.titleShort}`.replace(/\s+/g, ' ').trim(),
    pick: `On the market page, press “${side === 'YES' ? 'Yes' : 'No'}”.`,
    outcome: pm.market.titleShort,
    levels, feeMultiplier: feeCoefficient / 0.07, feeType: 'quadratic',
    url: `https://polymarket.us/event/${pm.market.slug}`,
    settleTime: pm.market.endDate, closeTime: pm.market.endDate,
    volume24h: 0,
  };
}

function finish(opp) {
  const settle = opp.legs.map(l => Date.parse(l.settleTime)).filter(Number.isFinite);
  opp.settleTime = new Date(Math.max(...settle)).toISOString();
  opp.closeTime = new Date(Math.min(...opp.legs.map(l => Date.parse(l.closeTime)).filter(Number.isFinite))).toISOString();
  opp.id = `pm:${opp.legs.map(l => `${l.platform}:${l.ticker}:${l.side}`).sort().join('+')}`;
  return opp;
}

function oneFee(price, leg, roundTo) { return kalshiFee(price, 1, { multiplier: leg.feeMultiplier, feeType: leg.feeType, roundTo }); }
function topSetCost(legs, roundTo) {
  let t = 0;
  for (const l of legs) { if (!l.levels.length) return null; const f = oneFee(l.levels[0].price, l, roundTo); if (f === null) return null; t += l.levels[0].price + f; }
  return round6(t);
}

// ---- main ---------------------------------------------------------------------------------
/**
 * @param kalshiEvents  Kalshi events (with nested markets) already fetched by run.js
 * @param seriesMap     Kalshi series metadata (fee multipliers), from run.js
 * @param kalshiOrderbook(ticker) -> full Kalshi order book, used to reprice picked candidates
 */
export async function scanPolymarket({ kalshiEvents, seriesMap, kalshiOrderbook, settings, now = Date.now() }) {
  const V = settings.verdict;
  const warnings = [], opps = [], checks = [], sources = [];
  let pmMarkets;
  try { pmMarkets = await fetchPmMarkets({ categories: 'crypto' }); }
  catch (e) { return { opps: [], warnings: [`Polymarket US markets list failed to load (${e.message}); Polymarket comparisons skipped.`], checks: [], sources: [] }; }
  sources.push({ platform: 'Polymarket US', count: pmMarkets.length, fetchedAt: new Date().toISOString() });

  for (const asset of PM_ASSETS) {
    const pmRows = pmMarkets.filter(m => m.slug.startsWith(asset.pmSlugPrefix) && m.status === 'MARKET_STATUS_OPEN');
    if (!pmRows.length) continue;
    const pmBrackets = pmRows.map(m => ({ market: m, iv: pmInterval(m.titleShort || m.title) })).filter(x => x.iv);
    const pmDescription = pmBrackets[0]?.market.description || '';
    const methodMatch = settlementCheck(asset.id, pmDescription);

    const kEvents = kalshiEvents.filter(e => asset.kalshiSeries.includes(e.series_ticker));
    for (const ev of kEvents) {
      const series = seriesMap.get(ev.series_ticker);
      for (const m of ev.markets || []) {
        if (!['active', 'open'].includes(m.status)) continue;
        const st = m.strike_type;
        if (!['greater', 'greater_or_equal', 'less', 'less_or_equal', 'between'].includes(st)) continue;
        // Same-settlement-timestamp check (required before ANY pairing, per the same
        // caution the Kalshi-vs-options module applies to settlement-source mismatches):
        // if the two platforms' contracts don't settle at close to the same instant,
        // they aren't pricing the same question at all, so skip the market entirely
        // rather than record it as even a basis-risk pairing.
        const kSettleIso = m.expected_expiration_time || m.close_time;
        const gapHours = settlementGapHours(pmDescription, kSettleIso);
        if (gapHours == null || gapHours > MAX_SETTLEMENT_GAP_HOURS_TO_PAIR) continue;
        const settle = {
          verified: methodMatch.verified && gapHours <= SETTLEMENT_GAP_HOURS_FOR_LOCK,
          note: methodMatch.verified
            ? (gapHours <= SETTLEMENT_GAP_HOURS_FOR_LOCK
                ? methodMatch.note
                : `${methodMatch.note} But the two platforms' settlement instants are about ${gapHours.toFixed(1)} hours apart, so the price can still move between them — basis risk, not a lock.`)
            : `${methodMatch.note} (Settlement instants are about ${gapHours.toFixed(1)} hours apart.)`,
        };
        const f = m.floor_strike != null && m.floor_strike !== '' ? Number(m.floor_strike) : null;
        const c = m.cap_strike != null && m.cap_strike !== '' ? Number(m.cap_strike) : null;
        const kIv = st === 'greater' ? (f == null ? null : { lo: f, loIn: false, hi: Infinity, hiIn: false })
          : st === 'greater_or_equal' ? (f == null ? null : { lo: f, loIn: true, hi: Infinity, hiIn: false })
          : st === 'less' ? (c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: false })
          : st === 'less_or_equal' ? (c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: true })
          : (f == null || c == null ? null : { lo: f, loIn: true, hi: c, hiIn: true });
        if (!kIv) continue;
        const yesAsk = Number(m.yes_ask_dollars), yesAskSize = Number(m.yes_ask_size_fp) || 0;
        const noAsk = Number(m.no_ask_dollars), noAskSize = Number(m.yes_bid_size_fp) || 0;
        const kYes = yesAsk > 0 && yesAsk < 1 && yesAskSize >= 1 ? [{ price: yesAsk, size: yesAskSize }] : [];
        const kNo = noAsk > 0 && noAsk < 1 && noAskSize >= 1 ? [{ price: noAsk, size: noAskSize }] : [];

        for (const { market: pm, iv: pIv } of pmBrackets) {
          const pSides = m => { const s = m.marketSides || []; const y = s.find(x => x.description === 'Yes'), no = s.find(x => x.description === 'No');
            return { yes: y && Number(y.price) > 0 && Number(y.price) < 1 ? [{ price: Number(y.price), size: 1e9 }] : [],
                     no: no && Number(no.price) > 0 && Number(no.price) < 1 ? [{ price: Number(no.price), size: 1e9 }] : [] }; };
          const pmTop = pSides(pm);
          // A ⊃ B: wide YES + narrow NO always returns ≥ $1. Check both directions —
          // Kalshi-wide/Polymarket-narrow and Polymarket-wide/Kalshi-narrow — since either
          // platform's bracket might be the finer one for a given pair of strikes.
          const pairs = [
            { A: { iv: kIv, yes: kYes, leg: () => kalshiLeg(m, series, 'YES', kYes) }, B: { iv: pIv, no: pmTop.no, leg: () => pmLeg({ market: pm }, 'NO', pmTop.no) } },
            { A: { iv: pIv, yes: pmTop.yes, leg: () => pmLeg({ market: pm }, 'YES', pmTop.yes) }, B: { iv: kIv, no: kNo, leg: () => kalshiLeg(m, series, 'NO', kNo) } },
          ];
          for (const { A, B } of pairs) {
            if (!A.yes.length || !B.no.length) continue;
            if (!isSubset(B.iv, A.iv) || isSubset(A.iv, B.iv)) continue; // strict subset only (skip identical intervals)
            const legs = [A.leg(), B.leg()];
            const cost = topSetCost(legs, V.feeRoundTo);
            if (cost == null) continue;
            const gap = round6(cost - 1);
            const title = `Polymarket vs Kalshi: “${legs[1].outcome}” priced against “${legs[0].outcome}”`;
            checks.push({ type: 'polymarket-ladder', id: `${legs[0].ticker}+${legs[1].ticker}`, gap, cost, payoff: 1,
              eventTicker: ev.event_ticker, eventTitle: ev.title, label: title, asset: asset.id.toLowerCase(),
              url: legs[0].url, legs: legs.map(l => ({ side: l.side, outcome: l.outcome, price: l.levels[0]?.price ?? null })), legCount: 2 });
            if (gap >= 0) continue;
            const opp = finish({
              module: 'kalshi-polymarket', type: 'ladder', platform: `${legs[0].platform} + ${legs[1].platform}`,
              eventTicker: ev.event_ticker, seriesTicker: ev.series_ticker, eventTitle: ev.title,
              asset: asset.id.toLowerCase(), title,
              legs, minPayoff: 1, maxPayoff: 2, locked: settle.verified, bonusProb: 0,
              logic: `Every result in “${legs[1].outcome}” is also in “${legs[0].outcome}”, so buying YES on the wider range (${legs[0].platform}) and NO on the narrower one (${legs[1].platform}) pays $1 no matter what, and $2 if the result lands in the wider range but outside the narrower one. ${settle.note}`,
              settlementVerified: settle.verified, settlementNote: settle.note,
              riskLabel: settle.verified ? 'locked-in arbitrage across two platforms' : 'positive expected value across two platforms, can still lose to a settlement-source mismatch',
            });
            opps.push(opp);
          }
        }
      }
    }
  }

  // De-dupe, keep the best few, then re-price the Kalshi leg on its full order book (Polymarket's
  // top-of-book price from marketSides already reflects the whole resting order at that price).
  const seen = new Set(), picked = [];
  opps.sort((a, b) => (topSetCost(b.legs, 0.0001) - 1) - (topSetCost(a.legs, 0.0001) - 1));
  for (const o of opps) { if (seen.has(o.id)) continue; seen.add(o.id); picked.push(o); if (picked.length >= 20) break; }
  for (const o of picked) {
    const kLeg = o.legs.find(l => l.platform === 'Kalshi');
    const pLeg = o.legs.find(l => l.platform === 'Polymarket US');
    try {
      const ob = await kalshiOrderbook(kLeg.ticker);
      const side = kLeg.side === 'YES' ? asksFromKalshiOb(ob).yes : asksFromKalshiOb(ob).no;
      if (side.length) { kLeg.levels = side; kLeg.bookSource = 'full order book'; }
    } catch (e) { warnings.push(`Order book for ${kLeg.ticker} failed: ${e.message}`); }
    // Polymarket's real per-price-level depth (fetchPmBook), replacing the placeholder
    // infinite size used during the coarse scan above, so "fillable size" reflects the
    // thinner of the two platforms' actual books, not just Kalshi's.
    try {
      const book = await fetchPmBook(pLeg.ticker);
      const side = pLeg.side === 'YES' ? book.yes : book.no;
      if (side.length) { pLeg.levels = side; pLeg.bookSource = 'full order book'; }
      else { pLeg.levels = []; } // top-of-book price existed but no depth confirmed: don't oversize on it
    } catch (e) { warnings.push(`Polymarket order book for ${pLeg.ticker} failed: ${e.message}`); }
    // "Fillable size" reflects the thinner of the two books, per leg, not just Kalshi's.
    o.fillableSets = Math.floor(Math.min(...o.legs.map(l => depthOf(l.levels))));
  }
  return { opps: picked.filter(o => o.legs.every(l => l.levels.length)), checks, warnings, sources };
}

function asksFromKalshiOb(ob) {
  const book = ob.orderbook_fp || ob.orderbook || {};
  const yesBids = (book.yes_dollars || []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  const noBids = (book.no_dollars || []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  const toAsks = bids => bids.filter(b => b.size >= 0.01).map(b => ({ price: round6(1 - b.price), size: b.size })).filter(a => a.price > 0 && a.price < 1).sort((a, b) => a.price - b.price);
  return { yes: toAsks(noBids), no: toAsks(yesBids) };
}
