// Polite fetch: one request at a time per host, retries on 429/5xx with backoff.
const lastHit = new Map();

export async function getJson(url, { gapMs = 150, retries = 5, timeoutMs = 15000, headers = {} } = {}) {
  const r = await getRaw(url, { gapMs, retries, timeoutMs, headers });
  return JSON.parse(r.text);
}

export async function getText(url, opts = {}) {
  return (await getRaw(url, opts)).text;
}

export async function getRaw(url, { gapMs = 150, retries = 5, timeoutMs = 15000, headers = {} } = {}) {
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'arb-dashboard (read-only market scanner)', ...headers },
        signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${host}`);
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { status: res.status, noRetry: true });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      if (e.noRetry) throw e;
      lastErr = e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
