// Kalshi vs listed options. Pure math, shared by the scanner and the web page.
//
// The trade is always a cross-market "sum under $1":
//   Side 1 (Kalshi): a YES or NO contract that pays $1 in region R (e.g. BTC ≤ $150k).
//   Side 2 (options, Robinhood): a DEBIT spread that pays its full width when the
//          underlying is in the other region, R's complement (e.g. BTC > $150k).
// The option strikes are placed INSIDE region R, so the two payouts overlap a little
// instead of leaving a gap. Sized so one spread (100 × width dollars) covers
// 100 × width Kalshi contracts, every outcome pays ≥ $1 per Kalshi contract,
// EXCEPT when the option expiry and the Kalshi settlement time differ, or the ETF
// drifts from the thing Kalshi settles on. Those risks are simulated, never ignored.

// ---------------------------------------------------------------- statistics
export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function normInv(p) {
  // Acklam's rational approximation, |relative error| < 1.2e-9
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Small, fast, seeded RNG so every scan is reproducible (mulberry32). */
export function rng(seed = 42) {
  let s = seed >>> 0;
  const u = () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let x, y, r2;
    do { x = 2 * u() - 1; y = 2 * u() - 1; r2 = x * x + y * y; } while (r2 >= 1 || r2 === 0);
    const f = Math.sqrt(-2 * Math.log(r2) / r2); spare = y * f; return x * f;
  };
  return { u, gauss };
}

