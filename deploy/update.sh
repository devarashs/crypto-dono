#!/bin/sh
# Updates the running service to the latest main, safely. Run by the GitHub
# Actions deploy job through a restricted SSH key (see deploy/README.md), or by
# hand: sh deploy/update.sh
#
#   1. Back up the database (an update may carry a migration).
#   2. Fast-forward to origin/main; refuse if the server's checkout has diverged.
#   3. Rebuild and restart.
#   4. Wait for the app to answer its health check.
#   5. If it does not, return to the previous commit and rebuild that, then fail
#      loudly so the GitHub run shows red.
#
# Migrations only move forward, so a rollback runs the old code against the
# migrated database. Columns added by new migrations are ignored by old code;
# for anything worse, restore the backup taken in step 1 from ~/backups.
set -eu

# This file is replaced by step 2 while it runs, and a shell reading a changed
# script can execute garbage. Run from a private copy instead.
if [ -z "${CRYPTO_DONO_UPDATE_COPY:-}" ]; then
  project_dir="$(cd "$(dirname "$0")/.." && pwd)"
  copy="$(mktemp)"
  cp "$0" "$copy"
  CRYPTO_DONO_UPDATE_COPY="$copy" CRYPTO_DONO_PROJECT_DIR="$project_dir" exec sh "$copy" "$@"
fi
trap 'rm -f "$CRYPTO_DONO_UPDATE_COPY"' EXIT
cd "$CRYPTO_DONO_PROJECT_DIR"

log() { echo "$(date -u +%FT%TZ) $*"; }

# One update at a time, whoever starts it.
exec 9>"$HOME/.crypto-dono-update.lock"
if ! flock -n 9; then
  log "Another update is running; not starting a second one."
  exit 1
fi

previous="$(git rev-parse HEAD)"
git fetch --quiet origin main
target="$(git rev-parse origin/main)"
if [ "$previous" = "$target" ]; then
  log "Already at $(git log -1 --format='%h %s')."
  exit 0
fi

log "Updating $(git rev-parse --short "$previous") -> $(git rev-parse --short "$target")"
sh deploy/backup.sh

if ! git merge --quiet --ff-only "$target"; then
  log "The server checkout has diverged from origin/main; nothing was changed."
  exit 1
fi

# Polls the app inside its container until /healthz answers, for up to ~90 s.
wait_until_healthy() {
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    if docker compose exec -T crypto-dono node -e \
      "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

if docker compose up -d --build --remove-orphans && wait_until_healthy; then
  # Old images pile up with every build; the disk is small.
  docker image prune -f >/dev/null
  log "Deployed $(git log -1 --format='%h %s')."
  exit 0
fi

log "The new version did not become healthy. Recent app logs:"
docker compose logs --tail 40 --no-color crypto-dono || true
log "Rolling back to $(git rev-parse --short "$previous")."
git reset --quiet --hard "$previous"
if docker compose up -d --build --remove-orphans && wait_until_healthy; then
  log "Rolled back; the previous version is running again."
else
  log "Rollback did not come up healthy either. Investigate on the server: docker compose logs"
fi
exit 1
