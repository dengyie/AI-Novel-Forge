const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const serverRoot = path.resolve(__dirname, "..");
const configuredRoot = path.join(os.tmpdir(), "ainovel-cli-data-root-fixture");

// Load the real Prisma config through the CLI's own loader, in a fresh process
// per environment to avoid transpiler/module caches. Never import db/prisma,
// instantiate a database client, or run a migration against any database.
const loadConfigScript = `
const fs = require("node:fs");
const { createRequire } = require("node:module");
const prismaRequire = createRequire(fs.realpathSync(require.resolve("prisma/package.json")));
const { loadConfigFromFile } = prismaRequire("@prisma/config");
loadConfigFromFile({ configRoot: process.cwd() }).then((loaded) => {
  if (loaded.error) throw new Error(loaded.error.error?.message || loaded.error._tag);
  const { resolveDatabaseFilePath } = require("./dist/runtime/appPaths.js");
  const { getDatabaseUrl } = require("./dist/config/database.js");
  const url = getDatabaseUrl();
  const runtimeUrl = url.startsWith("file:")
    ? "file:" + resolveDatabaseFilePath(url.slice(5) || "./dev.db") : url;
  console.log(JSON.stringify({ cliUrl: loaded.config.datasource.url, runtimeUrl }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
`;

const cases = [
  { name: "web explicit volume and relative SQLite", mode: "web", root: configuredRoot,
    url: "file:./db/app.sqlite", expected: `file:${path.join(configuredRoot, "db", "app.sqlite")}` },
  { name: "web relative configured root", mode: "web", root: " ./relative-data ",
    url: "file:./dev.db", expected: `file:${path.join(serverRoot, "relative-data", "dev.db")}` },
  { name: "web without configured root", mode: "web", root: "",
    url: "file:./dev.db", expected: `file:${path.join(serverRoot, "dev.db")}` },
  { name: "desktop data layout", mode: "desktop", root: configuredRoot,
    url: "file:./dev.db", expected: `file:${path.join(configuredRoot, "data", "dev.db")}` },
  { name: "absolute SQLite path", mode: "web", root: configuredRoot,
    url: `file:${path.join(os.tmpdir(), "other-root", "app.sqlite")}`,
    expected: `file:${path.join(os.tmpdir(), "other-root", "app.sqlite")}` },
  { name: "empty SQLite path default", mode: "web", root: configuredRoot,
    url: "file:", expected: `file:${path.join(configuredRoot, "dev.db")}` },
  { name: "PostgreSQL URL unchanged", mode: "web", root: configuredRoot,
    url: "postgresql://localhost:5432/cli_config_test", expected: "postgresql://localhost:5432/cli_config_test" },
];

for (const fixture of cases) {
  test(`Prisma CLI and runtime share database target: ${fixture.name}`, () => {
    const loaded = spawnSync(process.execPath, ["-e", loadConfigScript], {
      cwd: serverRoot,
      env: { ...process.env, NODE_ENV: "test", JITI_FS_CACHE: "0",
        AI_NOVEL_RUNTIME: fixture.mode, AI_NOVEL_APP_DATA_DIR: fixture.root,
        DATABASE_URL: fixture.url },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message);
    const result = JSON.parse(loaded.stdout.trim());
    assert.equal(result.runtimeUrl, fixture.expected);
    assert.equal(result.cliUrl, fixture.expected);
  });
}
