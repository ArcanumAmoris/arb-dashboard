// Module 1: Kalshi bracket / ladder consistency.
// Pure functions: take Kalshi event + market JSON, return candidate opportunities.
// Every candidate is checked at the top of the book here; run.js then pulls the
// full order books for candidates and re-prices them with real depth.

import { kalshiFee, marketInterval, isSubset, coversEverything, round6 } from '../docs/lib/math.js';
import { kalshiEventUrl, kalshiSeriesUrl } from '../docs/lib/links.js';

const n = x => (x === null || x === undefined || x === '' ? null : Number(x));

/** Top-of-book ask ladders from a /markets or nested-event market record. */
export function topOfBook(m) {
  const yesAsk = n(m.yes_ask_dollars), noAsk = n(m.no_ask_dollars);
  const yesAskSize = n(m.yes_ask_size_fp) ?? 0;   // resting NO bids = YES asks
  const noAskSize = n(m.yes_bid_size_fp) ?? 0;    // resting YES bids = NO asks
  return {
    yes: yesAsk != null && yesAsk > 0 && yesAsk < 1 && yesAskSize >= 1 ? [{ price: yesAsk, size: yesAskSize }] : [],
    no: noAsk != null && noAsk > 0 && noAsk < 1 && noAskSize >= 1 ? [{ price: noAsk, size: noAskSize }] : [],
    yesBid: n(m.yes_bid_dollars), yesAsk, noAsk,
  };
}

