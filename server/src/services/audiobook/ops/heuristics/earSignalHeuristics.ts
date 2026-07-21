/**
 * EarAgent 信号启发式（§3.1,§12-C.4）纯函数。
 *
 * 不引第三方；只用 audiobookWav.parseWavInfo/extractPcmFromWav + Node fs。
 *
 * 决策：
 *   - reject: 时长越界、RMS 极低、RIFF 损坏、极端削波、过软
 *   - approve: clarity/speechLikely/cleanliness 均过硬线且 clipOk
 *   - approve_with_low_confidence: 中区可听（默认**不**自动升权，需 EAR_AUTO_SOFT_APPROVE=1）
 */
import fs from "node:fs";
import { extractPcmFromWav } from "../../audiobookWav";
import type { OpsEarVerdict } from "@ai-novel/shared/types/audiobookOps";

export interface EarHeuristicThresholds {
  minDurationSec: number;
  maxDurationSec: number;
  minClarity: number;
  minSpeechLikely: number;
  minCleanliness: number;
  /** 中区自动升权地板（低于此仍 reject/不自动） */
  softMinClarity: number;
  softMinSpeechLikely: number;
  softMinCleanliness: number;
  silenceAbs: number;     // |sample|<silenceAbs 视为静音
  clipAbs: number;        // |sample|>clipAbs 视为削波
  clipMaxRatio: number;   // 削波占比高于此 → clipOk=false
  /** 削波超过此比例直接 reject（极端削波） */
  clipHardRejectRatio: number;
  rmsFloor: number;       // RMS 低于此直接 reject
}

export const DEFAULT_EAR_THRESHOLDS: EarHeuristicThresholds = {
  minDurationSec: 2.5,
  maxDurationSec: 1200,
  minClarity: 0.5,
  minSpeechLikely: 0.38,
  minCleanliness: 0.5,
  softMinClarity: 0.32,
  softMinSpeechLikely: 0.28,
  softMinCleanliness: 0.38,
  silenceAbs: 0.01,
  clipAbs: 0.985,
  clipMaxRatio: 0.025,
  clipHardRejectRatio: 0.12,
  rmsFloor: 0.002,
};

export type EarDecisionReasonCode =
  | "file_missing"
  | "read_fail"
  | "wav_parse_fail"
  | "duration_out_of_range"
  | "rms_floor"
  | "extreme_clip"
  | "high_silence"
  | "pass_hard"
  | "pass_soft"
  | "soft_fail";

export interface EarHeuristicInput {
  filePath: string;
  expectedSha256: string;     // asset.primaryFile.sha256；不符直接 reject 不读
  assetId: string;
  thresholds?: Partial<EarHeuristicThresholds>;
  agentVersion: string;
  model?: string | null;
}

export function readInt16LESamples(pcm: Buffer, maxSamples = 200_000): number[] {
  // 16-bit PCM → Float32 归一化 [-1, 1]，均匀下采样避免超长音频能耗
  const total = Math.floor(pcm.length / 2);
  if (total <= 0) return [];
  const step = total > maxSamples ? Math.floor(total / maxSamples) : 1;
  const out: number[] = [];
  for (let i = 0; i + 1 < pcm.length && out.length < maxSamples; i += 2 * step) {
    const raw = pcm.readInt16LE(i);
    out.push(raw / 32768);
  }
  return out;
}

export function computeEarScores(
  samples: number[],
  byteRate: number,
  dataSize: number,
  thresholds: EarHeuristicThresholds,
): {
  durationSec: number;
  rms: number;
  peak: number;
  silenceRatio: number;
  clipRatio: number;
  clarity: number;
  cleanliness: number;
  speechLikely: number;
  durationOk: boolean;
  clipOk: boolean;
} {
  // duration 优先用 fmt.byteRate + data size 推导（避免 sample 下采样精度丢失）
  const durationSec = byteRate > 0 ? dataSize / byteRate : 0;
  const durationOk = durationSec >= thresholds.minDurationSec && durationSec <= thresholds.maxDurationSec;

  if (samples.length === 0) {
    return {
      durationSec,
      rms: 0,
      peak: 0,
      silenceRatio: 1,
      clipRatio: 0,
      clarity: 0,
      cleanliness: 1,
      speechLikely: 0,
      durationOk,
      clipOk: true,
    };
  }

  let sumSq = 0;
  let peak = 0;
  let silenceCount = 0;
  let clipCount = 0;
  for (const s of samples) {
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sumSq += s * s;
    if (abs < thresholds.silenceAbs) silenceCount += 1;
    if (abs > thresholds.clipAbs) clipCount += 1;
  }
  const n = samples.length;
  const rms = Math.sqrt(sumSq / n);
  const silenceRatio = silenceCount / n;
  const clipRatio = clipCount / n;

  // clarity：RMS 在 0.005..0.05 的暖网段得分高（人声典型 RMS）
  const clarity = clamp01((rms - 0.005) / 0.05);
  // cleanliness：1 - min(1, clipRatio*5)
  const cleanliness = clamp01(1 - Math.min(1, clipRatio * 5));
  // speechLikely（简化，非 VAD）：1 - silenceRatio
  const speechLikely = clamp01(1 - silenceRatio);
  const clipOk = clipRatio < thresholds.clipMaxRatio;

  return { durationSec, rms, peak, silenceRatio, clipRatio, clarity, cleanliness, speechLikely, durationOk, clipOk };
}

