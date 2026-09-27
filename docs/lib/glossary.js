// Plain-English definitions shown in the (?) tooltips.
export const GLOSSARY = {
  'arbitrage': 'Buying and selling related things at the same time so you make money no matter what happens. Real arbitrage is rare and usually small.',
  'locked-in arbitrage': 'A set of trades that pays more than it costs in every possible outcome, after fees. The only risks left are the platform failing, a rule surprise, or prices moving before you finish buying every leg.',
  'positive expected value': 'On average this trade makes money if the probabilities are right, but any single time it can lose. Like a casino edge, you need many trades for it to show up.',
  'expected value': 'The average result if you could repeat the trade many times: each possible payout times its probability, minus the cost.',
  'yes/no contract': 'A Kalshi contract that pays $1 if the event happens (YES) or $1 if it doesn\'t (NO). The price in cents is roughly the market\'s probability. YES price + NO price is about $1.',
  'implied probability': 'The probability a price suggests. A YES contract at 40¢ implies about a 40% chance, because it pays $1.',
  'spread': 'The gap between the best price to buy (ask) and the best price to sell (bid). You pay the ask when you buy right away, so the spread is a hidden cost.',
  'ask': 'The cheapest price someone is currently willing to sell at. Buying immediately means paying the ask.',
  'bid': 'The highest price someone is currently willing to pay.',
  'slippage': 'Getting a worse price than you saw because the cheapest offers ran out and your order moved up to the next price level.',
  'order book depth': 'How many contracts are for sale at each price. Thin depth means only a few contracts exist at the price shown.',
  'settlement': 'When the event is decided and winning contracts pay out $1. Your money is tied up until then.',
  'annualized return': 'The return scaled to one year so trades of different lengths can be compared. 2% in 1 month ≈ 24% a year. Simple scaling, no compounding.',
  't-bill rate': 'What 3-month U.S. Treasury bills pay: the near-risk-free return you get for doing nothing. A trade that can\'t clearly beat it isn\'t worth the effort or risk.',
  'cash hurdle': 'The minimum annualized return a trade must beat: the T-bill rate plus a margin for effort and the risks that remain.',
  'ladder': 'A set of Kalshi contracts on the same thing at different levels ("BTC above 100k", "above 105k"...). A higher level can never be more likely than a lower one.',
  'bracket': 'A set of Kalshi ranges ("BTC between 100k and 105k") where exactly one range wins. Their prices should add up to about $1.',
  'mutually exclusive': 'At most one of the outcomes can happen.',
  'basis': 'The gap between a futures price and the spot (today\'s) price.',
  'contango': 'When futures trade above spot. It lets you buy spot and sell the future to lock in the gap (cash-and-carry).',
  'cash-and-carry': 'Buy the asset now, sell a future on it at a higher price, deliver/close at expiry, and keep the difference, minus fees and financing.',
  'margin': 'Money a futures broker makes you set aside as a safety deposit. If the trade moves against you, you may have to add more.',
  'liquidation': 'If your margin runs too low, the broker closes your position for you, often at a bad price, which can break a "locked" trade.',
  'nav': 'Net asset value: what a fund\'s holdings are actually worth per share.',
  'premium/discount': 'How far a fund\'s market price is above (premium) or below (discount) the value of what it holds.',
  'fees': 'Kalshi charges takers 0.07 × contracts × price × (1 − price), rounded up (July 2026 schedule). Highest at 50¢, tiny near 1¢ or 99¢. Settlement is free.',
  'set': 'One contract of every leg in the trade. The trade is sized in sets so each leg has the same count.',
  'confidence': 'How much to trust the numbers: high means full order books, active markets and plenty of time; low means something looks stale, thin or unverifiable.',
  'worst case': 'Profit in the least favorable outcome, after all fees.',
  'max loss': 'The most you can lose on the trade as quoted. For a locked trade this is $0 unless something outside the market goes wrong.',
};

export function tip(term, label) {
  const key = term.toLowerCase();
  const def = GLOSSARY[key];
  if (!def) return label ?? term;
  return `${label ?? term}<button type="button" class="tip" aria-label="What is ${escapeHtml(term)}?" data-tip="${escapeHtml(def)}">?</button>`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
