#!/usr/bin/env bash
# Cursor hook: drain hook JSON stdin, then deploy to Vercel.
cat >/dev/null 2>&1 || true
exec "$(dirname "$0")/vercel-deploy.sh"
