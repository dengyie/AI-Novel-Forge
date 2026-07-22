/**
 * Milestone B: voice plan library suggest + apply clone via approved assetId only.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-plan-b-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

const {
  planCharacterVoices,
  matchLibraryAsset,
} = require("../dist/services/audiobook/audiobookVoicePlanner");
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
  const root = resolveGlobalVoiceLibraryRoot();
  fs.rmSync(root, { recursive: true, force: true });
}

async function withIsolatedLibrary(fn) {
  wipeLibrary();
  try {
    return await fn();
  } finally {
    wipeLibrary();
  }
}

describe("voice plan library (milestone B)", () => {
  after(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("assertBindableCloneRef rejects draft; approved path works for planner apply contract", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "b-src.wav"));
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "b-male-lead",
        displayName: "B 男主",
        license: { source: "test", rights: "internal" },
        tags: ["male", "lead"],
      });
      assert.equal(asset.status, "draft");
      assert.throws(() => voiceLibraryService.assertBindableCloneRef(asset.id), /approved/);

      // draft 不进规划结果
      const plannedDraft = planCharacterVoices({
        strategy: "prefer_library",
        onlyMissing: true,
        libraryAssets: [
          {
            id: asset.id,
            slug: asset.slug,
            displayName: asset.displayName,
            status: asset.status,
            kind: asset.kind,
            tags: asset.tags,
          },
        ],
        characters: [
          {
            characterId: "c1",
            characterName: "男主",
            gender: "male",
            castRole: "protagonist",
          },
        ],
      });
      assert.equal(plannedDraft.items[0].ttsMode, "design");

      // clone_ref → approved 前须经 Ear/播放写入 heardAt
      voiceLibraryService.markLibraryPreviewHeard(asset.id, { heardBy: "test" });
      asset = voiceLibraryService.setStatus(asset.id, "approved");
      const planned = planCharacterVoices({
        strategy: "prefer_library",
        onlyMissing: true,
        libraryAssets: [
          {
            id: asset.id,
            slug: asset.slug,
            displayName: asset.displayName,
            status: asset.status,
            kind: asset.kind,
            tags: asset.tags,
          },
        ],
        characters: [
          {
            characterId: "c1",
            characterName: "男主",
            gender: "male",
            castRole: "protagonist",
          },
        ],
      });
      assert.equal(planned.items[0].ttsMode, "clone");
      assert.equal(planned.items[0].ttsVoiceAssetId, asset.id);

      const { absolutePath } = voiceLibraryService.assertBindableCloneRef(asset.id);
      assert.ok(fs.existsSync(absolutePath));
    });
  });

  it("matchLibraryAsset never returns draft even if mistakenly listed", () => {
    const hit = matchLibraryAsset({
      genderBucket: "male",
      cluster: "lead",
      usedAssetIds: new Set(),
      assets: [
        {
          id: "va_d",
          slug: "d",
          displayName: "d",
          status: "draft",
          kind: "clone_ref",
          tags: ["male", "lead"],
        },
      ],
    });
    assert.equal(hit, null);
  });
});

describe("voice plan apply clone contract (milestone B harden)", () => {
  it("apply clone requires ttsVoiceAssetId; binds approved asset; rejects draft", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "b-apply.wav"));
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "b-apply-male",
        displayName: "B Apply 男",
        license: { source: "test", rights: "internal" },
        tags: ["male", "lead"],
      });
      const { prisma } = require("../dist/db/prisma");
      const { audiobookVoiceAssetService } = require("../dist/services/audiobook/AudiobookVoiceAssetService");

      const originalFind = prisma.novel.findUnique;
      const originalUpdate = prisma.character.update;
      const updates = [];
      prisma.novel.findUnique = async () => ({
        id: "n1",
        characters: [
          {
            id: "c1",
            name: "男主",
            ttsMode: null,
            ttsVoice: null,
            ttsDesignPrompt: null,
            ttsRefAudioPath: null,
            ttsVoiceAssetId: null,
          },
          {
            id: "c2",
            name: "已绑",
            ttsMode: "clone",
            ttsVoice: null,
            ttsDesignPrompt: null,
            ttsRefAudioPath: "/tmp/old.wav",
            ttsVoiceAssetId: "va_old",
          },
        ],
      });
      prisma.character.update = async (args) => {
        updates.push(args);
        return args;
      };

      // character.findFirst used by bindCharacter
      const originalFindFirst = prisma.character.findFirst;
      prisma.character.findFirst = async ({ where }) => {
        if (where?.id === "c1") return { id: "c1" };
        if (where?.id === "c2") return { id: "c2" };
        return null;
      };

      try {
        // missing assetId → skip
        let result = await audiobookVoiceAssetService.apply("n1", {
          overwrite: false,
          items: [{ characterId: "c1", ttsMode: "clone" }],
        });
        assert.equal(result.applied.length, 0);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0].reason, /ttsVoiceAssetId/);

        // draft asset → bind throws → skipped
        result = await audiobookVoiceAssetService.apply("n1", {
          overwrite: false,
          items: [{ characterId: "c1", ttsMode: "clone", ttsVoiceAssetId: asset.id }],
        });
        assert.equal(result.applied.length, 0);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0].reason, /approved|批准|draft|Draft|状态/i);

        voiceLibraryService.markLibraryPreviewHeard(asset.id, { heardBy: "test" });
        asset = voiceLibraryService.setStatus(asset.id, "approved");

        // approved bind → applied
        result = await audiobookVoiceAssetService.apply("n1", {
          overwrite: false,
          items: [
            {
              characterId: "c1",
              ttsMode: "clone",
              ttsVoiceAssetId: asset.id,
              speakerAliases: ["少爷"],
            },
          ],
        });
        assert.equal(result.applied.length, 1);
        assert.equal(result.applied[0].ttsMode, "clone");
        assert.equal(result.applied[0].ttsVoiceAssetId, asset.id);
        // bind update + optional aliases update
        assert.ok(updates.length >= 1);
        const bindUpdate = updates.find((u) => u?.data?.ttsMode === "clone");
        assert.ok(bindUpdate);
        assert.equal(bindUpdate.data.ttsVoiceAssetId, asset.id);

        // already clone without overwrite → skip
        result = await audiobookVoiceAssetService.apply("n1", {
          overwrite: false,
          items: [{ characterId: "c2", ttsMode: "clone", ttsVoiceAssetId: asset.id }],
        });
        assert.equal(result.applied.length, 0);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0].reason, /overwrite|不覆盖/);

        // overwrite rebind
        result = await audiobookVoiceAssetService.apply("n1", {
          overwrite: true,
          items: [{ characterId: "c2", ttsMode: "clone", ttsVoiceAssetId: asset.id }],
        });
        assert.equal(result.applied.length, 1);
        assert.equal(result.applied[0].ttsVoiceAssetId, asset.id);
      } finally {
        prisma.novel.findUnique = originalFind;
        prisma.character.update = originalUpdate;
        prisma.character.findFirst = originalFindFirst;
      }
    });
  });
});

