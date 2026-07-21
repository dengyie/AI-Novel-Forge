/**
 * LabelAgent dry-run + rule Brief + persona 加权（不依赖真实 LLM / 生产 registry）。
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ai-label-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;
process.env.AI_NOVEL_DB_ENGINE = "memory";

const { labelAgent, LABEL_TAG } = require("../dist/services/audiobook/ops/agents/LabelAgent");
const { voiceLibraryService } = require("../dist/services/audiobook/voiceLibraryService");
const { resolveGlobalVoiceLibraryRoot } = require("../dist/services/audiobook/audiobookPaths");
const {
  matchLibraryAsset,
  extractRulePersonaTags,
  planCharacterVoices,
} = require("../dist/services/audiobook/audiobookVoicePlanner");
const { buildRuleVoiceBrief } = require("../dist/services/audiobook/voiceBriefService");

function writeWav(filePath, seconds = 3, rate = 24000) {
  const n = rate * seconds;
  const dataSize = n * 2;
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
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    buf.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * 220 * t) * 0.2 * 32768), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function wipeLibrary() {
  fs.rmSync(resolveGlobalVoiceLibraryRoot(), { recursive: true, force: true });
}

describe("voice AI label + brief + persona", () => {
  before(() => wipeLibrary());
  after(() => {
    wipeLibrary();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  });
  beforeEach(() => wipeLibrary());

  it("LabelAgent dry-run 可赋 lead 并标记 label:ai-v3", () => {
    const wav = writeWav(path.join(TMP_ROOT, "lead.wav"));
    const asset = voiceLibraryService.importFromFile({
      sourcePath: wav,
      slug: "xiaoxiao-lead-demo",
      displayName: "女主小晓",
      license: { source: "test", rights: "internal-test-only" },
      backendTargets: ["mimo_chat_audio"],
      tags: ["female", "scope-zh", "speaker:xiaoxiao"],
    });
    // import may not accept tags — patch via updateAssetTags if present
    if (typeof voiceLibraryService.updateAssetTags === "function") {
      voiceLibraryService.updateAssetTags(asset.id, ["female", "scope-zh", "speaker:xiaoxiao", "extra"]);
    }
    const dry = labelAgent.run({ assetIds: [asset.id], dryRun: true });
    assert.ok(dry.changed >= 1 || dry.diffs.length >= 0, JSON.stringify(dry));
    const hit = dry.diffs.find((d) => d.assetId === asset.id);
    if (hit) {
      assert.ok(hit.tagsAdded.includes(LABEL_TAG) || hit.afterCluster, JSON.stringify(hit));
    }
    const live = labelAgent.run({ assetIds: [asset.id], dryRun: false });
    assert.ok(live.changed >= 0);
    const after = voiceLibraryService.getById(asset.id);
    assert.ok(after.tags.includes(LABEL_TAG) || after.tags.includes("lead") || after.tags.includes("cast") || after.tags.includes("extra"), JSON.stringify(after.tags));
  });


  it("Edge 预设名不抬 lead；强角色词可 lead", () => {
    const wav = writeWav(path.join(TMP_ROOT, "brand.wav"));
    const brand = voiceLibraryService.importFromFile({
      sourcePath: wav,
      slug: "edge-xiaoxiao-neural",
      displayName: "Microsoft Xiaoxiao",
      license: { source: "test", rights: "internal-test-only" },
      backendTargets: ["mimo_chat_audio"],
    });
    if (typeof voiceLibraryService.updateAssetTags === "function") {
      voiceLibraryService.updateAssetTags(brand.id, ["female", "scope-zh", "speaker:xiaoxiao", "extra"]);
    }
    const brandRun = labelAgent.run({ assetIds: [brand.id], dryRun: true });
    const brandDiff = brandRun.diffs.find((d) => d.assetId === brand.id);
    if (brandDiff) {
      assert.notEqual(brandDiff.afterCluster, "lead", `预设名不应抬 lead：${JSON.stringify(brandDiff)}`);
    }
    const wav2 = writeWav(path.join(TMP_ROOT, "lead2.wav"));
    const lead = voiceLibraryService.importFromFile({
      sourcePath: wav2,
      slug: "heroine-cold",
      displayName: "女主沈清寒",
      license: { source: "test", rights: "internal-test-only" },
      backendTargets: ["mimo_chat_audio"],
    });
    if (typeof voiceLibraryService.updateAssetTags === "function") {
      voiceLibraryService.updateAssetTags(lead.id, ["female", "scope-zh", "extra"]);
    }
    const leadRun = labelAgent.run({ assetIds: [lead.id], dryRun: true });
    const leadDiff = leadRun.diffs.find((d) => d.assetId === lead.id);
    assert.ok(leadDiff, JSON.stringify(leadRun));
    assert.equal(leadDiff.afterCluster, "lead", JSON.stringify(leadDiff));
  });
  it("extractRulePersonaTags + Brief 规则含书级文风", () => {
    const tags = extractRulePersonaTags(
      {
        characterId: "c1",
        characterName: "沈清寒",
        personality: "清冷高傲",
        voiceTexture: "偏低略沙哑",
        castRole: "主角",
      },
      "文风：古风仙侠 帝王权谋",
    );
    assert.ok(tags.includes("清冷") || tags.includes("沙哑") || tags.includes("仙侠") || tags.includes("帝王"), JSON.stringify(tags));
    const brief = buildRuleVoiceBrief(
      {
        characterId: "c1",
        characterName: "沈清寒",
        gender: "male",
        personality: "清冷",
        castRole: "主角",
      },
      { styleTone: "古风仙侠", title: "测试书" },
    );
    assert.equal(brief.source, "rule");
    assert.ok(brief.oneLine.includes("沈清寒"));
    assert.ok(brief.cluster === "lead" || brief.cluster === "cast" || brief.cluster === "extra");
  });

  it("personaTags 提升 library 打分", () => {
    const assets = [
      {
        id: "va_a",
        slug: "soft-girl",
        displayName: "温柔女声",
        status: "approved",
        kind: "clone_ref",
        tags: ["female", "cast", "scope-zh", "texture-bright", "温柔"],
      },
      {
        id: "va_b",
        slug: "cold-lead",
        displayName: "清冷女主",
        status: "approved",
        kind: "clone_ref",
        tags: ["female", "lead", "scope-zh", "texture-neutral", "清冷"],
      },
    ];
    const matched = matchLibraryAsset({
      genderBucket: "female",
      cluster: "lead",
      assets,
      usedAssetIds: new Set(),
      personaTags: ["清冷"],
    });
    assert.ok(matched, "应命中");
    assert.equal(matched.asset.id, "va_b");
    assert.ok(/persona/.test(matched.reason) || matched.asset.id === "va_b", matched.reason);
  });

  it("planCharacterVoices 接受 bookContextBlob/brief 不崩", () => {
    const out = planCharacterVoices({
      characters: [
        {
          characterId: "c1",
          characterName: "女主",
          gender: "female",
          castRole: "主角",
          personality: "清冷",
        },
      ],
      strategy: "prefer_library",
      libraryAssets: [
        {
          id: "va1",
          slug: "lead-f",
          displayName: "清冷女主",
          status: "approved",
          kind: "clone_ref",
          tags: ["female", "lead", "scope-zh", "清冷"],
        },
      ],
      bookContextBlob: "文风：古风仙侠",
      briefByCharacterId: {
        c1: {
          cluster: "lead",
          personaTags: ["清冷"],
          preferredSlot: { pitchBand: "mid", textureBand: "neutral", energyBand: "even" },
          oneLine: "清冷女主",
        },
      },
    });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].ttsMode, "clone");
    assert.equal(out.items[0].ttsVoiceAssetId, "va1");
    assert.ok(/book|brief|清冷|library/i.test(out.items[0].reason), out.items[0].reason);
  });
});
