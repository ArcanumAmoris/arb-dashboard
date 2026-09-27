// Alert rules as a pure function so they can be unit-tested.
import { evaluate } from '../docs/lib/math.js';

// -----------------------------------------------------------------------------
/** Pure decision function (unit-tested). */
export function pickAlerts(data, state, settings, today, nowMs = Date.now()) {
  const A = settings.alerts, V = settings.verdict;
  const tb = data.tbill?.yieldPct ?? null;
  const picked = [], log = [];
  for (const opp of data.opportunities || []) {
    const ev = evaluate(opp, A.amount, tb, V, nowMs);
    if (!ev.qty) continue;
    const profit = opp.locked ? ev.profitWorst : ev.profitExpected;
    ev.opp_profit = profit;
    const why = [];
    if (!A.allowedConfidence.includes(opp.confidence?.level)) why.push(`confidence ${opp.confidence?.level}`);
    if ((opp.fillableDollars ?? 0) < A.minFillDollars) why.push(`only $${(opp.fillableDollars ?? 0).toFixed(0)} fillable (< $${A.minFillDollars})`);
    if (!(profit >= A.minProfit)) why.push(`profit $${(profit ?? 0).toFixed(2)} < $${A.minProfit}`);
    let tier, tierName;
    if (opp.locked) {
      tier = 1; tierName = 'Tier 1 · Locked-in arbitrage';
      if (!(ev.annualizedPct >= A.tier1MinAnnualizedPct)) why.push(`annualized ${ev.annualizedPct.toFixed(1)}% < ${A.tier1MinAnnualizedPct}%`);
      if (tb == null) why.push('T-bill rate unknown');
      else if (!(ev.annualizedPct >= tb + V.lockedMarginPct)) why.push(`doesn't clearly beat T-bills (${tb}% + ${V.lockedMarginPct})`);
    } else {
      tier = 2; tierName = 'Tier 2 · Positive EV (can lose)';
      if (!(ev.annualizedPct >= A.tier2MinAnnualizedPct)) why.push(`annualized ${ev.annualizedPct.toFixed(1)}% < ${A.tier2MinAnnualizedPct}%`);
    }
    const prev = state.sent?.[opp.id];
    if (prev && !(profit > prev.profit * (1 + A.reAlertImprovementPct / 100))) why.push('already alerted (profit has not improved by more than ' + A.reAlertImprovementPct + '%)');
    if (why.length) { log.push(`skip ${opp.id}: ${why.join('; ')}`); continue; }
    picked.push({ opp, ev, tier, tierName, tooGood: opp.locked && ev.returnPct > A.tooGoodReturnPct, reAlert: Boolean(prev) });
  }
  return { picked, log };
}
