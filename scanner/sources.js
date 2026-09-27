// Every free data source the scanner uses. No API keys needed for any of them.
import { getJson, getText } from './http.js';
import { discountToInvestmentYield } from '../docs/lib/math.js';

export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

// ---- Kalshi (public market data, no login) --------------------------------
export async function kalshiSeriesMap(categories, gapMs) {
  const map = new Map();
  for (const c of categories) {
    const d = await getJson(`${KALSHI}/series?category=${encodeURIComponent(c)}`, { gapMs });
    for (const s of d.series || []) map.set(s.ticker, s);
  }
  return map;
}

export async function kalshiOpenEvents({ categories, excludeCategories, gapMs }) {
  const out = [];
  let cursor = '', pages = 0;
  do {
    const d = await getJson(`${KALSHI}/events?status=open&limit=200&with_nested_markets=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { gapMs });
    pages++;
    for (const e of d.events || []) {
      if (excludeCategories.includes(e.category)) continue;
      if (categories.includes(e.category)) out.push(e);
    }
    cursor = d.cursor;
    if (!(d.events || []).length) break;
  } while (cursor && pages < 200);
  return { events: out, pages };
}

export async function kalshiOrderbook(ticker, gapMs) {
  return getJson(`${KALSHI}/markets/${encodeURIComponent(ticker)}/orderbook`, { gapMs });
}

export async function kalshiEventExists(eventTicker) {
  try { await getJson(`${KALSHI}/events/${encodeURIComponent(eventTicker)}`, { gapMs: 150, retries: 2 }); return true; }
  catch (e) { if (e.status === 404) return false; throw e; }
}

// ---- Crypto spot (public tickers) ------------------------------------------
export const CRYPTO = [
  { base: 'BTC', name: 'Bitcoin', coinbase: 'BTC-USD', gemini: 'btcusd', kraken: 'XBTUSD' },
  { base: 'ETH', name: 'Ethereum', coinbase: 'ETH-USD', gemini: 'ethusd', kraken: 'ETHUSD' },
  { base: 'SOL', name: 'Solana', coinbase: 'SOL-USD', gemini: 'solusd', kraken: 'SOLUSD' },
  { base: 'XRP', name: 'XRP', coinbase: 'XRP-USD', gemini: 'xrpusd', kraken: 'XRPUSD' },
  { base: 'DOGE', name: 'Dogecoin', coinbase: 'DOGE-USD', gemini: 'dogeusd', kraken: 'XDGUSD' },
];

async function coinbase(p) {
  const d = await getJson(`https://api.exchange.coinbase.com/products/${p}/ticker`, { gapMs: 120, retries: 2 });
  return { bid: +d.bid, ask: +d.ask, last: +d.price, time: d.time };
}
async function gemini(p) {
  const d = await getJson(`https://api.gemini.com/v1/pubticker/${p}`, { gapMs: 120, retries: 2 });
  return { bid: +d.bid, ask: +d.ask, last: +d.last, time: new Date(d.volume.timestamp).toISOString() };
}
async function kraken(p) {
  const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${p}`, { gapMs: 120, retries: 2 });
  if (d.error?.length) throw new Error(d.error.join(','));
  const t = Object.values(d.result)[0];
  return { bid: +t.b[0], ask: +t.a[0], last: +t.c[0], time: new Date().toISOString() };
}

export async function cryptoSpot() {
  const rows = [], errors = [];
  for (const c of CRYPTO) {
    for (const [venue, fn, pair] of [['Coinbase', coinbase, c.coinbase], ['Gemini', gemini, c.gemini], ['Kraken', kraken, c.kraken]]) {
      try { rows.push({ asset: c.base, name: c.name, venue, ...(await fn(pair)) }); }
      catch (e) { errors.push(`${venue} ${c.base}: ${e.message}`); }
    }
  }
  return { rows, errors };
}

// ---- Metals spot: gold-api.com (free, no key, CORS enabled) -----------------
export const METALS = [
  { symbol: 'XAU', name: 'Gold' }, { symbol: 'XAG', name: 'Silver' }, { symbol: 'XPT', name: 'Platinum' },
];
export async function metalsSpot() {
  const rows = [], errors = [];
  for (const m of METALS) {
    try {
      const d = await getJson(`https://api.gold-api.com/price/${m.symbol}`, { gapMs: 200, retries: 2 });
      rows.push({ asset: m.symbol, name: m.name, venue: 'gold-api.com', last: +d.price, time: d.updatedAt });
    } catch (e) { errors.push(`gold-api ${m.symbol}: ${e.message}`); }
  }
  return { rows, errors };
}

// ---- Risk-free rate ---------------------------------------------------------
// Primary: U.S. Treasury "Daily Treasury Bill Rates" CSV (13-week coupon-equivalent
// yield). Free, no key, published each business day after 3:30pm ET.
// Backup: FRED DTB3 (same bill, bank-discount basis, ~1 extra day of lag).
const PLAIN_UA = { 'User-Agent': 'curl/8.5.0' }; // both sites reject some custom agents
export async function tbillRate() {
  try { return await treasuryBill(); }
  catch (e) {
    const r = await fredBill();
    r.note = `Treasury.gov failed (${e.message}); using FRED backup`;
    return r;
  }
}

export async function treasuryBill() {
  const year = new Date().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_bill_rates&field_tdr_date_value=${year}&page&_format=csv`;
  const csv = await getText(url, { gapMs: 200, retries: 1, timeoutMs: 60000, headers: PLAIN_UA }); // this server is slow (~20s)
  return parseTreasuryCsv(csv);
}

export function parseTreasuryCsv(csv) {
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const ci = head.indexOf('13 WEEKS COUPON EQUIVALENT'), di = head.indexOf('13 WEEKS BANK DISCOUNT');
  if (ci < 0) throw new Error('Treasury CSV format changed (no 13-week column)');
  for (const l of lines.slice(1)) {         // newest first
    const c = l.split(',');
    const y = parseFloat(c[ci]);
    if (Number.isFinite(y)) {
      const [m, d, yr] = c[0].split('/');
      return { yieldPct: y, discountPct: parseFloat(c[di]) || null, asOf: `${yr}-${m}-${d}`, source: 'U.S. Treasury daily bill rates (13-week, coupon equivalent)' };
    }
  }
  throw new Error('Treasury CSV had no 13-week values');
}

export async function fredBill() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd=${since}`, { gapMs: 200, retries: 2, timeoutMs: 30000, headers: PLAIN_UA });
  const rows = csv.trim().split('\n').slice(1).map(l => l.split(',')).filter(([, v]) => v && v !== '.' && !isNaN(+v));
  if (!rows.length) throw new Error('FRED returned no recent DTB3 values');
  const [date, v] = rows[rows.length - 1];
  const discount = +v;
  return { discountPct: discount, yieldPct: +discountToInvestmentYield(discount).toFixed(3), asOf: date, source: 'FRED DTB3 (converted from bank-discount to investment yield)' };
}
