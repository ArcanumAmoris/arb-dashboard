#!/usr/bin/env bash
# Publish out/data.json + out/state/alerts.json to the `data` branch as ONE orphan
# commit, force-pushed, so git history never grows.
set -euo pipefail
cd out
if [ ! -f state/alerts.json ]; then
  mkdir -p state
  cp ../prev/state/alerts.json state/alerts.json 2>/dev/null || echo '{"sent":{},"daily":{}}' > state/alerts.json
fi
rm -rf .git
git init -q -b data
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -qm "data $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
echo "Published data.json"
