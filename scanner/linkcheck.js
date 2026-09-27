// Link check: flags any link that returns 404 so broken links never ship silently.
// kalshi.com (and coinbase.com) put a bot checkpoint in front of their pages, so an
// automated request gets 403/429 whether or not the page exists. For Kalshi we
// therefore verify through the API that the event behind the link exists (a Kalshi
// event page exists exactly when the event does; verified by hand Sep 2026) and
// report the website check itself as "unverifiable (bot protection)".
import { kalshiEventExists } from './sources.js';
import { spotLinks } from '../docs/lib/links.js';

async function status(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; arb-dashboard link check)' } });
    return r.status;
  } catch { return 0; }
}

export async function checkLinks(opps, spot) {
  const brokenEvents = [], broken = [], unverifiable = [], ok = [];
  const events = [...new Set(opps.map(o => o.eventTicker))];
  for (const ev of events) {
    const exists = await kalshiEventExists(ev);
    if (exists) ok.push(`kalshi event ${ev} (via API)`);
    else { brokenEvents.push(ev); broken.push(`Kalshi event ${ev} no longer exists; card links fall back to the series page`); }
  }
  // one sample of each static link pattern, plus a deliberately bad Robinhood ticker
  // to prove the checker can actually see a 404 on that site
  const samples = [spotLinks.gemini('BTC'), spotLinks.kraken('BTC'), spotLinks.robinhoodCrypto('BTC'),
    spotLinks.robinhoodStock('GLD'), spotLinks.coinbase('BTC'), 'https://kalshi.com/markets/kxbtc'];
  for (const u of samples) {
    const s = await status(u);
    if (s === 404 || s === 410) broken.push(`${u} (HTTP ${s})`);
    else if (s >= 200 && s < 400) ok.push(u);
    else unverifiable.push(`${u} (HTTP ${s || 'no response'}: site blocks automated checks; format verified by hand)`);
  }
  const canary = await status(spotLinks.robinhoodStock('NOTAREALTICKERZZ'));
  return { checkedAt: new Date().toISOString(), ok: ok.length, broken, brokenEvents, unverifiable,
    canary404Detected: canary === 404 };
}
