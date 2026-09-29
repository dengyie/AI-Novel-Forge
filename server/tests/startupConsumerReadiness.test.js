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

test("desktop server startup waits for readiness", async (t) => {
  const source = fs.readFileSync(path.join(root, "desktop/src/runtime/server.ts"), "utf8");
  assert.match(source, /import.*waitForServerHealth.*from "\.\/serverLifecycle"/);
  assert.equal((source.match(/await waitForServerHealth\(port, 45_000/g) ?? []).length, 2,
    "external and managed startup must both await the readiness consumer");

  // Compile the owned consumer directly; this server suite does not require desktop/dist.
  const ts = require("typescript");
  const lifecycle = fs.readFileSync(path.join(root, "desktop/src/runtime/serverLifecycle/index.ts"), "utf8");
  const compiled = ts.transpileModule(lifecycle, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("exports", "require", compiled.outputText)(exports, require);
  const requests = [];
  let cancelledBodies = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    requests.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: requests.length > 1, body: { cancel: async () => { cancelledBodies++; } } };
  });
  await exports.waitForServerHealth(34567, 2000);
  assert.deepEqual(requests, [
    "http://127.0.0.1:34567/api/health/ready",
    "http://127.0.0.1:34567/api/health/ready",
  ], "an initial non-ready response must be retried, not treated as startup success");
  assert.equal(cancelledBodies, 2);
});
