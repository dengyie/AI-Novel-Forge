#!/bin/bash
# scripts/deploy/validate-m4b-worker-migration.sh

set -e

echo "Validating m4b worker migration..."

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Check migrations directory
if [ ! -d "$REPO_ROOT/server/src/prisma/migrations" ]; then
  echo "❌ Migrations directory not found"
  exit 1
fi

# Check for M4bEncodingJob migration
if ! ls "$REPO_ROOT"/server/src/prisma/migrations/*add_m4b_encoding_job*/migration.sql >/dev/null 2>&1; then
  echo "❌ M4bEncodingJob migration not found"
  exit 1
fi

# Check worker script built
if [ ! -f "$REPO_ROOT/server/dist/workers/m4b-worker.js" ]; then
  echo "❌ Worker script not built (run pnpm run build)"
  exit 1
fi

# Check schema has new models
if ! grep -q "model M4bEncodingJob" "$REPO_ROOT/server/src/prisma/schema.prisma"; then
  echo "❌ M4bEncodingJob model not in schema"
  exit 1
fi

if ! grep -q "model WorkerHeartbeat" "$REPO_ROOT/server/src/prisma/schema.prisma"; then
  echo "❌ WorkerHeartbeat model not in schema"
  exit 1
fi

echo "✓ Migration validation passed"
echo "✓ Worker script found at server/dist/workers/m4b-worker.js"
echo "✓ Schema models present"
echo ""
echo "Next steps:"
echo "  1. Apply migration: cd server && npx prisma migrate deploy"
echo "  2. Restart server: supervisorctl restart novel-server"
echo "  3. Monitor: tail -f storage/logs/m4b-worker-*.log"
