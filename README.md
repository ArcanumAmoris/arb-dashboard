# Arb Desk

A free, read-only dashboard that scans US-regulated markets for arbitrage and mispricing, tells you exactly what to buy, and says whether it's worth it after every fee and against T-bills.

- **Cost:** $0. Public GitHub repo + GitHub Actions + GitHub Pages. No paid APIs, no API keys.
- **Read-only:** never logs in to or trades on any account.
- **Setup:** see [SETUP.md](SETUP.md).

## Stages

| Stage | Contents | Status |
|---|---|---|
| 1 | Kalshi bracket / ladder / NO-set / YES+NO scanner · crypto & metals spot · cards with exact instructions and deep links · cash-hurdle (T-bill) comparison · email alerts · link check | **built** |
| 2 | Kalshi vs spot (lognormal model) · metal ETFs vs NAV / spot | next |
| 3 | Crypto futures basis · Fed & economic contracts vs futures | later |
| 4 | Paper-trade log · opportunity lifespan log | optional |

## Layout

```
config/settings.json      thresholds, alert rules, scan settings (edit these)
docs/                     the website (GitHub Pages serves this folder)
  index.html app.js         dashboard
  how.html platforms.html   explanations
  lib/math.js               ALL money math: fees, order-book fills, sizing, annualizing, verdicts
  lib/links.js              deep-link formats (verified by hand)
  lib/format.js             instruction wording shared by cards and emails
scanner/                  runs in GitHub Actions
  run.js                    fetch → detect → re-price on full order books → data.json
  detect.js                 Kalshi consistency checks (pure functions)
  sources.js                Kalshi, Coinbase, Gemini, Kraken, gold-api, Treasury/FRED
  linkcheck.js              flags 404s
  alerts.js alertRules.js email.js testEmail.js
test/                     unit tests with worked examples (npm test)
.github/workflows/        scan (every 10 min), send test email, tests
```

The dashboard and the scanner import the same `docs/lib/math.js`, so a card and an email can never disagree.

## Run locally

```bash
npm ci
npm test                         # 43 tests
node scanner/run.js --out out    # live scan → out/data.json (~45 s)
node scanner/alerts.js --dry-run --prev none
cp out/data.json docs/ && npx serve docs   # then open the printed URL
```

Not financial advice. Prices move fast. Verify on the platform before trading.
