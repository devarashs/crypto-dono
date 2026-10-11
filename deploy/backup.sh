#!/bin/sh
# Nightly backup of the donation database, kept on the server for 14 days.
#
# Uses SQLite's VACUUM INTO, which writes a consistent snapshot while the app
# keeps running: copying the live file could catch it mid-write (WAL mode).
#
# Run from the project folder, e.g. from cron:
#   15 4 * * * cd /home/ubuntu/crypto-dono && sh deploy/backup.sh >> /home/ubuntu/backups/backup.log 2>&1
#
# These copies live on the same disk as the database. For protection against
# losing the instance, also enable Lightsail's automatic snapshots.
set -eu

backup_dir="${BACKUP_DIR:-$HOME/backups}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
snapshot="data/backup-$stamp.sqlite"

mkdir -p "$backup_dir"

docker compose exec -T crypto-dono node -e "
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync('data/crypto-dono.sqlite');
  database.exec(\"VACUUM INTO '$snapshot'\");
  database.close();
"
docker compose cp "crypto-dono:/app/$snapshot" "$backup_dir/crypto-dono-$stamp.sqlite"
docker compose exec -T crypto-dono rm -f "$snapshot"

find "$backup_dir" -name 'crypto-dono-*.sqlite' -mtime +"$keep_days" -delete
echo "$(date -u +%FT%TZ) backed up to $backup_dir/crypto-dono-$stamp.sqlite"
