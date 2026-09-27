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

// ---------------------------------------------------------------------------
// "Both sides of the bet" explanations. Used on cards and in emails.
// ---------------------------------------------------------------------------
export const outcomeOf = leg => leg.outcome || leg.sideLabel || leg.ticker;

/** What one leg pays, in words. */
export function legPays(leg) {
  const o = outcomeOf(leg);
  return leg.side === 'YES' ? `pays $1 if the result is “${o}”` : `pays $1 if the result is anything except “${o}”`;
}

/** Every distinct outcome and what each leg pays in it (per set). */
export function scenarios(opp) {
  const L = opp.legs;
  switch (opp.type) {
    case 'ladder': {
      const a = outcomeOf(L[0]), b = outcomeOf(L[1]);
      return [
        { when: `Result is “${b}”`, pays: [1, 0], total: 1 },
        { when: `Result is “${a}” but not “${b}”`, pays: [1, 1], total: 2 },
        { when: `Result is not “${a}”`, pays: [0, 1], total: 1 },
      ];
    }
    case 'yes-plus-no': {
      const o = outcomeOf(L[0]);
      return [
        { when: `Result is “${o}”`, pays: [1, 0], total: 1 },
        { when: `Result is not “${o}”`, pays: [0, 1], total: 1 },
      ];
    }
    case 'bracket-all-yes':
      return [{ when: 'The result lands in any bracket', text: 'that bracket’s YES pays $1, every other YES pays $0', total: 1 }];
    case 'outcomes-no-set': {
      const k = L.length;
      return [
        { when: `One of these ${k} outcomes wins`, text: `its NO pays $0, your other ${k - 1} NOs pay $1 each`, total: k - 1 },
        { when: 'Any other outcome wins, or none of them', text: `all ${k} NOs pay $1`, total: k },
      ];
    }
    default:
      return [];
  }
}

/** One or two sentences: why the prices are inconsistent, i.e. where the money comes from. */
export function profitSource(opp, ev) {
  const L = opp.legs;
  const px = L.map(l => l.levels[0]?.price ?? 0);
  const perSet = ev.qty ? ev.cost / ev.qty : null;
  let why = '';
  switch (opp.type) {
    case 'ladder': {
      const a = outcomeOf(L[0]), b = outcomeOf(L[1]);
      const bid = opp.violation?.narrowerYesBid ?? (1 - px[1]);
      why = `“${b}” can only happen if “${a}” also happens, so it can never be more likely. But Kalshi prices “${b}” at ${cents(bid)} and “${a}” at only ${cents(px[0])}. ` +
        `Buying the cheap one and betting against the expensive one covers every possible result.`;
      break;
    }
    case 'bracket-all-yes':
      why = `Exactly one of these ${L.length} brackets must win, so one YES on each is worth exactly $1. Their prices add up to ${cents(px.reduce((s, p) => s + p, 0))}, less than $1.`;
      break;
    case 'outcomes-no-set': {
      const yesSum = L.reduce((s, l, i) => s + (1 - px[i]), 0);
      why = `At most one of these outcomes can win, so their YES prices should add up to $1 or less. They add up to ${cents(yesSum)}, which makes their NO contracts too cheap.`;
      break;
    }
    case 'yes-plus-no':
      why = 'YES and NO on the same contract always pay exactly $1 together, but right now they cost less than that.';
      break;
  }
  const math = perSet == null ? '' :
    ` Each set costs ${cents(perSet)} including fees and is guaranteed to pay back at least $${opp.minPayoff}: ` +
    `${cents(opp.minPayoff - perSet)} per set × ${ev.qty} sets = ${money(ev.profitWorst)} locked in.`;
  return why + math;
}

