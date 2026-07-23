#!/usr/bin/env bash
#
# Standalone SQLite backup for JC-Market / TMS.
#
# Safe to run while the server is live — sqlite3 .backup takes a consistent
# snapshot without stopping the app. Intended for a cron schedule, e.g. hourly:
#
#     crontab -e
#     0 * * * * /opt/jc-market/scripts/backup-db.sh >> /opt/jc-market/logs/backup.log 2>&1
#
# Override defaults with env vars:
#     JC_APP_DIR=/root/jc-market JC_BACKUP_KEEP=72 bash scripts/backup-db.sh
#
set -euo pipefail

APP_DIR="${JC_APP_DIR:-/opt/jc-market}"
KEEP="${JC_BACKUP_KEEP:-48}"        # how many snapshots to retain
DB="$APP_DIR/data/stock-market.db"
DEST="$APP_DIR/data/backups"

[ -f "$DB" ] || { echo "$(date '+%F %T') no DB at $DB — nothing to back up"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not installed (apt install -y sqlite3)"; exit 1; }

mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/stock-market-$TS.db"
sqlite3 "$DB" ".backup '$OUT'"
echo "$(date '+%F %T') backed up → $OUT ($(du -h "$OUT" | cut -f1))"

# Prune: keep only the newest $KEEP snapshots.
ls -1t "$DEST"/stock-market-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
