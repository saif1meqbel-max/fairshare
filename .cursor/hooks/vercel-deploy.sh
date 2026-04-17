#!/usr/bin/env bash
# Deploy current working tree to Vercel production (used by Cursor stop hook and git post-commit).
set +e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 0
command -v npx >/dev/null 2>&1 || exit 0
npx vercel deploy --prod --yes
exit 0
