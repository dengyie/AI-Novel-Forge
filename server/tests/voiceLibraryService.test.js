/**
 * Milestone A: VoiceAsset 库安全与种子导入。
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate data root before loading path-bound modules.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-lib-a-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

const {
  resolveGlobalVoiceLibraryRoot,
  resolveGlobalVoiceRegistryPath,
} = require("../dist/services/audiobook/audiobookPaths");
const {
  buildCharacterVoicePreviewFingerprint,
} = require("../dist/services/audiobook/characterVoicePreview");
const {
  buildVoiceDetailLabel,
} = require("../dist/services/audiobook/characterVoiceReadiness");
const { voiceLibraryService } = require("../dist/services/audiobook/voiceLibraryService");

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

describe("voiceLibraryService", () => {
  after(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("拒绝缺 license 的导入", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src.wav"));
      assert.throws(
        () =>
          voiceLibraryService.importFromFile({
            sourcePath: wav,
            slug: "no-license",
            displayName: "x",
            license: { source: "", rights: "" },
          }),
        /license/,
      );
    });
  });

  it("导入路径落在 voice-refs/global 且 check 可通过", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src2.wav"));
      const asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "ok-path",
        displayName: "OK",
        license: { source: "test", rights: "internal" },
      });
      assert.equal(asset.kind, "clone_ref");
      assert.equal(asset.status, "draft");
      assert.ok(asset.primaryFile?.path.includes(`${path.sep}voice-refs${path.sep}global${path.sep}`));
      assert.ok(fs.existsSync(asset.primaryFile.path));
      assert.ok(fs.existsSync(resolveGlobalVoiceRegistryPath()));
    });
  });

  it("draft 绑库默认拒绝；approved 后 resolveCloneRefForCharacter 成功", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src3.wav"));
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "bind-draft",
        displayName: "Draft",
        license: { source: "test", rights: "internal" },
      });
      assert.throws(
        () =>
          voiceLibraryService.resolveCloneRefForCharacter({
            ttsVoiceAssetId: asset.id,
            requireApproved: true,
          }),
        /approved/,
      );
      asset = voiceLibraryService.setStatus(asset.id, "approved");
      assert.equal(asset.status, "approved");
      const abs = voiceLibraryService.resolveCloneRefForCharacter({
        ttsVoiceAssetId: asset.id,
        requireApproved: true,
      });
      assert.ok(abs && fs.existsSync(abs));
    });
  });

  it("种子包导入为 draft 且可 list", async () => {
    await withIsolatedLibrary(async () => {
      const packRoot = path.resolve(__dirname, "../../docs/voice-packs/05-yuanworld-seed-from-mimo");
      assert.ok(fs.existsSync(path.join(packRoot, "SEED_MANIFEST.json")), packRoot);
      const again = voiceLibraryService.importYuanworldSeedPack({
        packRoot,
        overwrite: true,
      });
      assert.ok(
        again.imported.length >= 3,
        `expected >=3 imported, got ${again.imported.length}; failed=${JSON.stringify(again.failed)}`,
      );
      assert.ok(again.imported.every((a) => a.status === "draft"));
      const listed = voiceLibraryService.list({ tag: "seed" });
      assert.ok(listed.total >= 3);
    });
  });

  it("指纹包含 assetId；就绪标签含库前缀", () => {
    const fp1 = buildCharacterVoicePreviewFingerprint(
      {
        ttsMode: "clone",
        ttsRefAudioPath: "/tmp/a.wav",
        ttsVoiceAssetId: "va_aaa",
      },
      "样例",
    );
    const fp2 = buildCharacterVoicePreviewFingerprint(
      {
        ttsMode: "clone",
        ttsRefAudioPath: "/tmp/a.wav",
        ttsVoiceAssetId: "va_bbb",
      },
      "样例",
    );
    assert.notEqual(fp1, fp2);
    const label = buildVoiceDetailLabel({
      binding: "configured",
      mode: "clone",
      ttsVoiceAssetId: "va_abcdef12",
    });
    assert.match(label, /clone·库\/va_abcdef/);
  });
});
