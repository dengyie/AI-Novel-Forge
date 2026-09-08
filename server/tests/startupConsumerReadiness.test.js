const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("web startup gate probes readiness for every runtime", () => {
  const source = fs.readFileSync(
    path.join(root, "client/src/components/layout/ServerStartupGate.tsx"),
    "utf8",
  );
  assert.match(source, /health\/ready/);
  assert.match(source, /APP_RUNTIME === "web" \|\| APP_RUNTIME === "desktop"/);
});

test("desktop server startup waits for readiness", () => {
  const source = fs.readFileSync(path.join(root, "desktop/src/runtime/server.ts"), "utf8");
  assert.equal((source.match(/\/api\/health`/g) ?? []).length, 0);
  assert.match(source, /\/api\/health\/ready`/);
});
