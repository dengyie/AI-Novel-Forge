const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const prismaRoot = path.join(__dirname, "..", "src", "prisma");

function readMigrationDirectories(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
}

test("fresh database migrations create the novel fact ledger for sqlite and postgres", () => {
  const sqliteMigrationsRoot = path.join(prismaRoot, "migrations.sqlite");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-novel-fact-migration-"));
  const databasePath = path.join(tempDir, "fact-ledger.db");
  const database = new Database(databasePath);

  try {
    database.pragma("foreign_keys = OFF");
    for (const entry of readMigrationDirectories(sqliteMigrationsRoot)) {
      const migrationPath = path.join(sqliteMigrationsRoot, entry.name, "migration.sql");
      if (fs.existsSync(migrationPath)) {
        database.exec(fs.readFileSync(migrationPath, "utf8"));
      }
    }
    database.pragma("foreign_keys = ON");

    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'NovelFactEntry'",
    ).get();
    assert.deepEqual(table, { name: "NovelFactEntry" });

    const indexNames = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'NovelFactEntry' ORDER BY name",
    ).all().map((row) => row.name);
    assert.deepEqual(indexNames, [
      "NovelFactEntry_novelId_category_idx",
      "NovelFactEntry_novelId_chapterOrder_idx",
      "sqlite_autoindex_NovelFactEntry_1",
    ]);
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const postgresMigrationsRoot = path.join(prismaRoot, "migrations");
  const postgresSql = readMigrationDirectories(postgresMigrationsRoot)
    .map((entry) => path.join(postgresMigrationsRoot, entry.name, "migration.sql"))
    .filter((migrationPath) => fs.existsSync(migrationPath))
    .map((migrationPath) => fs.readFileSync(migrationPath, "utf8"))
    .join("\n");

  assert.match(postgresSql, /CREATE TABLE "NovelFactEntry"/);
  assert.match(postgresSql, /NovelFactEntry_novelId_chapterOrder_idx/);
  assert.match(postgresSql, /NovelFactEntry_novelId_category_idx/);
  assert.match(postgresSql, /FOREIGN KEY \("novelId"\) REFERENCES "Novel"\("id"\) ON DELETE CASCADE/);
});
