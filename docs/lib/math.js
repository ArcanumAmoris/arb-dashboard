// Shared math used by BOTH the scanner (Node, GitHub Actions) and the web page.
// One copy of every formula, so the dashboard and the email alerts always agree.
// Pure functions only: no network, no DOM.

// ---------------------------------------------------------------------------
// Kalshi fees
// Source: Kalshi Fee Schedule effective July 7, 2026 (kalshi.com/docs/kalshi-fee-schedule.pdf)
//   taker fee = round up( M x 0.07   x C x P x (1-P) )
//   maker fee = round up( M x 0.0175 x C x P x (1-P) )   (only series with maker fees)
//   "round up such that the fee + positionCost is rounded to a centicent" ($0.0001)
// M comes from the series' fee_multiplier field in the public API.
// This dashboard always assumes you TAKE the displayed ask (you cross the spread),
// so it always uses the taker fee. That is the conservative choice.
// ---------------------------------------------------------------------------
export const KALSHI_TAKER_RATE = 0.07;
export const KALSHI_MAKER_RATE = 0.0175;

export function roundUpTo(value, increment) {
  if (value <= 0) return 0;
  // subtract a tiny epsilon so 0.0175 doesn't become 0.0176 from float noise
  return Math.ceil(value / increment - 1e-9) * increment;
}

/**
 * Kalshi taker fee in dollars for one fill.
 * @param {number} price     contract price in dollars (0.01..0.99)
 * @param {number} contracts number of contracts in the fill
 * @param {object} [opt]
 * @param {number} [opt.multiplier=1]  series fee_multiplier
 * @param {string} [opt.feeType='quadratic']
 * @param {number} [opt.roundTo=0.0001] rounding increment (centicent per current schedule)
 * @returns {number|null} fee in dollars, or null if the fee type is not modelled
 */
export function kalshiFee(price, contracts, opt = {}) {
  const { multiplier = 1, feeType = 'quadratic', roundTo = 0.0001 } = opt;
  if (!(contracts > 0)) return 0;
  if (!['quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees'].includes(feeType)) {
    return null; // 'flat' uses a separate table; we refuse to guess
  }
  const raw = multiplier * KALSHI_TAKER_RATE * contracts * price * (1 - price);
  return roundUpTo(raw, roundTo);
}

// ---------------------------------------------------------------------------
// Order book walking
// levels: [{price, size}] asks sorted cheapest first
// ---------------------------------------------------------------------------
export function depthOf(levels) {
  return levels.reduce((s, l) => s + l.size, 0);
}

/** Cost to buy `qty` contracts by walking the ask ladder, fee charged per fill. */
export function fillCost(levels, qty, feeOpt = {}) {
  let remaining = qty, cost = 0, fee = 0, worst = null;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    if (take <= 0) continue;
    const f = kalshiFee(lvl.price, take, feeOpt);
    if (f === null) return null;
    cost += take * lvl.price;
    fee += f;
    worst = lvl.price;
    remaining -= take;
  }
  const filled = qty - remaining;
  return { filled, cost: round6(cost), fee: round6(fee), total: round6(cost + fee), worstPrice: worst,
           avgPrice: filled > 0 ? cost / filled : null, complete: remaining <= 0 };
}

// ---------------------------------------------------------------------------
// Returns and annualization
// We use SIMPLE annualization (return x 365 / days). Compounding a 1-day return
// 365 times produces absurd numbers, and your alert rules ("3% in 3 months is
// about 12% a year", "10% in 3 months is about 40% a year") are simple-rate rules.
// ---------------------------------------------------------------------------
export function annualize(returnFrac, days) {
  if (!(days > 0)) return null;
  return returnFrac * 365 / days;
}

/** Hold time in days, floored so an hourly market isn't annualized into fantasy. */
export function holdDays(nowMs, settleMs, minDays = 1) {
  const d = (settleMs - nowMs) / 86400000;
  return Math.max(d, minDays);
}

/** 3-month T-bill: FRED DTB3 is a bank-discount rate. Convert to a normal (investment) yield. */
export function discountToInvestmentYield(discountPct, days = 91) {
  const d = discountPct / 100;
  return 100 * (365 * d) / (360 - d * days);
}

