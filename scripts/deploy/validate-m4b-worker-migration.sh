#!/bin/bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:---post-migration}"
if [[ "$MODE" != "--preflight" && "$MODE" != "--post-migration" ]]; then
  echo "Usage: $0 [--preflight|--post-migration]" >&2
  exit 2
fi
for directory in migrations migrations.sqlite; do
  test -f "$REPO_ROOT/server/src/prisma/$directory/20260930000000_m4b_worker_ownership/migration.sql"
done
test -f "$REPO_ROOT/server/dist/workers/m4b-worker.js"
cd "$REPO_ROOT/server"
node "$REPO_ROOT/scripts/deploy/inspect-m4b-worker-migration.cjs" "$MODE"
echo "M4B $MODE database inspection passed."
echo "This read-only check does not back up data or prove old API/worker/ffmpeg processes have stopped."