/** Convert Kalshi /orderbook response (bids only) into ask ladders for each side. */
export function asksFromOrderbook(ob) {
  const book = ob.orderbook_fp || ob.orderbook || {};
  const yesBids = (book.yes_dollars || []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  const noBids = (book.no_dollars || []).map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  // Buying YES means hitting someone's NO bid: YES ask = 1 - NO bid.
  const toAsks = bids => bids.filter(b => b.size >= 0.01)
    .map(b => ({ price: round6(1 - b.price), size: b.size }))
    .filter(a => a.price > 0 && a.price < 1)
    .sort((a, b) => a.price - b.price);
  return { yes: toAsks(noBids), no: toAsks(yesBids) };
}

export function mid(m) {
  const b = n(m.yes_bid_dollars), a = n(m.yes_ask_dollars);
  if (b == null || a == null) return null;
  return (b + a) / 2;
}

/** Tag the asset so the UI can filter (gold, bitcoin, fed, cpi ...). */
export function classifyAsset(seriesTicker = '', title = '', category = '') {
  const t = (seriesTicker + ' ' + title).toUpperCase();
  const rules = [
    ['gold', /GOLD|XAU/], ['silver', /SILVER|XAG/], ['platinum', /PLATINUM|XPT/], ['palladium', /PALLADIUM/],
    ['bitcoin', /BTC|BITCOIN/], ['ethereum', /ETH(?!IOPIA)|ETHEREUM/], ['solana', /\bSOL|SOLANA/],
    ['xrp', /XRP|RIPPLE/], ['dogecoin', /DOGE/],
    ['fed', /FED|FOMC|EFFR|RATE CUT|FUNDS/], ['inflation', /CPI|PCE|INFLATION|PPI/],
    ['jobs', /PAYROLL|NFP|JOBS|UNEMPLOY|JOBLESS|\bUE\b|ADP/], ['gdp', /GDP/],
    ['stock index', /INX|S&P|NASDAQ|DOW|NIKKEI|KOSPI|RUSSELL/], ['treasury', /TREASURY|UST|TNOTE|YIELD/],
    ['oil & energy', /WTI|BRENT|OIL|NATGAS|NGAS|GAS PRICE|AAAGAS/],
  ];
  for (const [name, re] of rules) if (re.test(t)) return name;
  if (category === 'Crypto') return 'other crypto';
  return (category || 'other').toLowerCase();
}

function legFrom(m, side, series, levels) {
  const sub = side === 'YES' ? (m.yes_sub_title || m.subtitle) : (m.no_sub_title || m.yes_sub_title || m.subtitle);
  return {
    platform: 'Kalshi', ticker: m.ticker, side,
    name: `${m.title} — ${m.yes_sub_title || m.subtitle || m.ticker}`.replace(/\s+/g, ' ').trim(),
    pick: `On the event page, find the row “${m.yes_sub_title || m.subtitle || m.ticker}” and press “${side === 'YES' ? 'Yes' : 'No'}”.`,
    sideLabel: sub,
    outcome: (m.yes_sub_title || m.subtitle || m.ticker || '').replace(/\s+/g, ' ').trim(), // what a YES on this contract means
    yesBid: n(m.yes_bid_dollars),
    levels,
    feeMultiplier: series?.fee_multiplier ?? 1, feeType: series?.fee_type ?? 'quadratic',
    url: kalshiEventUrl(m.series_ticker || series?.ticker, m.event_ticker, series?.title),
    fallbackUrl: kalshiSeriesUrl(m.series_ticker || series?.ticker),
    closeTime: m.close_time, settleTime: m.expected_expiration_time || m.close_time,
    latestExpiration: m.latest_expiration_time,
    volume24h: n(m.volume_24h_fp) ?? 0, openInterest: n(m.open_interest_fp) ?? 0, status: m.status,
  };
}

/** Precision of the strikes (74499.99 -> 0.01, 0.6 -> 0.1, 175000 -> 1). Adjacent brackets
 *  like 74,250-74,499.99 and 74,500-74,749.99 leave a "gap" of one step, which is not real. */
export function strikeTick(markets) {
  let dec = 0;
  for (const m of markets) for (const v of [m.floor_strike, m.cap_strike]) {
    if (v === null || v === undefined || v === '') continue;
    const s = String(v); const i = s.indexOf('.');
    if (i >= 0) dec = Math.max(dec, s.length - i - 1);   // String(1000.00) is "1000", so no trailing zeros
  }
  return Number((10 ** -Math.min(dec, 6)).toFixed(6));
}

function oneFee(price, leg, roundTo) {
  return kalshiFee(price, 1, { multiplier: leg.feeMultiplier, feeType: leg.feeType, roundTo });
}

/** Cost of one set at top of book, including fees; null if any leg has no ask. */
export function topSetCost(legs, roundTo) {
  let t = 0;
  for (const l of legs) {
    if (!l.levels.length) return null;
    const f = oneFee(l.levels[0].price, l, roundTo);
    if (f === null) return null;
    t += l.levels[0].price + f;
  }
  return round6(t);
}

function base(ev, series, type) {
  return {
    module: 'kalshi-consistency', type, platform: 'Kalshi',
    eventTicker: ev.event_ticker, seriesTicker: ev.series_ticker, eventTitle: ev.title,
    eventSubtitle: ev.sub_title, category: ev.category,
    asset: classifyAsset(ev.series_ticker, ev.title, ev.category),
    seriesTitle: series?.title,
  };
}

function finish(opp) {
  const settle = opp.legs.map(l => Date.parse(l.settleTime)).filter(Number.isFinite);
  opp.settleTime = new Date(Math.max(...settle)).toISOString();
  opp.closeTime = new Date(Math.min(...opp.legs.map(l => Date.parse(l.closeTime)).filter(Number.isFinite))).toISOString();
  opp.id = `${opp.type}:${opp.legs.map(l => `${l.ticker}:${l.side}`).sort().join('+')}`;
  return opp;
}

/**
 * Scan one event. Returns { opps: [...candidates], checks: [...all checks with gap] }.
 * gap = (cost of one set incl. fees) - (guaranteed payout). Negative gap = profit.
 */
export function scanEvent(ev, series, { roundTo = 0.0001 } = {}) {
  const markets = (ev.markets || []).filter(m => m.status === 'active' || m.status === 'open');
  const books = new Map(markets.map(m => [m.ticker, topOfBook(m)]));
  const opps = [], checks = [];
  const record = (opp, cost, payoff) => {
    const gap = round6(cost - payoff);
    checks.push({ type: opp.type, id: opp.id, gap, cost: round6(cost), payoff, eventTicker: ev.event_ticker,
      eventTitle: ev.title, label: opp.title, asset: opp.asset, url: opp.legs[0].url,
      legs: opp.legs.slice(0, 8).map(l => ({ side: l.side, outcome: l.outcome, price: l.levels[0]?.price ?? null })),
      legCount: opp.legs.length });
    if (gap < 0) opps.push(opp);
  };

  // (a) YES + NO on the same contract: together they always pay exactly $1.
  for (const m of markets) {
    const b = books.get(m.ticker);
    if (!b.yes.length || !b.no.length) continue;
    const opp = finish({ ...base(ev, series, 'yes-plus-no'),
      title: `YES + NO on one contract: ${m.yes_sub_title || m.ticker}`,
      legs: [legFrom(m, 'YES', series, b.yes), legFrom(m, 'NO', series, b.no)],
      minPayoff: 1, maxPayoff: 1, locked: true, bonusProb: 0,
      logic: 'Exactly one of YES or NO pays $1, so holding both always returns $1.' });
    const c = topSetCost(opp.legs, roundTo); if (c != null) record(opp, c, 1);
  }

  // (b) Ladder / nesting: if outcome set B sits inside outcome set A, then
  //     YES on A + NO on B always pays at least $1 (and $2 if the result lands in A but not B).
  const withIv = markets.map(m => ({ m, iv: marketInterval(m) })).filter(x => x.iv);
  for (const A of withIv) {
    const bA = books.get(A.m.ticker); if (!bA.yes.length) continue;
    for (const B of withIv) {
      if (A === B) continue;
      if (!isSubset(B.iv, A.iv) || isSubset(A.iv, B.iv)) continue; // strict subset only
      const bB = books.get(B.m.ticker); if (!bB.no.length) continue;
      const mA = mid(A.m), mB = mid(B.m);
      const opp = finish({ ...base(ev, series, 'ladder'),
        title: `Ladder mispricing: “${B.m.yes_sub_title}” priced vs “${A.m.yes_sub_title}”`,
        legs: [legFrom(A.m, 'YES', series, bA.yes), legFrom(B.m, 'NO', series, bB.no)],
        minPayoff: 1, maxPayoff: 2, locked: true,
        bonusProb: mA != null && mB != null ? Math.min(1, Math.max(0, mA - mB)) : 0,
        logic: `Every result inside “${B.m.yes_sub_title}” is also inside “${A.m.yes_sub_title}”, so “${B.m.yes_sub_title}” can never be more likely. ` +
               `YES on the wider outcome + NO on the narrower one pays $1 no matter what, and $2 if the result lands in the wider range but outside the narrower one.`,
        violation: { widerYesAsk: bA.yes[0].price, narrowerYesBid: bB.yesBid } });
      const c = topSetCost(opp.legs, roundTo); if (c != null) record(opp, c, 1);
    }
  }

  if (ev.mutually_exclusive && markets.length >= 2) {
    const all = markets.map(m => ({ m, b: books.get(m.ticker), iv: marketInterval(m) }));
    // (c) Buy YES on every outcome. Only valid when the outcomes provably cover every
    //     possible result (numeric brackets with no gaps). For named outcomes
    //     ("Who will acquire X?", "When will the recession start?") it's common that
    //     NONE happens, so buying every YES can lose everything: we never show those.
    const tick = strikeTick(markets);
    const exhaustive = all.every(x => x.iv) && coversEverything(all.map(x => x.iv), tick);
    if (exhaustive && all.every(x => x.b.yes.length)) {
      const opp = finish({ ...base(ev, series, 'bracket-all-yes'),
        title: `Buy YES on all ${all.length} brackets of “${ev.title}”`,
        legs: all.map(x => legFrom(x.m, 'YES', series, x.b.yes)),
        minPayoff: 1, maxPayoff: 1, locked: true, bonusProb: 0, exhaustiveVerified: true, strikeTick: tick,
        logic: 'The brackets cover every possible result with no gaps, and exactly one bracket wins. Owning one YES on each pays exactly $1.' +
          (tick > 0.01 ? ` (Checked assuming the result is reported in steps of ${tick}, the precision of Kalshi's strikes. Confirm in the rules.)` : '') });
      const c = topSetCost(opp.legs, roundTo); if (c != null) record(opp, c, 1);
    }
    // (d) Buy NO on the outcomes where NO is cheap enough. At most one outcome wins,
    //     so k NO contracts always pay at least k-1 dollars.
    const vals = all.filter(x => x.b.no.length).map(x => {
      const leg = legFrom(x.m, 'NO', series, x.b.no);
      const f = oneFee(x.b.no[0].price, leg, roundTo);
      return { x, leg, v: f == null ? -1 : 1 - x.b.no[0].price - f };
    }).sort((a, b) => b.v - a.v);
    const pick = vals.filter(v => v.v > 0);
    const chosen = pick.length >= 2 ? pick : vals.slice(0, Math.min(vals.length, 2));
    if (chosen.length >= 2) {
      const k = chosen.length;
      const pInside = chosen.reduce((s, c) => s + (mid(c.x.m) ?? 0), 0);
      const opp = finish({ ...base(ev, series, 'outcomes-no-set'),
        title: `Buy NO on ${k} of ${all.length} outcomes of “${ev.title}”`,
        legs: chosen.map(c => c.leg),
        minPayoff: k - 1, maxPayoff: k, locked: true,
        bonusProb: Math.min(1, Math.max(0, 1 - pInside)),
        logic: `At most one outcome can win, so at most one of your ${k} NO contracts can lose. You collect at least $${k - 1} (and $${k} if the winner is an outcome you didn't bet against).` });
      const c = topSetCost(opp.legs, roundTo); if (c != null) record(opp, c, k - 1);
    }
  }
  return { opps, checks };
}
