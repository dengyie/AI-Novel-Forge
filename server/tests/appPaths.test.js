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

test("web mode honors AI_NOVEL_APP_DATA_DIR for all persistent data", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ainovel-paths-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  withEnv({ AI_NOVEL_APP_DATA_DIR: tmp, AI_NOVEL_RUNTIME: "web" }, () => {
    assert.equal(resolveAppDataRoot(), tmp);
    assert.equal(resolveDataRoot(), tmp);
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
      path.resolve("/custom/app-data", "dev.db"),
    );
  });
});

test("trims whitespace in AI_NOVEL_APP_DATA_DIR", () => {
  withEnv({ AI_NOVEL_APP_DATA_DIR: "  /data  ", AI_NOVEL_RUNTIME: "" }, () => {
    assert.equal(resolveDataRoot(), "/data");
    assert.equal(resolveLogsRoot(), path.join("/data", "logs"));
    assert.equal(
      resolveGeneratedImagesRoot(),
      path.join("/data", "storage", "generated-images"),
    );
  });
});

if (ORIGINAL_APP_DATA_DIR !== undefined) process.env.AI_NOVEL_APP_DATA_DIR = ORIGINAL_APP_DATA_DIR;
if (ORIGINAL_RUNTIME !== undefined) process.env.AI_NOVEL_RUNTIME = ORIGINAL_RUNTIME;


test("web audio and voice references are actually written under the configured volume", (t) => {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), "ainovel-volume-"));
  t.after(() => fs.rmSync(volume, { recursive: true, force: true }));
  const audio = require("../dist/services/audiobook/audiobookPaths.js");
  withEnv({ AI_NOVEL_APP_DATA_DIR: volume, AI_NOVEL_RUNTIME: "web" }, () => {
    const expectedTask = path.join(volume, "storage", "audiobooks", "novel-volume", "task-volume");
    // Check before writing so a regression cannot create fixtures in the repository.
    assert.equal(audio.resolveAudiobookTaskDir("novel-volume", "task-volume"), expectedTask);
    assert.equal(audio.resolveVoiceRefRoot(), path.join(volume, "storage", "voice-refs"));
    const taskDir = audio.ensureAudiobookTaskDir("novel-volume", "task-volume");
    const output = audio.resolveFullBookAudioPath(taskDir);
    fs.writeFileSync(output, "audio fixture");
    const reference = audio.writeCharacterVoiceRefFromBase64({
      novelId: "novel-volume", characterId: "character-volume",
      base64: Buffer.from("reference fixture").toString("base64"),
    });
    assert.equal(reference, path.join(volume, "storage", "voice-refs", "novel-volume", "character-volume", "ref.wav"));
    assert.equal(fs.readFileSync(reference, "utf8"), "reference fixture");
    assert.equal(fs.readFileSync(output, "utf8"), "audio fixture");
    assert.equal(audio.ensureDirExistsUnderAudiobookRoot(taskDir), taskDir);
  });
});

test("relative database and relative configured roots follow the runtime data layout", () => {
  withEnv({ AI_NOVEL_APP_DATA_DIR: " ./relative-data ", AI_NOVEL_RUNTIME: "web" }, () => {
    assert.equal(resolveDataRoot(), path.resolve("relative-data"));
    assert.equal(resolveDatabaseFilePath("./db/app.sqlite"), path.resolve("relative-data/db/app.sqlite"));
  });
  withEnv({ AI_NOVEL_APP_DATA_DIR: "", AI_NOVEL_RUNTIME: "web" }, () => {
    assert.equal(resolveDatabaseFilePath("./dev.db"), path.join(SERVER_ROOT, "dev.db"));
  });
  withEnv({ AI_NOVEL_APP_DATA_DIR: "/custom/app-data", AI_NOVEL_RUNTIME: "desktop" }, () => {
    assert.equal(resolveDatabaseFilePath("./dev.db"), "/custom/app-data/data/dev.db");
  });
});
