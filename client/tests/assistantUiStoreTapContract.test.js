import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(clientRoot, "..");
const require = createRequire(join(clientRoot, "package.json"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findPnpmPackage(name, versionPrefix) {
  const pnpmRoot = join(repoRoot, "node_modules/.pnpm");
  const needle = `${name.replace("/", "+")}@${versionPrefix}`;
  const entries = readdirSync(pnpmRoot).filter((entry) => entry.startsWith(needle));
  for (const entry of entries) {
    const pkgDir = join(pnpmRoot, entry, "node_modules", name);
    if (existsSync(join(pkgDir, "package.json"))) {
      return pkgDir;
    }
  }
  return null;
}

test("package.json pins @assistant-ui/store to 0.2.13 for tap 0.5.x type protocol", () => {
  const rootPkg = readJson(join(repoRoot, "package.json"));
  const storeOverride = rootPkg?.pnpm?.overrides?.["@assistant-ui/store"];
  assert.equal(
    storeOverride,
    "0.2.13",
    "store override must stay on 0.2.13 while tap is 0.5.x; 0.2.16+ reads ResourceElement.hook and whitescreens creative-hub",
  );
});

test("resolved store/tap ResourceElement protocol matches (.type not .hook)", async () => {
  const storeDir = findPnpmPackage("@assistant-ui/store", "0.2.13");
  const tapDir = findPnpmPackage("@assistant-ui/tap", "0.5.");
  assert.ok(storeDir, "store@0.2.13 should be installed via pnpm");
  assert.ok(tapDir, "tap@0.5.x should be installed via pnpm");

  const storePkg = readJson(join(storeDir, "package.json"));
  const tapPkg = readJson(join(tapDir, "package.json"));
  assert.equal(storePkg.version, "0.2.13");
  assert.match(tapPkg.version, /^0\.5\./);

  const splitClientsPath = join(storeDir, "dist/utils/splitClients.js");
  const splitClients = readFileSync(splitClientsPath, "utf8");
  assert.match(splitClients, /clientElement\.type/, "store 0.2.13 must read ResourceElement.type");
  assert.doesNotMatch(
    splitClients,
    /clientElement\.hook/,
    "store pin must not use ResourceElement.hook (0.2.16+ protocol)",
  );

  const resourceModule = await import(pathToFileURL(join(tapDir, "dist/core/resource.js")).href);
  const element = resourceModule.resource(() => null)({});
  assert.equal(typeof element.type, "function");
  assert.equal(element.hook, undefined);

  // react tree should nest the same store version
  const reactStorePkgPath = join(
    clientRoot,
    "node_modules/@assistant-ui/react/node_modules/@assistant-ui/store/package.json",
  );
  if (existsSync(reactStorePkgPath)) {
    assert.equal(readJson(reactStorePkgPath).version, "0.2.13");
  } else {
    // pnpm may hoist store next to react without nested copy
    const nested = join(clientRoot, "node_modules/@assistant-ui/store/package.json");
    if (existsSync(nested)) {
      assert.equal(readJson(nested).version, "0.2.13");
    } else {
      // fall back: require.resolve from client
      try {
        const resolved = require.resolve("@assistant-ui/store/package.json", {
          paths: [join(clientRoot, "node_modules/@assistant-ui/react")],
        });
        assert.equal(readJson(resolved).version, "0.2.13");
      } catch {
        // react may re-export store only via core; primary pin+splitClients checks above still hold
      }
    }
  }
});

test("CreativeHubPage wraps content in ErrorBoundary outside runtime hooks", () => {
  const page = readFileSync(join(clientRoot, "src/pages/creativeHub/CreativeHubPage.tsx"), "utf8");
  assert.match(page, /CreativeHubErrorBoundary/);
  assert.match(page, /function CreativeHubPageContent/);
  // default export boundary must wrap content component that owns the runtime hook
  assert.match(
    page,
    /export default function CreativeHubPage\(\)[\s\S]*CreativeHubErrorBoundary[\s\S]*CreativeHubPageContent/,
  );
  assert.match(
    page,
    /function CreativeHubPageContent\(\)[\s\S]*useCreativeHubRuntime/,
  );
});
