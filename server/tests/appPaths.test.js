const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveAppRuntimeMode,
  resolveAppDataRoot,
  resolveDataRoot,
  resolveLogsRoot,
  resolveGeneratedImagesRoot,
  resolveDatabaseFilePath,
} = require("../dist/runtime/appPaths.js");

const ORIGINAL_APP_DATA_DIR = process.env.AI_NOVEL_APP_DATA_DIR;
const ORIGINAL_RUNTIME = process.env.AI_NOVEL_RUNTIME;

// SERVER_ROOT 在源码与 dist 下都解析到 server/（runtime/appPaths.[tj]s 往上两级）。
const SERVER_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(SERVER_ROOT, "..");

function withEnv(patch, fn) {
  const backup = { ...process.env };
  try {
    Object.assign(process.env, patch);
    return fn();
  } finally {
    process.env = backup;
  }
}

test("web mode defaults stay backward compatible when AI_NOVEL_APP_DATA_DIR unset", () => {
  withEnv({ AI_NOVEL_APP_DATA_DIR: "", AI_NOVEL_RUNTIME: "" }, () => {
    assert.equal(resolveAppRuntimeMode(), "web");
    assert.equal(resolveDataRoot(), SERVER_ROOT);
    assert.equal(
      resolveGeneratedImagesRoot(),
      path.join(SERVER_ROOT, "storage", "generated-images"),
    );
    assert.equal(resolveLogsRoot(), path.join(WORKSPACE_ROOT, ".logs"));
  });
});

test("web mode honors AI_NOVEL_APP_DATA_DIR for logs and storage (container volume /data)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ainovel-paths-"));
  withEnv({ AI_NOVEL_APP_DATA_DIR: tmp, AI_NOVEL_RUNTIME: "" }, () => {
    assert.equal(resolveAppDataRoot(), tmp);
    // 数据库根仍由 SERVER_ROOT 决定（web 模式不改变既有 DB 落点约定，
    // DATABASE_URL=file:/data/... 由 prisma.ts 在调用前剥离 file: 前缀）
    assert.equal(resolveDataRoot(), SERVER_ROOT);
    assert.equal(resolveLogsRoot(), path.join(tmp, "logs"));
    assert.equal(
      resolveGeneratedImagesRoot(),
      path.join(tmp, "storage", "generated-images"),
    );
  });
});

test("desktop mode keeps app-data layout regardless of env shape", () => {
  withEnv(
    { AI_NOVEL_RUNTIME: "desktop", AI_NOVEL_APP_DATA_DIR: "/custom/app-data" },
    () => {
      assert.equal(resolveAppRuntimeMode(), "desktop");
      assert.equal(resolveAppDataRoot(), "/custom/app-data");
      assert.equal(resolveDataRoot(), path.join("/custom/app-data", "data"));
      assert.equal(resolveLogsRoot(), path.join("/custom/app-data", "logs"));
      assert.equal(
        resolveGeneratedImagesRoot(),
        path.join("/custom/app-data", "storage", "generated-images"),
      );
    },
  );
});

test("resolveDatabaseFilePath keeps absolute file paths untouched, resolves relative against data root", () => {
  withEnv({ AI_NOVEL_APP_DATA_DIR: "/custom/app-data", AI_NOVEL_RUNTIME: "" }, () => {
    // 调用方（prisma.ts / runtimeMigrations.ts）已剥离 file: 前缀，此处只接收纯路径
    assert.equal(resolveDatabaseFilePath("/data/ai-novel.db"), "/data/ai-novel.db");
    assert.equal(
      resolveDatabaseFilePath("dev.db"),
      path.resolve(SERVER_ROOT, "dev.db"),
    );
  });
});

test("trims whitespace in AI_NOVEL_APP_DATA_DIR", () => {
  withEnv({ AI_NOVEL_APP_DATA_DIR: "  /data  ", AI_NOVEL_RUNTIME: "" }, () => {
    assert.equal(resolveLogsRoot(), path.join("/data", "logs"));
    assert.equal(
      resolveGeneratedImagesRoot(),
      path.join("/data", "storage", "generated-images"),
    );
  });
});

if (ORIGINAL_APP_DATA_DIR !== undefined) process.env.AI_NOVEL_APP_DATA_DIR = ORIGINAL_APP_DATA_DIR;
if (ORIGINAL_RUNTIME !== undefined) process.env.AI_NOVEL_RUNTIME = ORIGINAL_RUNTIME;
