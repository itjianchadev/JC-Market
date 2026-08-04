#!/usr/bin/env bash
#
# One-shot SANDBOX setup for JC-Market — clones a SECOND instance of the app
# next to production on the SAME droplet, with its own port, .env and DB.
#
# Run ON the droplet (from the production checkout that has this script):
#     bash /var/www/jc-market/scripts/setup-sandbox.sh
#
# It is safe to re-run: an existing sandbox .env or DB is kept, never clobbered.
#
# Override any default via env vars:
#     JC_SANDBOX_DIR=/var/www/jc-market-sandbox   # where the sandbox lives
#     JC_PROD_DIR=/var/www/jc-market              # production checkout (for .env/DB source)
#     JC_SANDBOX_BRANCH=main                      # branch the sandbox runs
#     JC_SANDBOX_PORT=3864                        # sandbox HTTP port
#     JC_COPY_PROD_DB=ask|yes|no                  # seed sandbox DB from prod?
#
set -euo pipefail

SANDBOX_DIR="${JC_SANDBOX_DIR:-/var/www/jc-market-sandbox}"
PROD_DIR="${JC_PROD_DIR:-/var/www/jc-market}"
REPO="${JC_REPO:-https://github.com/itjianchadev/jc-market.git}"
BRANCH="${JC_SANDBOX_BRANCH:-main}"
PORT="${JC_SANDBOX_PORT:-3864}"
APP_NAME="jc-market-sandbox"
COPY_PROD_DB="${JC_COPY_PROD_DB:-ask}"

log()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

command -v git  >/dev/null || fail "git not installed"
command -v node >/dev/null || fail "node not installed"
command -v pm2  >/dev/null || fail "pm2 not installed — run: npm install -g pm2"

# ── 1. Clone (or update) the sandbox checkout ───────────────────────────────
if [ -d "$SANDBOX_DIR/.git" ]; then
  log "Sandbox checkout exists — pulling origin/$BRANCH"
  git -C "$SANDBOX_DIR" fetch origin "$BRANCH"
  git -C "$SANDBOX_DIR" checkout "$BRANCH"
  git -C "$SANDBOX_DIR" pull --ff-only origin "$BRANCH"
else
  log "Cloning $REPO → $SANDBOX_DIR (branch $BRANCH)"
  git clone --branch "$BRANCH" "$REPO" "$SANDBOX_DIR"
fi
cd "$SANDBOX_DIR"
mkdir -p data data/backups logs

# ── 2. Sandbox .env (create only if missing — never overwrite) ──────────────
if [ -f .env ]; then
  log ".env already exists — keeping it"
else
  log "Creating sandbox .env"
  if [ -f "$PROD_DIR/.env" ]; then cp "$PROD_DIR/.env" .env; else cp .env.example .env; fi
  set_kv() { # upsert KEY=VALUE into .env
    local k="$1" v="$2"
    if grep -qE "^${k}=" .env; then sed -i "s|^${k}=.*|${k}=${v}|" .env; else echo "${k}=${v}" >> .env; fi
  }
  # sandbox-only JWT secret (alphanumeric so it's sed-safe)
  NEWSECRET="sbx-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  set_kv PORT           "$PORT"
  set_kv JWT_SECRET     "$NEWSECRET"
  set_kv NODE_ENV       "development"          # keeps SlipOK optional (mock) in sandbox
  set_kv BC_ENVIRONMENT "Jiancha_develop"      # point at BC dev — never production BC
  set_kv SLIPOK_API_KEY ""                     # empty → SlipOK runs in mock (safe for testing)
  log "sandbox .env ready (PORT=$PORT · fresh JWT · BC dev · SlipOK mock)"
  log "   → review it if you need different BC creds: nano $SANDBOX_DIR/.env"
fi

# ── 3. Sandbox DB — fresh, or a snapshot of production ──────────────────────
if [ -f data/stock-market.db ]; then
  log "Sandbox DB already exists — keeping it"
else
  do_copy="$COPY_PROD_DB"
  if [ "$do_copy" = "ask" ]; then
    read -rp "Seed sandbox DB with a copy of PRODUCTION data? [y/N] " a || a="n"
    case "$a" in y|Y) do_copy=yes;; *) do_copy=no;; esac
  fi
  if [ "$do_copy" = "yes" ] && [ -f "$PROD_DIR/data/stock-market.db" ]; then
    command -v sqlite3 >/dev/null || fail "sqlite3 needed to copy prod DB (apt install -y sqlite3)"
    log "Copying production DB → sandbox (consistent .backup snapshot)"
    sqlite3 "$PROD_DIR/data/stock-market.db" ".backup '$SANDBOX_DIR/data/stock-market.db'"
    log "   ⚠️  sandbox now contains real production data — mind who can reach it (PDPA)"
  else
    log "Starting with a FRESH sandbox DB (seeded automatically on first boot)"
  fi
fi

# ── 4. Dependencies ─────────────────────────────────────────────────────────
log "npm install"
npm install --omit=dev

# ── 5. Start (or restart) the sandbox under pm2 ─────────────────────────────
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "Restarting pm2 '$APP_NAME'"
  pm2 restart "$APP_NAME" --update-env
else
  log "Starting pm2 '$APP_NAME'"
  pm2 start ecosystem.sandbox.config.js
  pm2 save
fi

# ── 6. Health check ─────────────────────────────────────────────────────────
ok=""
for i in $(seq 1 10); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || fail "Health check failed — inspect: pm2 logs $APP_NAME --lines 50"

cat <<EOF

────────────────────────────────────────────────────────────────
 ✔ Sandbox is UP
   URL (local):  http://localhost:$PORT
   pm2 process:  $APP_NAME
   Directory:    $SANDBOX_DIR
   Database:     $SANDBOX_DIR/data/stock-market.db   (separate from prod)

 Expose it on a subdomain (one-time):
   1) DNS A record:   sandbox.jianchathailand.com  →  <this droplet's IP>
   2) Nginx:          copy scripts/nginx-sandbox.conf.example into
                      /etc/nginx/sites-available/, enable it, then: nginx -t && systemctl reload nginx
   3) SSL:            sudo certbot --nginx -d sandbox.jianchathailand.com

 Redeploy the sandbox later (pull latest + restart):
   JC_APP_NAME=$APP_NAME JC_APP_DIR=$SANDBOX_DIR PORT=$PORT \\
   JC_DEPLOY_BRANCH=$BRANCH JC_ECOSYSTEM=ecosystem.sandbox.config.js bash deploy.sh
────────────────────────────────────────────────────────────────
EOF