// ---------------------------------------------------------------------------
// Outcome sets (intervals on the underlying: BTC price, gold price, fed rate ...)
// Kalshi strike types:
//   greater:            YES if value >  floor_strike
//   greater_or_equal:   YES if value >= floor_strike
//   less:               YES if value <  cap_strike
//   less_or_equal:      YES if value <= cap_strike
//   between:            YES if floor_strike <= value <= cap_strike
// ---------------------------------------------------------------------------
export function marketInterval(m) {
  const f = num(m.floor_strike), c = num(m.cap_strike);
  switch (m.strike_type) {
    case 'greater': return f == null ? null : { lo: f, loIn: false, hi: Infinity, hiIn: false };
    case 'greater_or_equal': return f == null ? null : { lo: f, loIn: true, hi: Infinity, hiIn: false };
    case 'less': return c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: false };
    case 'less_or_equal': return c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: true };
    case 'between': return f == null || c == null ? null : { lo: f, loIn: true, hi: c, hiIn: true };
    default: return null;
  }
}

/** true if every outcome in B is also in A (B is a subset of A). */
export function isSubset(B, A) {
  const lowOk = A.lo < B.lo || (A.lo === B.lo && (A.loIn || !B.loIn));
  const highOk = A.hi > B.hi || (A.hi === B.hi && (A.hiIn || !B.hiIn));
  return lowOk && highOk;
}

/**
 * Do these intervals cover the whole number line with no gaps and no overlaps?
 * Needed before calling "buy YES on every bracket" a locked-in arbitrage.
 * Prices on the underlying are quoted to the cent, so a gap smaller than
 * `tick` between e.g. 74499.99 and 74500 is not a real gap.
 */
export function coversEverything(intervals, tick = 0.01) {
  if (!intervals.length || intervals.some(i => !i)) return false;
  const s = [...intervals].sort((a, b) => a.lo - b.lo);
  if (s[0].lo !== -Infinity) return false;
  if (s[s.length - 1].hi !== Infinity) return false;
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1], cur = s[i];
    const gap = cur.lo - prev.hi;
    if (gap > tick + 1e-9) return false;           // hole: some prices pay nothing
    if (gap < -1e-9) return false;                 // overlap
    if (gap === 0 && !prev.hiIn && !cur.loIn) return false; // exact boundary excluded by both
  }
  return true;
}

// ---------------------------------------------------------------------------
// Opportunity evaluation (one "set" = one contract on every leg)
// opp.legs[i].levels = ask ladder for that leg; opp.minPayoff / opp.maxPayoff are
// dollars paid per set in the worst / best outcome.
// ---------------------------------------------------------------------------
export function setCost(opp, qty, roundTo) {
  let cost = 0, fee = 0, complete = true;
  const legs = [];
  for (const leg of opp.legs) {
    const r = fillCost(leg.levels, qty, { multiplier: leg.feeMultiplier, feeType: leg.feeType, roundTo });
    if (r === null) return null;
    if (!r.complete) complete = false;
    cost += r.cost; fee += r.fee;
    legs.push(r);
  }
  return { qty, cost: round6(cost), fee: round6(fee), total: round6(cost + fee), complete, legs };
}

/**
 * Pick the best quantity: the most worst-case profit that fits the budget and the
 * order books. Profit per extra set only shrinks as you climb the book, so the best
 * size sits at a price-level boundary or at the budget limit; we test all of those.
 */
export function bestSize(opp, budget, roundTo = 0.0001) {
  const maxDepth = Math.floor(Math.min(...opp.legs.map(l => depthOf(l.levels))));
  if (!(maxDepth >= 1)) return null;
  const cands = new Set([1, maxDepth]);
  for (const leg of opp.legs) {
    let cum = 0;
    for (const l of leg.levels) { cum += l.size; if (cum >= 1 && cum <= maxDepth) cands.add(Math.floor(cum)); }
  }
  // largest qty affordable within budget (binary search, cost is monotonic in qty)
  let lo = 0, hi = maxDepth;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const c = setCost(opp, mid, roundTo);
    if (c && c.total <= budget) lo = mid; else hi = mid - 1;
  }
  const budgetQty = lo;
  if (budgetQty < 1) return { qty: 0, reason: 'budget too small for even one set', budgetQty, maxDepth };
  // locked trades are sized on the guaranteed payout; EV trades on the expected payout
  const payPerSet = opp.locked ? opp.minPayoff : (opp.expectedPayoffPerSet ?? opp.minPayoff);
  let best = null;
  for (const q of [...cands].filter(q => q <= budgetQty).concat([budgetQty])) {
    const c = setCost(opp, q, roundTo);
    if (!c) continue;
    const profit = q * payPerSet - c.total;
    if (!best || profit > best.profitWorst + 1e-9 || (Math.abs(profit - best.profitWorst) < 1e-9 && q < best.qty)) {
      best = { ...c, profitWorst: round6(profit) };
    }
  }
  return { ...best, budgetQty, maxDepth };
}

