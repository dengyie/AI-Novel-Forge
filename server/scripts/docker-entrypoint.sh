#!/bin/sh
set -eu

if [ "${AI_NOVEL_DATABASE_MODE:-}" = "postgresql" ]; then
  echo "[docker-entrypoint] preparing PostgreSQL migration compatibility state..."
  node /app/server/scripts/docker-prepare-postgres-migrations.js
fi

echo "[docker-entrypoint] deploying Prisma migrations..."
node /app/server/node_modules/prisma/build/index.js migrate deploy --config /app/server/prisma.config.ts

echo "[docker-entrypoint] starting API server..."
exec node /app/server/dist/app.js
