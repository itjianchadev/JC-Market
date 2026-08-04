#!/usr/bin/env bash
#
# Deploy JC-Market / TMS on the DigitalOcean droplet.
#
# Run this ON the droplet (not from your laptop):
#     bash /opt/jc-market/deploy.sh
#
# What it does, in order:
#   1. Backs up the live SQLite DB (safe .backup, never a raw copy)
#   2. Pulls the target branch (fast-forward only — aborts on divergence)
#   3. npm install (rebuilds better-sqlite3 if Node/deps changed)
#   4. Restarts via pm2 (migrations run themselves on boot — idempotent)
#   5. Health-checks /api/health and fails loudly if the server didn't come up
#
# Override defaults with env vars, e.g.:
#     JC_DEPLOY_BRANCH=main JC_APP_DIR=/root/jc-market bash deploy.sh
#
# Redeploy the SANDBOX instance with the same script:
#     JC_APP_NAME=jc-market-sandbox JC_APP_DIR=/var/www/jc-market-sandbox \
#     JC_DEPLOY_BRANCH=main PORT=3864 JC_ECOSYSTEM=ecosystem.sandbox.config.js bash deploy.sh
#
set -euo pipefail

APP_NAME="${JC_APP_NAME:-jc-market}"
APP_DIR="${JC_APP_DIR:-/opt/jc-market}"
BRANCH="${JC_DEPLOY_BRANCH:-main}"
PORT="${PORT:-3863}"
ECOSYSTEM="${JC_ECOSYSTEM:-ecosystem.config.js}"

log()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || fail "No git repo at $APP_DIR — set JC_APP_DIR to the app path."
cd "$APP_DIR"
log "Deploying '$APP_NAME' — branch '$BRANCH' in $APP_DIR"

# ── 1. Backup the live DB before touching anything ──────────────────────────
if [ -f data/stock-market.db ]; then
  mkdir -p data/backups
  TS="$(date +%Y%m%d-%H%M%S)"
  # .backup takes a consistent snapshot even while the server is writing.
  sqlite3 data/stock-market.db ".backup 'data/backups/stock-market-$TS.db'" \
    && log "DB backed up → data/backups/stock-market-$TS.db" \
    || log "WARN: DB backup failed (sqlite3 installed? continuing anyway)"
  # Keep the 30 most recent backups; prune the rest.
  ls -1t data/backups/stock-market-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f
fi

# ── 2. Pull code ────────────────────────────────────────────────────────────
log "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH" || fail "Non-fast-forward — local branch diverged. Resolve manually."

# ── 3. Dependencies (production only; marked is a dev-only tool) ─────────────
log "Installing dependencies"
mkdir -p logs data
npm install --omit=dev

# ── 4. (Re)start under pm2 ──────────────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  fail "pm2 not installed. Run: npm install -g pm2"
fi
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "Restarting pm2 process"
  pm2 restart "$APP_NAME" --update-env
else
  log "Starting pm2 process for the first time"
  pm2 start "$ECOSYSTEM"
  pm2 save
fi

# ── 5. Health check ─────────────────────────────────────────────────────────
log "Health check → http://localhost:$PORT/api/health"
ok=""
for i in $(seq 1 10); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then ok="1"; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "Health check failed. Inspect: pm2 logs $APP_NAME --lines 50"

log "Done — '$APP_NAME' is live on port $PORT ✔"