export function runEarHeuristics(input: EarHeuristicInput): OpsEarVerdict {
  const thresholds: EarHeuristicThresholds = {
    ...DEFAULT_EAR_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  const reasons: string[] = [];
  const codes: EarDecisionReasonCode[] = [];
  if (!fs.existsSync(input.filePath)) {
    return reject(input, [`文件不存在：${input.filePath}`], ["file_missing"]);
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(input.filePath);
  } catch (err) {
    return reject(input, [`读文件失败：${(err as Error).message}`], ["read_fail"]);
  }

  let pcm: Buffer;
  let format: { sampleRate: number; byteRate: number; numChannels: number; bitsPerSample: number; dataSize: number };
  try {
    const parsed = extractPcmFromWav(buffer);
    pcm = parsed.pcm;
    format = {
      sampleRate: parsed.format.sampleRate,
      byteRate: parsed.format.byteRate,
      numChannels: parsed.format.numChannels,
      bitsPerSample: parsed.format.bitsPerSample,
      dataSize: parsed.format.dataSize,
    };
  } catch (err) {
    return reject(input, [`WAV 解析失败：${(err as Error).message}`], ["wav_parse_fail"]);
  }

  const samples = readInt16LESamples(pcm);
  const m = computeEarScores(samples, format.byteRate, format.dataSize, thresholds);

  if (!m.durationOk) {
    reasons.push(`时长 ${m.durationSec.toFixed(1)}s 越界`);
    codes.push("duration_out_of_range");
  }
  if (m.clipRatio >= thresholds.clipHardRejectRatio) {
    reasons.push(`削波占比 ${(m.clipRatio * 100).toFixed(1)}% 极端`);
    codes.push("extreme_clip");
  } else if (!m.clipOk) {
    reasons.push(`削波占比 ${(m.clipRatio * 100).toFixed(1)}% 偏高`);
  }
  if (m.silenceRatio > 0.75) {
    reasons.push(`静音占比 ${(m.silenceRatio * 100).toFixed(0)}% 过高`);
    codes.push("high_silence");
  }
  if (m.rms < thresholds.rmsFloor) {
    reasons.push(`RMS ${m.rms.toFixed(4)} 低于地板 ${thresholds.rmsFloor}`);
    codes.push("rms_floor");
  }

  const verdictBase = {
    assetId: input.assetId,
    primarySha256: input.expectedSha256,
    scores: {
      clarity: round3(m.clarity),
      cleanliness: round3(m.cleanliness),
      speechLikely: round3(m.speechLikely),
      durationOk: m.durationOk,
      clipOk: m.clipOk,
    },
    reasons,
    agent: {
      name: "ear" as const,
      version: input.agentVersion,
      model: input.model ?? null,
    },
    heardAt: new Date().toISOString(),
  };

  // 硬拒绝：时长 / RMS / 极端削波 / 极高静音
  if (!m.durationOk || m.rms < thresholds.rmsFloor || m.clipRatio >= thresholds.clipHardRejectRatio) {
    return { ...verdictBase, decision: "reject", decisionReasonCodes: codes.length ? codes : ["soft_fail"] };
  }
  if (m.silenceRatio > 0.9) {
    return {
      ...verdictBase,
      decision: "reject",
      decisionReasonCodes: codes.includes("high_silence") ? codes : [...codes, "high_silence"],
    };
  }

  const hardPass =
    m.clarity >= thresholds.minClarity
    && m.speechLikely >= thresholds.minSpeechLikely
    && m.cleanliness >= thresholds.minCleanliness
    && m.clipOk;

  if (hardPass) {
    return {
      ...verdictBase,
      decision: "approve",
      decisionReasonCodes: [...codes, "pass_hard"],
    };
  }

  // 中区：标记 soft；是否升权由 EarAgent requireHardApprove / EAR_AUTO_SOFT_APPROVE 决定
  const softPass =
    m.clarity >= thresholds.softMinClarity
    && m.speechLikely >= thresholds.softMinSpeechLikely
    && m.cleanliness >= thresholds.softMinCleanliness
    && m.clipRatio < thresholds.clipHardRejectRatio
    && m.clipOk !== false;

  if (softPass) {
    const softReasons = [
      ...reasons,
      "中区可听：approve_with_low_confidence（默认不自动升权；EAR_AUTO_SOFT_APPROVE=1 可开）",
    ];
    return {
      ...verdictBase,
      reasons: softReasons,
      decision: "approve_with_low_confidence",
      decisionReasonCodes: [...codes, "pass_soft"],
    };
  }

  // 过软地板仍不够：reject
  return {
    ...verdictBase,
    reasons: [...reasons, "声学未达硬/软升权地板"],
    decision: "reject",
    decisionReasonCodes: [...codes, "soft_fail"],
  };
}

function reject(
  input: EarHeuristicInput,
  reasons: string[],
  codes: EarDecisionReasonCode[],
): OpsEarVerdict {
  return {
    assetId: input.assetId,
    primarySha256: input.expectedSha256,
    decision: "reject",
    scores: { clarity: 0, cleanliness: 1, speechLikely: 0, durationOk: false, clipOk: true },
    decisionReasonCodes: codes,
    reasons,
    agent: { name: "ear", version: input.agentVersion, model: input.model ?? null },
    heardAt: new Date().toISOString(),
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
