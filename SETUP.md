# Setup: click by click (about 15 minutes, $0)

Everything runs on GitHub's free tier: a **public** repository gets unlimited free Actions minutes and free GitHub Pages hosting. No credit card is needed anywhere. None of the data sources needs an API key.

What you'll end up with:

- a website at `https://YOUR-USERNAME.github.io/arb-dashboard/`
- a scan every ~10 minutes that updates it
- email alerts from your own Gmail to yourself

---

## 1. Create the repository

1. Sign in at **github.com** (create a free account if you don't have one).
2. Go to **github.com/new**.
3. **Repository name:** `arb-dashboard`
4. Choose **Public**. It must be public for free Actions minutes and free Pages. Your email address never goes in the code; it lives in a Secret (step 4).
5. Leave "Add a README", ".gitignore" and "license" **unticked**.
6. Click **Create repository**.

## 2. Put the code in it

Pick one:

**A. Let Claude push it.** After step 1, tell Claude "the repo is created". It can push everything directly.

**B. Upload in the browser.**
1. Unzip `arb-dashboard.zip` on your computer.
2. On the new repo page, click **uploading an existing file**.
3. Open the unzipped `arb-dashboard` folder and drag **everything inside it** into the upload box: `config`, `docs`, `scanner`, `test`, `package.json`, `package-lock.json`, `SETUP.md`, `README.md`, and the hidden `.github` folder.
   - On a Mac the `.github` folder is hidden. In Finder press **Cmd + Shift + .** (period) to show it.
   - On Windows: File Explorer → **View** → tick **Hidden items**.
4. Click **Commit changes**.
5. Check that the repo now shows a `.github/workflows` folder. Without it, nothing will run.

**C. Command line** (if you use git):
```bash
cd arb-dashboard
git init -b main && git add -A && git commit -m "Arb Desk stage 1"
git remote add origin https://github.com/YOUR-USERNAME/arb-dashboard.git
git push -u origin main
```

## 3. Let the workflow write the data branch

1. In the repo, click **Settings** (top bar) → **Actions** → **General** (left sidebar).
2. Scroll to **Workflow permissions** → select **Read and write permissions** → **Save**.

## 4. Email alerts: a Gmail app password plus 3 Secrets

Alerts are sent from your Gmail to yourself using Gmail SMTP, which is free. Google needs an **app password** for this (a separate 16-character password only this app uses). Your normal password is never used.

**Get the app password (2 minutes):**
1. Go to **myaccount.google.com/security**. Make sure **2-Step Verification** is **On**; app passwords require it.
2. Go to **myaccount.google.com/apppasswords**.
3. App name: `Arb Desk` → **Create**.
4. Copy the 16-character password shown (spaces don't matter). You won't see it again. If you lose it, delete it and make a new one.

**Add the Secrets** (they are encrypted; never visible in the code, logs or website):
1. Repo **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add these three, one at a time (Name, then Secret, then **Add secret**):

| Name | Secret |
|---|---|
| `GMAIL_USER` | your Gmail address (the sender) |
| `GMAIL_APP_PASSWORD` | the 16-character app password |
| `ALERT_TO_EMAIL` | where alerts should go (e.g. the same Gmail) |

## 5. Run the first scan

1. Click the **Actions** tab. If GitHub shows *"Workflows aren't being run on this repository"*, click **I understand my workflows, go ahead and enable them**.
2. In the left list click **Scan** → **Run workflow** (right side) → **Run workflow**.
3. Wait about 1–2 minutes for a green check. This creates the `data` branch holding `data.json`.
   - A red X? Click the run and then the failed step to see the error. See Troubleshooting below.

## 6. Turn on the website (GitHub Pages)

1. Repo **Settings** → **Pages** (left sidebar).
2. **Source:** `Deploy from a branch`.
3. **Branch:** `main`, folder: **`/docs`** → **Save**.
4. Wait 1–2 minutes and refresh the Settings → Pages screen. It shows **"Your site is live at https://YOUR-USERNAME.github.io/arb-dashboard/"**. Open it and bookmark it.

## 7. Send a test email

1. **Actions** tab → **Send test email** (left list) → **Run workflow** → **Run workflow**.
2. Within a minute you should get "Arb Scanner: test email ✔". Check spam the first time and mark it "Not spam".

That's it. The **Scan** workflow now runs on its own and refreshes the data about every 10 minutes. Pushing a change to the scanner or config also starts a scan right away.

---

## Changing settings

All thresholds live in **`config/settings.json`**. On GitHub, open the file → pencil icon (**Edit**) → change a number → **Commit changes**. The next scan uses it.

- **Turn email alerts off:** set `"enabled": false` under `"alerts"`.
- **Alert rules:** `tier1MinAnnualizedPct` (locked-in trades, default 12 = 3% per 3 months), `tier2MinAnnualizedPct` (can-lose trades, default 40), `minFillDollars` (100), `maxEmailsPerDay` (5), `reAlertImprovementPct` (25), `tooGoodReturnPct` (25).
- **Card verdicts:** `minProfit`, `minReturnPct`, `lockedMarginPct` (how far above T-bills counts as "clearly beats"). You can also change these per browser in the dashboard's "Verdict thresholds" box.

## How the pieces fit

- `main` branch: the code and the website (`docs/`).
- `data` branch: only `data.json` + `state/alerts.json` (which alerts were already sent). Every scan replaces it with one fresh commit, so history never grows.
- The website reads `data.json` straight from the `data` branch. It is **read-only** and never logs in to any account.

## Troubleshooting

- **How the 10-minute refresh works.** GitHub's scheduler often starts jobs late or skips them, so each Scan run keeps scanning every 10 minutes by itself for about 55 minutes and queues the next run as soon as it starts. To stop all scanning: Actions → Scan → “…” → **Disable workflow**. In the Actions tab you'll see one long Scan run at a time; an occasional "cancelled" run is just a spare queued run being replaced. That's normal.
- **Data is older than 10 minutes.** Usually a slow scan or a short gap between runs. The page shows the true age and turns red past 25 minutes.
- **Scan failed at "Publish to the data branch".** Redo step 3 (Read and write permissions).
- **Test email failed with "Invalid login" / 535.** The app password is wrong or 2-Step Verification is off. Make a new app password and update the `GMAIL_APP_PASSWORD` secret (Settings → Secrets → pencil icon).
- **Test email failed with "Email secrets missing".** A secret name is misspelled. The names must match exactly: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ALERT_TO_EMAIL`.
- **Website says "No data published yet."** Run the Scan workflow once (step 5).
- **Website shows 404.** Check Settings → Pages uses branch `main` and folder `/docs`.
- **Scans stopped.** GitHub pauses scheduled workflows in public repos after 60 days without repository activity. If the Actions tab shows a banner about it, click **Enable workflow**.
- **Too many emails?** Lower `maxEmailsPerDay` or raise the tier thresholds.
