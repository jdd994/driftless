#!/usr/bin/env bash
# Back up the live Driftless D1 database to backups/ (gitignored).
# Usage: npm run backup   (or: bash scripts/backup.sh)
#
# The dump holds account metadata, password hashes, and feedback — no journal
# plaintext (that's E2E-encrypted ciphertext), but still keep it somewhere safe
# and offline. Cloudflare also keeps 30-day point-in-time recovery (Time Travel);
# this is your own copy on top of that.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/driftless-$STAMP.sql"
( cd server && npx wrangler d1 export driftless --remote --output "../$OUT" )
echo "✓ Backup written to $OUT ($(du -h "$OUT" | cut -f1))"
# Keep the last 14 backups; prune older ones.
ls -1t backups/driftless-*.sql 2>/dev/null | tail -n +15 | xargs -r rm --