// ---------------------------------------------------------------------------
// Kalshi + options (Robinhood) hedges
// ---------------------------------------------------------------------------
const num = (x, d = 0) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d });
const px = x => (x >= 1000 ? num(x) : num(x, 2));
const pctP = p => (p == null ? '?' : p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${(p * 100).toFixed(0)}%`);

/** Where the underlying has to be for the option side to pay in full, in the underlying's own units. */
function optionPayZone(opp) {
  const u = opp.underlying, s = opp.spread;
  const lvl = s.underlyingEquivalent;
  const approx = u.index ? '' : 'about ';
  return s.type === 'call' ? `${u.name} at ${approx}$${px(lvl)} or above` : `${u.name} at ${approx}$${px(lvl)} or below`;
}

export function optionsSides(opp, ev) {
  const k = opp.kalshi, s = opp.spread, n = ev.spreads, nk = ev.qty;
  const avg = ev.kalshiAvg ?? k.levels[0].price, worst = ev.kalshiWorst ?? avg;
  const kPrice = Math.abs(worst - avg) > 1e-9 ? `at up to ${cents(worst)} each (average ${cents(avg)})` : `at ${cents(avg)} each`;
  return [
    { venue: 'Kalshi', side: k.side, url: k.url, copy: `${k.side} — ${k.name} (${k.ticker})`, how: k.pick,
      text: `Buy ${nk.toLocaleString()} ${k.side} contracts of “${k.name}” on Kalshi ${kPrice}.`,
      pays: `pays $1 each ($${num(nk)} total) if the result is ${k.region}`,
      cost: ev.kalshiCost + ev.kalshiFee, fee: ev.kalshiFee },
    { venue: 'Robinhood', side: s.type === 'call' ? 'CALL SPREAD' : 'PUT SPREAD', url: s.robinhoodUrl,
      copy: `Buy ${n} ${s.legs.buy}, sell ${n} ${s.legs.sell}`, how: s.robinhoodHow,
      text: `Buy ${n} ${s.legs.buy} at ${cents(s.buy.price)} and sell ${n} ${s.legs.sell} at ${cents(s.sell.price)}: a $${px(s.width)}-wide ${s.type} spread for ${cents(s.debit)} per share ($${num(s.debit * 100, 2)} per spread).`,
      pays: `pays $${num(100 * s.width, 2)} per spread ($${num(nk)} total) if ${s.paysWhen} (${optionPayZone(opp)})`,
      cost: ev.optionCost, fee: ev.fees - ev.kalshiFee },
  ];
}

export function optionsScenarios(opp, ev) {
  const u = opp.underlying.name, k = opp.kalshi, nk = ev.qty, s = opp.spread;
  const K = `$${px(k.strike)}`, Z = `$${px(s.underlyingEquivalent)}`;
  const approx = opp.underlying.index ? '' : 'about ';
  const kalshiSide = k.paysAbove ? `above ${K}` : `at or below ${K}`;
  const otherSide = k.paysAbove ? `at or below ${K}` : `above ${K}`;
  const lo = k.paysAbove ? K : `${approx}${Z}`, hi = k.paysAbove ? `${approx}${Z}` : K;
  const rows = [
    { when: `${u} ends ${kalshiSide}`, kalshi: nk, options: 0, total: nk, note: 'Side 1 pays' },
    { when: `${u} ends ${otherSide}`, kalshi: 0, options: nk, total: nk, note: 'Side 2 pays' },
    { when: `${u} ends between ${lo} and ${hi}`, kalshi: nk, options: '0 to ' + num(nk), total: `${num(nk)}–${num(2 * nk)}`, note: 'both pay: bonus', bonus: true },
  ];
  if (opp.sim.pUnderOne > 0.0005) {
    const gapTxt = Math.abs(opp.gapHours) > 48 ? `${Math.round(Math.abs(opp.gapHours) / 24)} days` : `${Math.round(Math.abs(opp.gapHours))} hours`;
    const optDate = new Date(s.expiryTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const kDate = new Date(k.refTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const zoneOff = s.type === 'call' ? `below ${approx}${Z}` : `above ${approx}${Z}`;
    let when;
    if (Math.abs(opp.gapHours) <= 1) when = `${opp.underlying.etf} drifts away from ${u} right at the strike`;
    else if (opp.gapHours < 0) when = `${u} is ${zoneOff} when the options expire (${optDate}), then moves ${otherSide} by Kalshi's settle (${kDate}, ${gapTxt} later)`;
    else when = `${u} ends ${otherSide} at Kalshi's settle (${kDate}), then moves back ${zoneOff} before the options expire (${optDate}, ${gapTxt} later)`;
    rows.push({ when, kalshi: 0, options: '0 to ' + num(nk), total: `0–${num(nk)}`, note: `timing risk: ${(opp.sim.pUnderOne * 100).toFixed(1)}% chance (simulated)`, risk: true });
  }
  return rows;
}

export function optionsProfitSource(opp, ev) {
  const k = opp.kalshi, p = opp.perUnit;
  const yesK = k.side === 'YES' ? opp.probs.kalshi : 1 - opp.probs.kalshi;
  const yesO = opp.probs.options == null ? null : (k.side === 'YES' ? opp.probs.options : 1 - opp.probs.options);
  return `Kalshi prices “${k.outcome}” at ${pctP(yesK)}, while ${opp.underlying.etf} options price it at ${pctP(yesO)}. ` +
    `You buy each side where it's cheaper: Kalshi ${k.side} costs ${cents(p.kalshi)} per $1 (incl. fees) and the option spread costs ${cents(p.option)} per $1. ` +
    `Together that's ${cents(p.total)} for a payout of $1 in every normal outcome, so ${cents(p.tailEdge)} per $1 × ${num(ev.qty)} = ${money(ev.tailProfit)} is locked in unless the timing risk hits.`;
}