/**
 * Full evaluation at a given budget. Returns everything a card or an email needs.
 * settings: { minProfit, minReturnPct, lockedMarginPct, evMarginPct, minHoldDays, feeRoundTo }
 */
export function evaluate(opp, budget, tbillPct, settings, nowMs = Date.now()) {
  const s = settings;
  const size = bestSize(opp, budget, s.feeRoundTo);
  const days = holdDays(nowMs, Date.parse(opp.settleTime), s.minHoldDays);
  const out = { budget, days, tbillPct, size };
  if (!size || !size.qty) {
    return { ...out, qty: 0, verdict: 'NOT WORTH IT', verdictWhy: size ? size.reason : 'no order-book depth' };
  }
  const q = size.qty;
  const cost = size.total;
  const worstPayout = q * opp.minPayoff;
  const bestPayout = q * opp.maxPayoff;
  const profitWorst = worstPayout - cost;
  const profitBest = bestPayout - cost;
  // expected payout: worst case plus the market-implied chance of the bonus outcome
  const pBonus = opp.bonusProb ?? 0;
  const profitExpected = opp.locked
    ? profitWorst + q * (opp.maxPayoff - opp.minPayoff) * pBonus
    : (opp.expectedPayoffPerSet != null ? q * opp.expectedPayoffPerSet - cost : null);
  const scoreProfit = opp.locked ? profitWorst : profitExpected;  // what verdicts are judged on
  const ret = cost > 0 ? scoreProfit / cost : 0;
  const ann = annualize(ret, days);
  const margin = opp.locked ? s.lockedMarginPct : s.evMarginPct;
  const hurdle = tbillPct == null ? null : tbillPct + margin;
  const annPct = ann * 100;
  let verdict, why;
  const beatsHurdle = hurdle != null && annPct >= hurdle;
  if (scoreProfit <= 0 || (tbillPct != null && annPct < tbillPct)) {
    verdict = 'NOT WORTH IT';
    why = scoreProfit <= 0 ? 'loses money after fees' : `annualized ${annPct.toFixed(1)}% is below the ${tbillPct.toFixed(2)}% T-bill rate — just buy T-bills`;
  } else if (scoreProfit >= s.minProfit && ret * 100 >= s.minReturnPct && beatsHurdle) {
    verdict = 'WORTH IT';
    why = `$${scoreProfit.toFixed(2)} profit, ${(ret * 100).toFixed(2)}% return, ${annPct.toFixed(1)}%/yr vs ${hurdle.toFixed(2)}% hurdle`;
  } else {
    verdict = 'MARGINAL';
    const miss = [];
    if (scoreProfit < s.minProfit) miss.push(`profit $${scoreProfit.toFixed(2)} < $${s.minProfit}`);
    if (ret * 100 < s.minReturnPct) miss.push(`return ${(ret * 100).toFixed(2)}% < ${s.minReturnPct}%`);
    if (!beatsHurdle) miss.push(hurdle == null ? 'T-bill rate unavailable' : `annualized ${annPct.toFixed(1)}% < ${hurdle.toFixed(2)}% hurdle`);
    why = miss.join('; ');
  }
  return {
    ...out, qty: q, cost, fees: size.fee, worstPayout, bestPayout,
    profitWorst: round6(profitWorst), profitBest: round6(profitBest),
    profitExpected: profitExpected == null ? null : round6(profitExpected),
    maxLoss: round6(Math.max(0, -profitWorst)),
    returnPct: ret * 100, annualizedPct: annPct, hurdlePct: hurdle,
    verdict, verdictWhy: why,
    depthLimited: size.budgetQty >= size.maxDepth && budget > cost + 1,
    maxDepth: size.maxDepth, legFills: size.legs,
  };
}

// ---------------------------------------------------------------------------
function num(x) { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }
export function round6(x) { return Math.round(x * 1e6) / 1e6; }
