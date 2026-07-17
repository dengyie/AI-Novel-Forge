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

function writeSilentPcmWav(filePath, { rate = 24000, seconds = 0.12, seed = 0 } = {}) {
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
  // seed≠0 时写入非零 PCM，保证不同 seed 的 sha256 不同
  if (seed) {
    for (let i = 0; i < numSamples; i += 1) {
      const sample = ((i * 31 + seed * 17) % 400) - 200;
      buf.writeInt16LE(sample, 44 + i * 2);
    }
  }
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
      // registry 存相对 voice-refs 路径
      assert.match(asset.primaryFile?.path || "", /^global\/assets\/va_[a-f0-9]+\/ref\.wav$/);
      const {
        resolveVoiceAssetStoredPath,
      } = require("../dist/services/audiobook/voiceLibraryService");
      const abs = resolveVoiceAssetStoredPath(asset.primaryFile.path);
      assert.ok(abs && fs.existsSync(abs));
      assert.ok(abs.includes(`${path.sep}voice-refs${path.sep}global${path.sep}`));
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
      voiceLibraryService.markLibraryPreviewHeard(asset.id);
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

  it("相对路径 resolve 与 approved 门禁；draft 拒绝", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src4.wav"));
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "rel-path",
        displayName: "Rel",
        license: { source: "test", rights: "internal" },
      });
      assert.match(asset.primaryFile.path, /^global\//);
      assert.throws(
        () => voiceLibraryService.assertBindableCloneRef(asset.id),
        /approved/,
      );
      voiceLibraryService.markLibraryPreviewHeard(asset.id);
      asset = voiceLibraryService.setStatus(asset.id, "approved");
      const { absolutePath } = voiceLibraryService.assertBindableCloneRef(asset.id);
      assert.ok(fs.existsSync(absolutePath));
      assert.ok(path.isAbsolute(absolutePath));
    });
  });

  it("import 禁止 status=approved；须 setStatus 后 resolve", async () => {
    await withIsolatedLibrary(async () => {
      const {
        resolveEffectiveCloneRefPath,
      } = require("../dist/services/audiobook/voiceLibraryService");
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src5.wav"));
      assert.throws(
        () =>
          voiceLibraryService.importFromFile({
            sourcePath: wav,
            slug: "eff-path",
            displayName: "Eff",
            license: { source: "test", rights: "internal" },
            status: "approved",
          }),
        /禁止.*approved|approved/,
      );
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "eff-path",
        displayName: "Eff",
        license: { source: "test", rights: "internal" },
      });
      assert.equal(asset.status, "draft");
      voiceLibraryService.markLibraryPreviewHeard(asset.id);
      asset = voiceLibraryService.setStatus(asset.id, "approved");
      assert.equal(asset.status, "approved");
      const abs = resolveEffectiveCloneRefPath({
        ttsVoiceAssetId: asset.id,
        ttsRefAudioPath: "/tmp/stale.wav",
        requireApproved: true,
      });
      assert.ok(abs && fs.existsSync(abs));
      voiceLibraryService.setStatus(asset.id, "archived");
      assert.throws(
        () =>
          resolveEffectiveCloneRefPath({
            ttsVoiceAssetId: asset.id,
            requireApproved: true,
          }),
        /archived/,
      );
    });
  });

  it("sourcePath 越界拒绝；seed forceStatus=approved 拒绝", async () => {
    await withIsolatedLibrary(async () => {
      const outside = path.join(os.tmpdir(), `voice-lib-outside-${process.pid}`);
      // os.tmpdir 在 allowlist 内；用 /etc/hosts 或系统根下只读文件测越界
      const outsideCandidates = ["/etc/hosts", "/var/log/system.log", "/usr/share/dict/words"];
      const outsideFile = outsideCandidates.find((p) => fs.existsSync(p));
      if (outsideFile) {
        assert.throws(
          () =>
            voiceLibraryService.importFromFile({
              sourcePath: outsideFile,
              slug: "outside-path",
              displayName: "Out",
              license: { source: "test", rights: "internal" },
            }),
          /允许目录|不在允许/,
        );
      }
      assert.throws(
        () =>
          voiceLibraryService.importYuanworldSeedPack({
            forceStatus: "approved",
            overwrite: true,
          }),
        /forceStatus|approved/,
      );
      // 占位避免 unused
      void outside;
    });
  });

  it("list limit 非有限数回落默认；offset 分页；corrupt registry 抛错", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src-list.wav"));
      for (let i = 0; i < 3; i += 1) {
        voiceLibraryService.importFromFile({
          sourcePath: wav,
          slug: `list-item-${i}`,
          displayName: `L${i}`,
          license: { source: "test", rights: "internal" },
        });
      }
      const badLimit = voiceLibraryService.list({ limit: Number.NaN });
      assert.equal(badLimit.total, 3);
      assert.ok(badLimit.items.length === 3);
      const page = voiceLibraryService.list({ limit: 1, offset: 1 });
      assert.equal(page.total, 3);
      assert.equal(page.items.length, 1);

      const regPath = resolveGlobalVoiceRegistryPath();
      fs.writeFileSync(regPath, "{not-json", "utf8");
      assert.throws(() => voiceLibraryService.list({}), /损坏|registry/);
      // 备份存在
      const dir = path.dirname(regPath);
      const backups = fs.readdirSync(dir).filter((n) => n.includes(".corrupt."));
      assert.ok(backups.length >= 1);
    });
  });

  it("库级试听 draft 可解析；archived 拒绝", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src-preview.wav"));
      const asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "preview-draft",
        displayName: "Preview",
        license: { source: "test", rights: "internal" },
      });
      assert.equal(asset.status, "draft");
      const preview = voiceLibraryService.resolveLibraryPreviewAudioPath(asset.id);
      assert.equal(preview.asset.id, asset.id);
      assert.ok(fs.existsSync(preview.absolutePath));
      voiceLibraryService.setStatus(asset.id, "archived");
      assert.throws(
        () => voiceLibraryService.resolveLibraryPreviewAudioPath(asset.id),
        /archived/,
      );
    });
  });

  it("未 heard 不可 approved；markLibraryPreviewHeard 后可升权", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src-heard.wav"));
      const asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "need-heard",
        displayName: "NeedHeard",
        license: { source: "test", rights: "internal" },
      });
      assert.throws(
        () => voiceLibraryService.setStatus(asset.id, "approved"),
        /heardAt|试听/,
      );
      const marked = voiceLibraryService.markLibraryPreviewHeard(asset.id, {
        heardBy: "test-op",
      });
      assert.ok(marked.review?.heardAt);
      assert.equal(marked.review?.heardBy, "test-op");
      assert.equal(marked.review?.heardSha256, asset.primaryFile.sha256);
      const approved = voiceLibraryService.setStatus(asset.id, "approved");
      assert.equal(approved.status, "approved");
      assert.ok(approved.review?.heardAt);
    });
  });

  it("同 sha 二次 mark 不改 heardAt；overwrite 清 review 须重听", async () => {
    await withIsolatedLibrary(async () => {
      const wavA = writeSilentPcmWav(path.join(TMP_ROOT, "src-a.wav"), { seed: 1 });
      let asset = voiceLibraryService.importFromFile({
        sourcePath: wavA,
        slug: "overwrite-heard",
        displayName: "OverwriteHeard",
        license: { source: "test", rights: "internal" },
      });
      const first = voiceLibraryService.markLibraryPreviewHeard(asset.id);
      assert.ok(first.review?.heardAt);
      const firstAt = first.review.heardAt;
      const firstSha = first.review.heardSha256;
      const second = voiceLibraryService.markLibraryPreviewHeard(asset.id);
      assert.equal(second.review?.heardAt, firstAt);
      assert.equal(second.review?.heardSha256, firstSha);

      const wavB = writeSilentPcmWav(path.join(TMP_ROOT, "src-b.wav"), { seed: 99 });
      asset = voiceLibraryService.importFromFile({
        sourcePath: wavB,
        slug: "overwrite-heard",
        displayName: "OverwriteHeard",
        license: { source: "test", rights: "internal" },
        overwrite: true,
      });
      assert.equal(asset.review, null);
      assert.notEqual(asset.primaryFile.sha256, firstSha);
      assert.throws(
        () => voiceLibraryService.setStatus(asset.id, "approved"),
        /heardAt|试听/,
      );
      const reheard = voiceLibraryService.markLibraryPreviewHeard(asset.id);
      assert.ok(reheard.review?.heardAt);
      assert.equal(reheard.review?.heardSha256, asset.primaryFile.sha256);
      const approved = voiceLibraryService.setStatus(asset.id, "approved");
      assert.equal(approved.status, "approved");
    });
  });

  it("旧 heardAt 无 heardSha256 或 sha 不匹配时拒绝 approved", async () => {
    await withIsolatedLibrary(async () => {
      const wav = writeSilentPcmWav(path.join(TMP_ROOT, "src-legacy.wav"), { seed: 3 });
      const asset = voiceLibraryService.importFromFile({
        sourcePath: wav,
        slug: "legacy-heard",
        displayName: "LegacyHeard",
        license: { source: "test", rights: "internal" },
      });
      voiceLibraryService.markLibraryPreviewHeard(asset.id);
      const marked = voiceLibraryService.getById(asset.id);
      const regFile = resolveGlobalVoiceRegistryPath();
      const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
      const idx = reg.assets.findIndex((a) => a.id === asset.id);
      assert.ok(idx >= 0);
      reg.assets[idx].review = {
        heardAt: marked.review.heardAt,
        heardBy: "legacy",
        heardSha256: "0".repeat(64),
      };
      fs.writeFileSync(regFile, `${JSON.stringify(reg, null, 2)}\n`);
      assert.throws(
        () => voiceLibraryService.setStatus(asset.id, "approved"),
        /不一致|重听|sha/i,
      );

      reg.assets[idx].review = {
        heardAt: marked.review.heardAt,
        heardBy: "legacy",
      };
      fs.writeFileSync(regFile, `${JSON.stringify(reg, null, 2)}\n`);
      assert.throws(
        () => voiceLibraryService.setStatus(asset.id, "approved"),
        /不一致|重听|sha|试听/i,
      );
    });
  });

});
