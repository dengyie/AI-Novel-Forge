/**
 * P3 backlog：service 层 listVoiceLibraryMatches 单测（不连真 DB）。
 * fake prisma.novel.findUnique 返回构造 novel；库资产走隔离库 voiceLibraryService
 * importFromFile → markLibraryPreviewHeard → setStatus("approved")。
 * 覆盖：候选排序、excludedCount、其它角色占用 occupiedBy/speakerOccupied、自身已绑排除、404。
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-match-svc-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

// fake prisma 必须在 require service 之前注入，使 prisma.ts 走 global 分支
const novels = new Map();
const fakePrisma = {
  novel: {
    findUnique: async ({ where, select }) => {
      const novel = novels.get(where.id);
      if (!novel) return null;
      // select 仅用于类型裁剪；fake 直接返回 mock 整对象（字段多于 select 无害）
      return novel;
    },
  },
};
global.prisma = fakePrisma;

const {
  AudiobookVoiceAssetService,
} = require("../dist/services/audiobook/AudiobookVoiceAssetService");
const { voiceLibraryService } = require("../dist/services/audiobook/voiceLibraryService");
const {
  resolveGlobalVoiceLibraryRoot,
} = require("../dist/services/audiobook/audiobookPaths");

function writeSilentPcmWav(filePath, { rate = 24000, seconds = 0.12 } = {}) {
  const numSamples = Math.max(1, Math.floor(rate * seconds));
  const dataSize = numSamples * 2;
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

function wipeLibrary() {
  fs.rmSync(resolveGlobalVoiceLibraryRoot(), { recursive: true, force: true });
}

async function withIsolatedLibrary(fn) {
  wipeLibrary();
  try {
    return await fn();
  } finally {
    wipeLibrary();
  }
}

// 造一个 approved clone_ref 资产（import → markHeard → setStatus）
function createApprovedAsset(slug, tags) {
  const wav = writeSilentPcmWav(path.join(TMP_ROOT, `${slug}.wav`));
  let asset = voiceLibraryService.importFromFile({
    sourcePath: wav,
    slug,
    displayName: slug,
    license: { source: "test", rights: "internal" },
    tags,
  });
  voiceLibraryService.markLibraryPreviewHeard(asset.id, { heardBy: "test" });
  asset = voiceLibraryService.setStatus(asset.id, "approved");
  assert.equal(asset.status, "approved");
  return asset;
}

function makeNovel(id, characters) {
  return { id, characters };
}

const service = new AudiobookVoiceAssetService();

// 注：createApprovedAsset 无 speaker: 标签时 speakerKey 退回 asset:id（唯一），故 sha 不撞库、speaker 不互相去重。
describe("AudiobookVoiceAssetService.listVoiceLibraryMatches (fake prisma)", () => {
  after(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("404 when novel not found", async () => {
    await withIsolatedLibrary(async () => {
      await assert.rejects(
        () => service.listVoiceLibraryMatches("no-such-novel", "c1"),
        (err) => err?.statusCode === 404 || /小说不存在/.test(String(err?.message || err)),
      );
    });
  });

  it("404 when character not in novel", async () => {
    await withIsolatedLibrary(async () => {
      novels.set("n1", makeNovel("n1", [{ id: "c1", name: "甲" }]));
      await assert.rejects(
        () => service.listVoiceLibraryMatches("n1", "c-missing"),
        (err) => err?.statusCode === 404 || /角色不存在/.test(String(err?.message || err)),
      );
    });
  });

  it("returns ranked male-lead candidate; excludedCount reflects strict gating", async () => {
    await withIsolatedLibrary(async () => {
      const maleLead = createApprovedAsset("svc-male-lead", ["male", "lead", "scope-zh"]);
      const femaleLead = createApprovedAsset("svc-female-lead", ["female", "lead", "scope-zh"]);
      const narrator = createApprovedAsset("svc-narrator", ["narrator", "scope-zh"]);
      novels.set(
        "n2",
        makeNovel("n2", [
          { id: "c-target", name: "男主", gender: "male", castRole: "protagonist" },
        ]),
      );
      const res = await service.listVoiceLibraryMatches("n2", "c-target", { topN: 5 });
      assert.equal(res.novelId, "n2");
      assert.equal(res.characterId, "c-target");
      assert.equal(res.genderBucket, "male");
      assert.equal(res.cluster, "lead");
      assert.ok(res.candidates.length >= 1);
      assert.equal(res.candidates[0].voiceAssetId, maleLead.id);
      // female-lead 与 narrator 被门禁排除 → excludedCount 至少 2
      assert.ok(res.excludedCount >= 2, `excludedCount=${res.excludedCount}`);
      // 顶部候选未被占用
      assert.equal(res.candidates[0].occupiedBy, null);
      assert.equal(res.candidates[0].speakerOccupied, false);
    });
  });

  it("other clone-bound character occupies candidate speaker and asset (occupiedBy + speakerOccupied)", async () => {
    await withIsolatedLibrary(async () => {
      const speaker = "speaker:sp-busy";
      const busy = createApprovedAsset("svc-busy", ["male", "lead", "scope-zh", speaker]);
      const free = createApprovedAsset("svc-free", ["male", "lead", "scope-zh", "speaker:sp-free"]);
      novels.set(
        "n3",
        makeNovel("n3", [
          { id: "c-other", name: "乙", gender: "male", castRole: "lead", ttsMode: "clone", ttsVoiceAssetId: busy.id },
          { id: "c-target", name: "甲", gender: "male", castRole: "protagonist" },
        ]),
      );
      const res = await service.listVoiceLibraryMatches("n3", "c-target", { topN: 8 });
      const busyMatch = res.candidates.find((c) => c.voiceAssetId === busy.id);
      const freeMatch = res.candidates.find((c) => c.voiceAssetId === free.id);
      assert.ok(busyMatch, "occupied speaker candidate must appear (not hidden)");
      assert.equal(busyMatch.speakerOccupied, true);
      assert.deepEqual(busyMatch.occupiedBy, ["乙"]);
      assert.ok(freeMatch);
      assert.equal(freeMatch.speakerOccupied, false);
    });
  });

  it("self-bound asset excluded from candidates", async () => {
    await withIsolatedLibrary(async () => {
      const mine = createApprovedAsset("svc-mine", ["male", "lead", "scope-zh", "speaker:sp-mine"]);
      const other = createApprovedAsset("svc-other", ["male", "lead", "scope-zh", "speaker:sp-other"]);
      novels.set(
        "n4",
        makeNovel("n4", [
          { id: "c-target", name: "甲", gender: "male", castRole: "protagonist", ttsMode: "clone", ttsVoiceAssetId: mine.id },
        ]),
      );
      const res = await service.listVoiceLibraryMatches("n4", "c-target", { topN: 8 });
      assert.ok(!res.candidates.some((c) => c.voiceAssetId === mine.id), "self asset must be excluded");
      assert.ok(res.candidates.some((c) => c.voiceAssetId === other.id));
    });
  });

  it("topN cap respected", async () => {
    await withIsolatedLibrary(async () => {
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const a = createApprovedAsset(`svc-cap-${i}`, ["male", "lead", "scope-zh"]);
        ids.push(a.id);
      }
      novels.set(
        "n5",
        makeNovel("n5", [{ id: "c-target", name: "甲", gender: "male", castRole: "protagonist" }]),
      );
      const res = await service.listVoiceLibraryMatches("n5", "c-target", { topN: 2 });
      assert.ok(res.candidates.length <= 2);
    });
  });
});
