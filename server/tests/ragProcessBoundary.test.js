const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(repoRoot, "src", ...segments), "utf8");
}

const heavyRagImport = /(?:from\s+|import\s*\(\s*)["'][^"']*services\/rag(?:\/index)?["']/;

test("main process and DB-only RAG entrypoints do not import the worker service barrel", () => {
  for (const segments of [
    ["app.ts"],
    ["routes", "rag.ts"],
    ["services", "rag", "mainProcessProxy.ts"],
    ["services", "rag", "indexing", "reindex.ts"],
  ]) {
    assert.equal(
      heavyRagImport.test(readSource(...segments)),
      false,
      `${segments.join("/")} must use the RAG facade or DB-only indexing module`,
    );
  }
});

test("RAG worker entrypoint is the only runtime entrypoint that imports the service barrel", () => {
  assert.match(readSource("workers", "ragWorkerEntry.ts"), /import\(["']\.\.\/services\/rag["']\)/);
});
