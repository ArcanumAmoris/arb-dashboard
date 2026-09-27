// Deep-link builders. Formats verified September 2026:
//  - Kalshi: https://kalshi.com/markets/{series}/{any-slug}/{event} opens the exact
//    event page (the slug is cosmetic; Kalshi rewrites it). A bad ticker shows
//    "Page not found". https://kalshi.com/markets/{series} redirects to the series'
//    current event and is the fallback. Kalshi can't deep-link a single strike, so
//    each leg also spells out which row and side to press.
//  - Coinbase Advanced: /advanced-trade/spot/{BASE}-USD
//  - Gemini: exchange.gemini.com/trade/{BASE}USD
//  - Kraken Pro: pro.kraken.com/app/trade/{base}-usd   (price reference only: Kraken blocks NY residents)
//  - Robinhood: robinhood.com/us/en/stocks/{TICKER}/ and /crypto/{BASE}/ (a bad ticker returns 404)

export function slugify(s = '') {
  return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'market';
}

export function kalshiEventUrl(seriesTicker, eventTicker, seriesTitle) {
  if (!seriesTicker || !eventTicker) return kalshiSeriesUrl(seriesTicker);
  return `https://kalshi.com/markets/${seriesTicker.toLowerCase()}/${slugify(seriesTitle)}/${eventTicker.toLowerCase()}`;
}

export function kalshiSeriesUrl(seriesTicker) {
  return seriesTicker ? `https://kalshi.com/markets/${seriesTicker.toLowerCase()}` : 'https://kalshi.com/markets';
}

export const spotLinks = {
  coinbase: base => `https://www.coinbase.com/advanced-trade/spot/${base.toUpperCase()}-USD`,
  gemini: base => `https://exchange.gemini.com/trade/${base.toUpperCase()}USD`,
  kraken: base => `https://pro.kraken.com/app/trade/${base.toLowerCase()}-usd`,
  robinhoodCrypto: base => `https://robinhood.com/us/en/crypto/${base.toUpperCase()}/`,
  robinhoodStock: ticker => `https://robinhood.com/us/en/stocks/${ticker.toUpperCase()}/`,
};
