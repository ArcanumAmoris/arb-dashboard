#!/usr/bin/env bash
# Runs inside GitHub Actions. GitHub's cron often starts late or skips runs, so each
# run keeps scanning every 10 minutes by itself for ~LOOP_MINUTES, and the next run
# waits in the queue behind it (see concurrency in scan.yml). Result: a steady
# 10-minute cadence even when the scheduler misbehaves. Public repos: minutes are free.
set -u
# Everything runs inside main(), which bash reads completely before starting, so pulling
# a newer copy of this file mid-run is safe.
main() {
LOOP_MINUTES="${LOOP_MINUTES:-55}"
END=$(( $(date +%s) + LOOP_MINUTES * 60 ))
i=0
while :; do
  i=$((i + 1)); start=$(date +%s)
  echo "::group::Scan $i ($(date -u +%H:%M:%SZ))"
  # pick up code/config pushed since this run started
  if [ "$i" -gt 1 ] && git fetch -q origin main 2>/dev/null; then
    before=$(git rev-parse HEAD); git reset -q --hard FETCH_HEAD; after=$(git rev-parse HEAD)
    if [ "$before" != "$after" ]; then
      echo "Updated code to ${after:0:7}"
      if ! git diff --quiet "$before" "$after" -- package-lock.json; then npm ci --no-audit --no-fund -q; fi
    fi
  fi
  mkdir -p prev/state
  rm -f prev/state/alerts.json
  if git fetch -q --depth=1 origin data 2>/dev/null; then
    git show origin/data:state/alerts.json > prev/state/alerts.json 2>/dev/null || rm -f prev/state/alerts.json
  fi
  rm -rf out
  if node scanner/run.js --out out; then
    node scanner/alerts.js --data out/data.json --prev prev/state/alerts.json --out out/state/alerts.json \
      || echo "::warning::Email alert step failed (see log above)"
    bash scanner/publish.sh || echo "::warning::Publishing to the data branch failed"
  else
    echo "::warning::Scan $i failed; the dashboard keeps the previous data and shows its age"
  fi
  echo "::endgroup::"
  next=$(( start + 600 ))
  if [ "$next" -ge "$END" ]; then break; fi
  wait_s=$(( next - $(date +%s) ))
  if [ "$wait_s" -gt 0 ]; then sleep "$wait_s"; fi
done
echo "Finished $i scans."
}
main "$@"; exit