// ---------------------------------------------------------------- option chains
/** Parse an OCC symbol like SPXW261002C07700000 → {root, expiry:'2026-10-02', type:'C', strike:7700} */
export function parseOcc(sym) {
  const m = /^([A-Z]+?)(\d{6})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  const [, root, ymd, type, k] = m;
  return { root, expiry: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`, type, strike: Number(k) / 1000 };
}

const midOf = q => (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.ask > 0 ? q.ask / 2 : null);

/**
 * Option-implied probability that the ETF/index ends ABOVE x at this expiry:
 * the slope of the call price between the two listed strikes around x, using mids.
 * (A call spread's price divided by its width is the market's price of a $1 digital.)
 */
export function digitalAbove(calls, x) {
  const ks = calls.filter(q => midOf(q) != null).sort((a, b) => a.strike - b.strike);
  if (ks.length < 2 || x <= ks[0].strike || x >= ks[ks.length - 1].strike) return null;
  let i = ks.findIndex(q => q.strike >= x);
  if (i <= 0) return null;
  const lo = ks[i - 1], hi = ks[i];
  const p = (midOf(lo) - midOf(hi)) / (hi.strike - lo.strike);
  return { p: Math.min(1, Math.max(0, p)), kLo: lo.strike, kHi: hi.strike, iv: avgIv(lo, hi) };
}
const avgIv = (...qs) => { const v = qs.map(q => q.iv).filter(x => x > 0.01 && x < 5); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

/**
 * Move a probability from the option's expiry to Kalshi's settlement time, assuming
 * the log-price moves randomly with the options' own implied volatility (no drift).
 * Keeps the option market's view of how far the strike is; only the clock changes.
 */
export function shiftProbability(pAbove, sigma, tauOpt, tauKalshi) {
  if (!(sigma > 0) || !(tauOpt > 0) || !(tauKalshi > 0) || Math.abs(tauOpt - tauKalshi) < 1e-9) return pAbove;
  const p = Math.min(1 - 1e-9, Math.max(1e-9, pAbove));
  const z = normInv(p);
  const lnFK = z * sigma * Math.sqrt(tauOpt) + 0.5 * sigma * sigma * tauOpt;   // ln(F/X) implied by the option price
  return normCdf((lnFK - 0.5 * sigma * sigma * tauKalshi) / (sigma * Math.sqrt(tauKalshi)));
}

/**
 * Implied volatility at price level x, read from out-of-the-money options (calls above the
 * current price, puts below), linearly interpolated between the two nearest strikes.
 * Using the strike's own volatility keeps the market's skew (fat tails priced richer).
 */
export function impliedVolAt(calls, puts, x, spot) {
  const pool = (x >= spot ? calls : puts).filter(q => q.iv > 0.01 && q.iv < 5 && (q.bid > 0 || q.ask > 0)).sort((a, b) => a.strike - b.strike);
  if (!pool.length) return null;
  if (x <= pool[0].strike) return pool[0].iv;
  if (x >= pool[pool.length - 1].strike) return pool[pool.length - 1].iv;
  const i = pool.findIndex(q => q.strike >= x), lo = pool[i - 1], hi = pool[i];
  const f = (x - lo.strike) / (hi.strike - lo.strike);
  return lo.iv + f * (hi.iv - lo.iv);
}

/** P(price at time tau > x) for a lognormal price with no drift, starting at s. */
export function probAbove(s, x, sigma, tau) {
  if (!(tau > 0) || !(sigma > 0)) return s > x ? 1 : 0;
  return normCdf((Math.log(s / x) - 0.5 * sigma * sigma * tau) / (sigma * Math.sqrt(tau)));
}

// ---------------------------------------------------------------- hedge construction
/**
 * Choose the cheapest debit spread that pays in the direction `lossDir`:
 *   'up'   → call spread (buy k1, sell k2), fully paid once the ETF is ≥ k2; needs k2 ≤ edge
 *   'down' → put spread  (buy k2, sell k1), fully paid once the ETF is ≤ k1; needs k1 ≥ edge
 * `edge` is the mapped Kalshi strike moved INTO the Kalshi side's paying region by a
 * safety margin, so the options are fully paid everywhere Side 1 loses.
 */
export function pickSpread({ calls, puts, lossDir, edge, slip = 0, maxSteps = 4, maxWidthFrac = 0.08, fee = 0 }) {
  const book = (lossDir === 'up' ? calls : puts).filter(q => q.ask > 0).sort((a, b) => a.strike - b.strike);
  if (book.length < 2) return null;
  let best = null;
  const cands = lossDir === 'up'
    ? book.filter(q => q.strike <= edge).slice(-3)        // the 3 highest strikes at or below the edge
    : book.filter(q => q.strike >= edge).slice(0, 3);     // the 3 lowest strikes at or above the edge
  for (const inner of cands) {
    const idx = book.indexOf(inner);
    for (let s = 1; s <= maxSteps; s++) {
      const outer = lossDir === 'up' ? book[idx - s] : book[idx + s];
      if (!outer) break;
      const w = Math.abs(inner.strike - outer.strike);
      if (w > maxWidthFrac * inner.strike) break;
      // buy the leg further from the edge, sell the leg at/next to the edge
      const buy = outer, sell = inner;
      const buyPx = buy.ask + slip, sellPx = Math.max(0, (sell.bid || 0) - slip);
      const debit = buyPx - sellPx;
      if (!(debit > 0) || debit >= w) continue;
      const perUnit = debit / w + (2 * fee) / (100 * w);    // cost per $1 of payout, incl. per-contract fees
      const size = Math.min(buy.ask_size || 0, sell.bid > 0 ? (sell.bid_size || 0) : Infinity);
      const cand = { type: lossDir === 'up' ? 'call' : 'put', k1: Math.min(buy.strike, sell.strike), k2: Math.max(buy.strike, sell.strike),
        width: w, buy: { strike: buy.strike, price: buyPx, quote: buy.ask, size: buy.ask_size, iv: buy.iv },
        sell: { strike: sell.strike, price: sellPx, quote: sell.bid || 0, size: sell.bid_size, iv: sell.iv },
        debit: round4(debit), perUnit, maxSpreads: Number.isFinite(size) ? Math.floor(size) : 9999 };
      if (!best || perUnit < best.perUnit) best = cand;
    }
  }
  return best;
}

/** What the option spread pays, as a fraction of its width (0..1), for an ETF price e. */
export function spreadFraction(spread, e) {
  const w = spread.k2 - spread.k1;
  if (spread.type === 'call') return Math.min(1, Math.max(0, (e - spread.k1) / w));
  return Math.min(1, Math.max(0, (spread.k2 - e) / w));
}

// ---------------------------------------------------------------- simulation
/**
 * Simulate the payout of ONE unit = 1 Kalshi contract + 1/(100×width) of a spread,
 * i.e. both sides sized to pay $1. Returns payout statistics (dollars per unit).
 *   p: { s0, strikeK, kalshiPaysAbove (bool), ratio, spread, sigma, tK, tO (years from now), basisSigma, paths, seed }
 */
export function simulateUnit(p) {
  const { s0, strikeK, kalshiPaysAbove, ratio, spread, sigma, tK, tO, basisSigma = 0, paths = 20000, seed = 7 } = p;
  const r = rng(seed);
  const t1 = Math.min(tK, tO), t2 = Math.max(tK, tO);
  const out = new Float64Array(paths);
  let sum = 0, band = 0, gapLoss = 0;
  for (let i = 0; i < paths; i++) {
    const s1 = s0 * Math.exp(-0.5 * sigma * sigma * t1 + sigma * Math.sqrt(t1) * r.gauss());
    const dt = t2 - t1;
    const s2 = dt > 0 ? s1 * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * r.gauss()) : s1;
    const sK = tK <= tO ? s1 : s2, sO = tK <= tO ? s2 : s1;
    const e = ratio * sO * (basisSigma > 0 ? Math.exp(basisSigma * r.gauss()) : 1);
    const kalshi = (kalshiPaysAbove ? sK > strikeK : sK <= strikeK) ? 1 : 0;
    const opt = spreadFraction(spread, e);
    const pay = kalshi + opt;
    out[i] = pay; sum += pay;
    if (pay > 1 + 1e-9) band++;
    if (pay < 1 - 1e-9) gapLoss++;
  }
  out.sort();
  const q = f => out[Math.min(paths - 1, Math.floor(f * paths))];
  return { paths, meanPayout: sum / paths, pUnderOne: gapLoss / paths, pBonus: band / paths,
    worst: out[0], p001: q(0.001), p01: q(0.01), p05: q(0.05), median: q(0.5) };
}

/** Probability, from a sorted-free summary, that payout < cost (a losing outcome). */
export function lossProbability(sim, costPerUnit) {
  // payouts below 1 come only from timing/basis misses; with cost < 1 a loss needs payout < cost,
  // which the simulation counts as pUnderOne (payout < 1) — a slight overcount, i.e. conservative.
  return costPerUnit < 1 ? sim.pUnderOne : 1;
}

// ---------------------------------------------------------------- sizing and verdict
/**
 * Size the hedged trade for a budget. Units come in blocks of 100 × width Kalshi
 * contracts per option spread. Kalshi cost walks the real order book.
 *   opp: { kalshi: {levels, feeMultiplier, feeType}, spread, sim, settleTime, ... }
 */
export function sizeOptionsTrade(opp, budget, { fillCost, feeRoundTo = 0.0001, optionFee = 0, maxSpreads = Infinity } = {}) {
  const w = opp.spread.width;
  const perSpreadContracts = Math.round(100 * w);           // Kalshi contracts covered by one spread
  const optPerSpread = 100 * opp.spread.debit + 2 * optionFee;
  const depth = opp.kalshi.levels.reduce((s, l) => s + l.size, 0);
  const cap = Math.min(maxSpreads, opp.spread.maxSpreads || Infinity, Math.floor(depth / perSpreadContracts));
  let best = null;
  for (let n = 1; n <= cap; n++) {
    const nk = n * perSpreadContracts;
    const k = fillCost(opp.kalshi.levels, nk, { multiplier: opp.kalshi.feeMultiplier, feeType: opp.kalshi.feeType, roundTo: feeRoundTo });
    if (!k || !k.complete) break;
    const total = k.total + n * optPerSpread;
    if (total > budget) break;
    const tailProfit = nk - total;                             // both "normal" outcomes pay exactly nk
    if (best && tailProfit <= best.tailProfit) break;          // deeper book no longer adds profit
    best = { spreads: n, kalshiContracts: nk, kalshiCost: k.cost, kalshiFee: k.fee, kalshiAvg: k.avgPrice, kalshiWorst: k.worstPrice,
      optionCost: n * optPerSpread, total, tailProfit };
  }
  return { best, perSpreadContracts, optPerSpread, minBudget: null, capSpreads: cap };
}

export function evaluateOptionsTrade(opp, budget, tbillPct, settings, helpers, nowMs = Date.now()) {
  const s = settings;
  const sized = sizeOptionsTrade(opp, budget, { ...helpers, feeRoundTo: s.feeRoundTo, optionFee: s.optionFeePerContract ?? 0 });
  const days = Math.max((Date.parse(opp.holdUntil) - nowMs) / 86400000, s.minHoldDays);
  if (!sized.best) {
    const one = helpers.fillCost(opp.kalshi.levels, sized.perSpreadContracts, { multiplier: opp.kalshi.feeMultiplier, feeType: opp.kalshi.feeType, roundTo: s.feeRoundTo });
    const minBudget = one && one.complete ? one.total + sized.optPerSpread : null;
    return { qty: 0, days, tbillPct, verdict: 'NOT WORTH IT',
      verdictWhy: minBudget ? `smallest possible trade is ${money0(minBudget)} (1 option spread covers ${sized.perSpreadContracts} Kalshi contracts)` : 'not enough Kalshi depth for even one option spread',
      minBudget };
  }
  const b = sized.best, nk = b.kalshiContracts;
  const expected = nk * opp.sim.meanPayout - b.total;
  const worstSim = nk * opp.sim.worst - b.total;
  const p1 = nk * opp.sim.p01 - b.total;
  const best = nk * 2 - b.total;
  const ret = expected / b.total;
  const ann = (ret * 365 / days) * 100;
  const hurdle = tbillPct == null ? null : tbillPct + s.evMarginPct;
  let verdict, why;
  if (expected <= 0 || b.tailProfit <= 0) { verdict = 'NOT WORTH IT'; why = 'loses money after fees'; }
  else if (tbillPct != null && ann < tbillPct) { verdict = 'NOT WORTH IT'; why = `annualized ${ann.toFixed(1)}% is below the ${tbillPct.toFixed(2)}% T-bill rate — just buy T-bills`; }
  else if (opp.sim.pUnderOne > (s.maxLossChance ?? 0.05)) { verdict = 'MARGINAL'; why = `${(opp.sim.pUnderOne * 100).toFixed(1)}% simulated chance of losing money is above the ${((s.maxLossChance ?? 0.05) * 100).toFixed(0)}% limit for WORTH IT`; }
  else if (expected >= s.minProfit && ret * 100 >= s.minReturnPct && hurdle != null && ann >= hurdle) { verdict = 'WORTH IT'; why = `$${expected.toFixed(2)} expected, ${(ret * 100).toFixed(2)}% return, ${ann.toFixed(1)}%/yr vs ${hurdle.toFixed(2)}% hurdle`; }
  else {
    verdict = 'MARGINAL';
    const miss = [];
    if (expected < s.minProfit) miss.push(`expected profit $${expected.toFixed(2)} < $${s.minProfit}`);
    if (ret * 100 < s.minReturnPct) miss.push(`return ${(ret * 100).toFixed(2)}% < ${s.minReturnPct}%`);
    if (hurdle == null || ann < hurdle) miss.push(hurdle == null ? 'T-bill rate unavailable' : `annualized ${ann.toFixed(1)}% < ${hurdle.toFixed(2)}% hurdle (can-lose trades need T-bills + ${s.evMarginPct})`);
    why = miss.join('; ');
  }
  return { qty: nk, spreads: b.spreads, kalshiCost: b.kalshiCost, kalshiFee: b.kalshiFee, kalshiAvg: b.kalshiAvg, kalshiWorst: b.kalshiWorst,
    optionCost: b.optionCost, cost: round4(b.total), fees: round4(b.kalshiFee + 2 * b.spreads * (s.optionFeePerContract ?? 0)),
    tailProfit: round4(b.tailProfit), profitExpected: round4(expected), profitWorst: round4(worstSim), profitP1: round4(p1), profitBest: round4(best),
    maxLoss: round4(Math.max(0, b.total - nk * opp.sim.worst)), pLoss: lossProbability(opp.sim, b.total / nk),
    returnPct: ret * 100, annualizedPct: ann, hurdlePct: hurdle, days, tbillPct, verdict, verdictWhy: why,
    depthLimited: sized.capSpreads === b.spreads && budget > b.total * (b.spreads + 1) / b.spreads,
    maxSpreads: sized.capSpreads };
}

const round4 = x => Math.round(x * 1e4) / 1e4;
const money0 = x => `$${Math.ceil(x).toLocaleString('en-US')}`;
