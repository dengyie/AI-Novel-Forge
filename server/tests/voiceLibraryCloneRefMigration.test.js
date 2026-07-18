/**
 * P2-2: migrateCharacterCloneRefPathsRelativeOnce 幂等 + 缺表复位 + 越界保留。
 * 用 fake prisma.character 注入，不动真实 DB。
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voiceref-migrate-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

const { prisma } = require("../dist/db/prisma.js");
const {
  migrateCharacterCloneRefPathsRelativeOnce,
  resetCharacterCloneRefMigrationForTests,
} = require("../dist/services/audiobook/voiceLibraryService.js");
const {
  resolveVoiceRefRoot,
} = require("../dist/services/audiobook/audiobookPaths.js");

function writeSilentPcmWav(filePath) {
  const rate = 24000;
  const dataSize = 4;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

describe("migrateCharacterCloneRefPathsRelativeOnce (P2-2)", () => {
  const origFindMany = prisma.character.findMany;
  const origUpdate = prisma.character.update;
  let updates = [];

  beforeEach(() => {
    updates = [];
    resetCharacterCloneRefMigrationForTests();
  });

  afterEach(() => {
    prisma.character.findMany = origFindMany;
    prisma.character.update = origUpdate;
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("migrates absolute in-root path to relative and reports counts", async () => {
    const absWav = writeSilentPcmWav(path.join(resolveVoiceRefRoot(), "nov-a", "char-a", "ref.wav"));
    prisma.character.findMany = async () => [
      { id: "c1", ttsRefAudioPath: absWav },
      // 相对路径：跳过
      { id: "c2", ttsRefAudioPath: "nov-b/char-b/ref.wav" },
    ];
    prisma.character.update = async ({ where, data }) => {
      updates.push({ id: where.id, to: data.ttsRefAudioPath });
      return {};
    };

    const r1 = await migrateCharacterCloneRefPathsRelativeOnce();
    assert.equal(r1.attempted, 1);
    assert.equal(r1.migrated, 1);
    assert.equal(r1.skippedOutOfRoot, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "c1");
    assert.ok(!path.isAbsolute(updates[0].to));
    assert.equal(path.resolve(resolveVoiceRefRoot(), updates[0].to), absWav);

    // 第二次调用：已完成→幂等跳过，无新 update
    const r2 = await migrateCharacterCloneRefPathsRelativeOnce();
    assert.equal(r2.migrated, 0);
    assert.equal(r2.attempted, 0);
    assert.equal(updates.length, 1);
  });

  it("out-of-root absolute path is preserved (skippedOutOfRoot++), not migrated", async () => {
    const outside = path.join(os.tmpdir(), "other-outside-" + process.pid + ".wav");
    writeSilentPcmWav(outside);
    prisma.character.findMany = async () => [{ id: "c3", ttsRefAudioPath: outside }];
    prisma.character.update = async () => {
      throw new Error("should not be called for out-of-root");
    };

    const r = await migrateCharacterCloneRefPathsRelativeOnce();
    assert.equal(r.attempted, 1);
    assert.equal(r.migrated, 0);
    assert.equal(r.skippedOutOfRoot, 1);
  });

  it("missing-table error resets done-flag so a later call retries", async () => {
    let calls = 0;
    prisma.character.findMany = async () => {
      calls += 1;
      const err = new Error("table does not exist");
      err.code = "P2021";
      throw err;
    };
    prisma.character.update = async () => ({});

    const r1 = await migrateCharacterCloneRefPathsRelativeOnce();
    assert.equal(r1.migrated, 0);
    assert.equal(r1.attempted, 0);

    // 模拟 DB 就绪：第二次 findMany 返回空
    prisma.character.findMany = async () => [];
    const r2 = await migrateCharacterCloneRefPathsRelativeOnce();
    // 因 P2021 复位了标志，第二次应真正执行（空表→0 attempted，但标志置位）
    assert.equal(r2.attempted, 0);
    assert.equal(calls, 1);
  });
});
