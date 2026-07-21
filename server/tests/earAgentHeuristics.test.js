/**
 * EarAgent + 启发式 + §D 进程内 approve 门禁（阶段 2）。
 *
 * SoT: docs/plans/audiobook-ai-ops-agents-plan.md §6,§12-D,F,J
 *
 * 覆盖：
 *  - 三种 WAV fixture → verdict（silent→reject、noise→approve/needs_human、clip→needs_human/reject）
 *  - sha 不对齐拒绝（不写 heard，不升权）
 *  - 不设 token + allow_open=0 + skipApprove=false → gateBlocked 计数 + decision 转 needs_human
 *  - 设 allow_open=1 → setStatus 内建门禁跑通 → approved
 *  - 后续子测：force_keep/force_reject override 影响 verdict
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ear-agent-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;
process.env.AI_NOVEL_DB_ENGINE = "memory";

const { earAgent } = require("../dist/services/audiobook/ops/agents/EarAgent");
const { runEarHeuristics, computeEarScores, readInt16LESamples } = require("../dist/services/audiobook/ops/heuristics/earSignalHeuristics");
const { voiceLibraryService, resolveVoiceAssetStoredPath } = require("../dist/services/audiobook/voiceLibraryService");
const { resolveGlobalVoiceLibraryRoot } = require("../dist/services/audiobook/audiobookPaths");
const { clearOpsStorageForTests } = require("../dist/services/audiobook/ops/OpsRunStorage");

function writeWav(filePath, pcmSamples, { rate = 24000 } = {}) {
  const dataSize = pcmSamples.length * 2;
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
  for (let i = 0; i < pcmSamples.length; i += 1) {
    buf.writeInt16LE(pcmSamples[i], 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function silentPcm(seconds, rate = 24000) {
  const n = Math.floor(rate * seconds);
  return new Array(n).fill(0);
}

function normalSpeechPcm(seconds, rate = 24000) {
  // 包络正弦波模拟人声 RMS ~0.045（暖段，clarity ≥ 0.55 通过）
  // 同时峰值约 ±0.2 远低于 0.985 → clipOk=true
  const n = Math.floor(rate * seconds);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.5 * t);
    const carrier = Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 440 * t) * 0.3;
    // 用更大 amp 0.2 使 rms ≈ 0.055 → clarity = (0.055-0.005)/0.05 = 1.0
    out[i] = Math.floor(carrier * env * 0.2 * 32768);
  }
  return out;
}

function clippedPcm(seconds, rate = 24000) {
  // 全饱和到 ±32700，保证几乎 100% 的样本 |x|>0.985 → clipRatio≈1 ≫ 0.02 → clipOk=false
  const n = Math.floor(rate * seconds);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const raw = Math.sin(2 * Math.PI * 220 * t);
    out[i] = Math.sign(raw) * 32700;
  }
  return out;
}

const LICENSE = { source: "test", rights: "internal-test-only" };

function importWavAsDraft(slug, filePath) {
  return voiceLibraryService.importFromFile({
    sourcePath: filePath,
    slug,
    displayName: slug,
    license: LICENSE,
    backendTargets: ["mimo_chat_audio"],
  });
}

function wipeLibrary() {
  fs.rmSync(resolveGlobalVoiceLibraryRoot(), { recursive: true, force: true });
}

describe("earAgentHeuristics (阶段 2)", () => {
  before(() => {
    wipeLibrary();
    clearOpsStorageForTests();
  });

  after(() => {
    wipeLibrary();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    wipeLibrary();
    // 清掉所有可能残留的 env
    delete process.env.VOICE_LIBRARY_APPROVE_TOKEN;
    delete process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE;
    delete process.env.EAR_AUTO_SOFT_APPROVE;
  });

  it("silent WAV → reject", () => {
    const wav = writeWav(path.join(TMP_ROOT, "silent.wav"), silentPcm(5));
    const asset = importWavAsDraft("silent-asset", wav);
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: true });
    assert.equal(result.verdicts.length, 1);
    const v = result.verdicts[0];
    assert.equal(v.decision, "reject", `silent 应 reject，actual=${v.decision} reasons=${JSON.stringify(v.reasons)}`);
    assert.ok(v.reasons.some((r) => /RMS|时长|静音/.test(r)), `reasons 应提及 RMS/时长/静音：${JSON.stringify(v.reasons)}`);
  });

  it("clipped WAV → reject 或 approve_with_low_confidence（clipOk=false；极端削波 reject）", () => {
    const wav = writeWav(path.join(TMP_ROOT, "clip.wav"), clippedPcm(5));
    const asset = importWavAsDraft("clip-asset", wav);
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: true });
    const v = result.verdicts[0];
    assert.ok(
      v.decision === "reject" || v.decision === "approve_with_low_confidence",
      `clip 应 reject/low_confidence，actual=${v.decision}`,
    );
    assert.equal(v.scores.clipOk, false);
  });

  it("中区 soft 默认不升权；EAR_AUTO_SOFT_APPROVE=1 才 soft 升", () => {
    // 较低 RMS 正弦，落 soft 区
    const rate = 24000;
    const n = rate * 6;
    const pcm = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = i / rate;
      pcm[i] = Math.floor(Math.sin(2 * Math.PI * 180 * t) * 0.035 * 32768);
    }
    const wav = writeWav(path.join(TMP_ROOT, "soft.wav"), pcm);
    const asset = importWavAsDraft("soft-asset", wav);
    delete process.env.EAR_AUTO_SOFT_APPROVE;
    const dry = earAgent.run({ assetIds: [asset.id], skipApprove: true });
    const d = dry.verdicts[0].decision;
    assert.ok(
      d === "approve" || d === "approve_with_low_confidence",
      `中区应 soft/hard，actual=${d} scores=${JSON.stringify(dry.verdicts[0].scores)}`,
    );
    // 默认 requireHard：soft 不升权
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "1";
    const held = earAgent.run({ assetIds: [asset.id], skipApprove: false });
    if (dry.verdicts[0].decision === "approve_with_low_confidence") {
      assert.equal(held.approve.approved, 0, `默认 soft 应不升：${JSON.stringify(held.approve)}`);
      assert.ok(held.approve.skipped >= 1, JSON.stringify(held.approve));
    }
    // 显式开 soft
    process.env.EAR_AUTO_SOFT_APPROVE = "1";
    const soft = earAgent.run({ assetIds: [asset.id], skipApprove: false, requireHardApprove: false });
    if (dry.verdicts[0].decision === "approve_with_low_confidence" || dry.verdicts[0].decision === "approve") {
      assert.equal(soft.approve.approved, 1, JSON.stringify(soft.approve));
    }
    delete process.env.EAR_AUTO_SOFT_APPROVE;
  });

  it("正常人声 WAV → approve（heuristic 通过）", () => {
    const wav = writeWav(path.join(TMP_ROOT, "speech.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("speech-asset", wav);
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: true });
    const v = result.verdicts[0];
    assert.equal(v.decision, "approve", `正常人声应 approve，actual=${v.decision} scores=${JSON.stringify(v.scores)} reasons=${JSON.stringify(v.reasons)}`);
    assert.ok(v.scores.clarity >= 0.55, `clarity=${v.scores.clarity} 应 >=0.55`);
    assert.equal(v.scores.clipOk, true);
    assert.equal(v.scores.durationOk, true);
  });

  it("sha 不对齐 → reject + 不写 heard（不调 setStatus）", () => {
    const wav = writeWav(path.join(TMP_ROOT, "tampered.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("tamper-asset", wav);
    // import 会把源 wav 复制到 asset.primaryFile.path → 覆写 destPath（即 asset 真正读取的文件）使 sha 变
    const destAbs = resolveVoiceAssetStoredPath(asset.primaryFile.path);
    assert.ok(destAbs, "dest path 应可解析");
    writeWav(destAbs, normalSpeechPcm(7));
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: true });
    const v = result.verdicts[0];
    assert.equal(v.decision, "reject");
    assert.ok(v.reasons.some((r) => /sha 不一致/.test(r)), `应提及 sha 不一致：${JSON.stringify(v.reasons)}`);
    assert.equal(result.approve.rejected, 1);
    assert.equal(result.approve.approved, 0);
  });

  it("无 token + allow_open=0 + skipApprove=false → gateBlocked 计数 + decision 转 needs_human", () => {
    const wav = writeWav(path.join(TMP_ROOT, "speech2.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("speech2-asset", wav);
    delete process.env.VOICE_LIBRARY_APPROVE_TOKEN;
    delete process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE;
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: false });
    assert.equal(result.approve.gateBlocked, 1, `gateBlocked 应=1，approve=${JSON.stringify(result.approve)}`);
    assert.equal(result.approve.approved, 0);
    assert.equal(result.verdicts[0].decision, "needs_human");
    assert.ok(result.verdicts[0].reasons.some((r) => /门禁阻断|token|allow_open/.test(r)), JSON.stringify(result.verdicts[0].reasons));
  });

  it("设 allow_open=1 → setStatus 内建门禁跑通 → approved", () => {
    const wav = writeWav(path.join(TMP_ROOT, "speech3.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("speech3-asset", wav);
    // 模拟 license 不齐全的 clone_ref 会失败；这里 kind 默认=clone_ref 升 approved 前须 license.source/rights + heardAt
    // 已 LICENSE.source/rights 已设 + heardAt 经 markLibraryPreviewHeard 已写
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "1";
    const result = earAgent.run({ assetIds: [asset.id], skipApprove: false });
    assert.equal(result.approve.approved, 1, `approved 应=1，approve=${JSON.stringify(result.approve)}`);
    // 库行 status 应为 approved
    const after = voiceLibraryService.list({ status: ["approved"] }).items.find((a) => a.id === asset.id);
    assert.ok(after, "升 approved 后应在 approved list 中找到");
  });

  it("force_keep_draft override → 不升权（即便 heuristic=approve）", () => {
    const wav = writeWav(path.join(TMP_ROOT, "force.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("force-asset", wav);
    process.env.AUDIOBOOK_OPS_ALLOW_OPEN_APPROVE = "1";
    const result = earAgent.run({
      assetIds: [asset.id],
      skipApprove: false,
      isForceKeepDraft: (id) => id === asset.id,
    });
    const v = result.verdicts[0];
    assert.notEqual(v.decision, "approve");
    assert.ok(v.reasons.some((r) => /forceKeepDraft/.test(r)));
    assert.equal(result.approve.approved, 0);
  });

  it("force_reject override → 强制 reject", () => {
    const wav = writeWav(path.join(TMP_ROOT, "force-r.wav"), normalSpeechPcm(8));
    const asset = importWavAsDraft("force-r-asset", wav);
    const result = earAgent.run({
      assetIds: [asset.id],
      skipApprove: true,
      isForceReject: (id) => id === asset.id,
    });
    assert.equal(result.verdicts[0].decision, "reject");
    assert.ok(result.verdicts[0].reasons.some((r) => /forceReject/.test(r)));
  });

  it("纯启发式不读库：runEarHeuristics 对损坏 RIFF 抛错被 catch 为 reject", () => {
    const bogusPath = path.join(TMP_ROOT, "bogus.wav");
    fs.writeFileSync(bogusPath, Buffer.from("NOTRIFFNOTWAVE--------"));
    const verdict = runEarHeuristics({
      filePath: bogusPath,
      expectedSha256: crypto.createHash("sha256").update("NOTRIFF").digest("hex"),
      assetId: "va_bogus",
      agentVersion: "1",
    });
    assert.equal(verdict.decision, "reject");
    assert.ok(verdict.reasons.some((r) => /WAV 解析失败|parseWavInfo/.test(r)) || /WAV/.test(verdict.reasons.join(" ")));
  });

  it("computeEarScores 静音 → clarity/speechLikely 低", () => {
    const samples = new Array(1000).fill(0);
    const m = computeEarScores(samples, 48000, 1000 * 2, {
      minDurationSec: 0,
      maxDurationSec: 100,
      minClarity: 0.5,
      minSpeechLikely: 0.4,
      minCleanliness: 0.5,
      softMinClarity: 0.32,
      softMinSpeechLikely: 0.28,
      softMinCleanliness: 0.38,
      silenceAbs: 0.01,
      clipAbs: 0.985,
      clipMaxRatio: 0.02,
      clipHardRejectRatio: 0.12,
      rmsFloor: 0.0001,
    });
    assert.ok(m.silenceRatio > 0.9);
    assert.ok(m.rms < 0.0001);
  });

  it("readInt16LESamples 下采样返回有限浮点", () => {
    const buf = Buffer.alloc(2 * 10000);
    for (let i = 0; i < 10000; i += 1) buf.writeInt16LE(Math.floor(Math.sin(i) * 32767), i * 2);
    const s = readInt16LESamples(buf, 100);
    assert.equal(s.length, 100);
    for (const x of s) {
      assert.ok(x >= -1 && x <= 1, `sample 范围 [-1,1]，实际=${x}`);
    }
  });
});
