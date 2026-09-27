// Wording shared by the dashboard cards and the alert emails, so both say exactly the same thing.

export const money = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(d)}%`);
// Kalshi quotes some markets in tenths of a cent (e.g. $0.124), so never round a price away.
export const cents = p => {
  if (p == null || !Number.isFinite(p)) return '—';
  let s = String(+p.toFixed(4));
  const dec = s.includes('.') ? s.split('.')[1].length : 0;
  if (dec < 2) s = p.toFixed(2);
  return `$${s}`;
};

/** One entry per leg: the plain-English instruction plus the numbers behind it. */
export function legInstructions(opp, ev) {
  return opp.legs.map((leg, i) => {
    const f = ev.legFills?.[i] || {};
    const avg = f.avgPrice ?? leg.levels[0]?.price;
    const worst = f.worstPrice ?? avg;
    const priceTxt = worst != null && Math.abs(worst - avg) > 1e-9
      ? `at up to ${cents(worst)} each (average ${cents(avg)})`
      : `at ${cents(avg)} each`;
    const total = (f.cost ?? 0) + (f.fee ?? 0);
    return {
      leg,
      text: `Buy ${ev.qty} ${leg.side} contracts of “${leg.name}” on ${leg.platform} ${priceTxt}.`,
      cost: total, fee: f.fee ?? 0,
      how: leg.pick,
    };
  });
}

export function daysText(days) {
  if (days < 1.01) return 'about a day or less';
  if (days < 45) return `${days.toFixed(1)} days`;
  return `${(days / 30.4).toFixed(1)} months (${Math.round(days)} days)`;
}

export const TYPE_NAMES = {
  'ladder': 'Ladder mispricing',
  'bracket-all-yes': 'Bracket sum under $1',
  'outcomes-no-set': 'NO set on exclusive outcomes',
  'yes-plus-no': 'YES + NO under $1',
};
