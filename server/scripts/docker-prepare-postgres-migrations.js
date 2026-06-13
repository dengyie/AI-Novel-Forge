const { spawnSync } = require("node:child_process");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

const legacySqliteMigration = "20260328120000_schema_gap_backfill";
const idempotentPostgresMigrations = [
  "20260419123000_schema_column_backfill",
  "20260422190000_style_extraction_task",
];

function resolveDatabaseUrl() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required before preparing PostgreSQL migrations.");
  }
  return url;
}

function runPrismaResolve(action, migrationName) {
  const result = spawnSync(
    process.execPath,
    [
      "/app/server/node_modules/prisma/build/index.js",
      "migrate",
      "resolve",
      action,
      migrationName,
      "--config",
      "/app/server/prisma.config.ts",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/P3008|P3012/.test(output)) {
    console.log(`[docker-entrypoint] migration ${migrationName} already has a compatible state for ${action}.`);
    return;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}

async function hasFinishedMigration(prisma, migrationName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
     FROM "_prisma_migrations"
     WHERE migration_name = $1
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL
     LIMIT 1`,
    migrationName,
  );
  return rows.length > 0;
}

async function hasActiveFailedMigration(prisma, migrationName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
     FROM "_prisma_migrations"
     WHERE migration_name = $1
       AND finished_at IS NULL
       AND rolled_back_at IS NULL
     LIMIT 1`,
    migrationName,
  );
  return rows.length > 0;
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }),
  });

  try {
    const migrationTables = await prisma.$queryRawUnsafe(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = '_prisma_migrations'
       LIMIT 1`,
    );
    if (migrationTables.length === 0) {
      console.log(`[docker-entrypoint] marking legacy SQLite migration ${legacySqliteMigration} as applied for PostgreSQL baseline startup.`);
      runPrismaResolve("--applied", legacySqliteMigration);
      return;
    }

    if (await hasActiveFailedMigration(prisma, legacySqliteMigration)) {
      console.log(`[docker-entrypoint] resolving failed legacy SQLite migration ${legacySqliteMigration} as rolled back.`);
      runPrismaResolve("--rolled-back", legacySqliteMigration);
    }
    if (!(await hasFinishedMigration(prisma, legacySqliteMigration))) {
      console.log(`[docker-entrypoint] marking legacy SQLite migration ${legacySqliteMigration} as applied for PostgreSQL baseline startup.`);
      runPrismaResolve("--applied", legacySqliteMigration);
    } else {
      console.log(`[docker-entrypoint] legacy SQLite migration ${legacySqliteMigration} is already skipped for PostgreSQL.`);
    }

    for (const migrationName of idempotentPostgresMigrations) {
      if (!(await hasActiveFailedMigration(prisma, migrationName))) {
        console.log(`[docker-entrypoint] migration ${migrationName} has no active failed record.`);
        continue;
      }

      console.log(`[docker-entrypoint] resolving failed migration ${migrationName} as rolled back.`);
      runPrismaResolve("--rolled-back", migrationName);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[docker-entrypoint] failed to prepare PostgreSQL migration compatibility state.", error);
  process.exit(1);
});
