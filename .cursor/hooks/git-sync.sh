#!/usr/bin/env bash
# Consumes hook JSON on stdin (ignored). Commits + pushes when there are staged changes.
set -euo pipefail
cat >/dev/null 2>&1 || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Canonical app is fairshare.html; index.html is for GitHub Pages and must match before commit.
if [[ -f fairshare.html ]]; then
  cp -f fairshare.html index.html
fi

git add -A
if git diff --staged --quiet; then
  exit 0
fi

git commit -m "chore: sync $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin main
