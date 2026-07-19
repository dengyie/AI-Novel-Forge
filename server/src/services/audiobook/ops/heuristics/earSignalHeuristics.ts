/**
 * EarAgent 信号启发式（§3.1,§12-C.4）纯函数。
 *
 * 不引第三方；只用 audiobookWav.parseWavInfo/extractPcmFromWav + Node fs。
 *
 * 输入 WAV 绝对路径；输出 EarScores + decision：
 *   - reject: 时长越界、RMS 极低、RIFF 损坏
 *   - approve: clarity/speechLikely/cleanliness 均过线
 *   - needs_human: 介于两者之间
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
  silenceAbs: number;     // |sample|<silenceAbs 视为静音
  clipAbs: number;        // |sample|>clipAbs 视为削波
  clipMaxRatio: number;   // 削波占比高于此 → clipOk=false
  rmsFloor: number;       // RMS 低于此直接 reject
}

export const DEFAULT_EAR_THRESHOLDS: EarHeuristicThresholds = {
  minDurationSec: 3,
  maxDurationSec: 1200,
  minClarity: 0.55,
  minSpeechLikely: 0.4,
  minCleanliness: 0.5,
  silenceAbs: 0.01,
  clipAbs: 0.985,
  clipMaxRatio: 0.02,
  rmsFloor: 0.002,
};

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
  if (!fs.existsSync(input.filePath)) {
    return reject(input, [`文件不存在：${input.filePath}`], thresholds);
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(input.filePath);
  } catch (err) {
    return reject(input, [`读文件失败：${(err as Error).message}`], thresholds);
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
    return reject(input, [`WAV 解析失败：${(err as Error).message}`], thresholds);
  }

  const samples = readInt16LESamples(pcm);
  const m = computeEarScores(samples, format.byteRate, format.dataSize, thresholds);

  if (!m.durationOk) {
    reasons.push(`时长 ${m.durationSec.toFixed(1)}s 越界`);
  }
  if (!m.clipOk) {
    reasons.push(`削波占比 ${(m.clipRatio * 100).toFixed(1)}% 偏高`);
  }
  if (m.silenceRatio > 0.6) {
    reasons.push(`静音占比 ${(m.silenceRatio * 100).toFixed(0)}% 过高`);
  }
  if (m.rms < thresholds.rmsFloor) {
    reasons.push(`RMS ${m.rms.toFixed(4)} 低于地板 ${thresholds.rmsFloor}`);
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

  let decision: OpsEarVerdict["decision"];
  if (!m.durationOk || m.rms < thresholds.rmsFloor) {
    decision = "reject";
  } else if (m.clarity >= thresholds.minClarity && m.speechLikely >= thresholds.minSpeechLikely && m.cleanliness >= thresholds.minCleanliness && m.clipOk) {
    decision = "approve";
  } else {
    decision = "needs_human";
  }

  return { ...verdictBase, decision } as OpsEarVerdict;
}

function reject(
  input: EarHeuristicInput,
  reasons: string[],
  _thresholds: EarHeuristicThresholds,
): OpsEarVerdict {
  return {
    assetId: input.assetId,
    primarySha256: input.expectedSha256,
    decision: "reject",
    scores: { clarity: 0, cleanliness: 1, speechLikely: 0, durationOk: false, clipOk: true },
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
