import fs from "node:fs";
import path from "node:path";

export interface WavFormatInfo {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function readUInt16LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

/**
 * 解析标准 PCM WAV（RIFF）。返回 fmt + data 位置；不拷贝整段 PCM。
 */
export function parseWavInfo(buffer: Buffer): WavFormatInfo {
  if (buffer.length < 44) {
    throw new Error("WAV 文件过短。");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是合法的 RIFF/WAVE 文件。");
  }

  let offset = 12;
  let fmt: Omit<WavFormatInfo, "dataOffset" | "dataSize"> | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = readUInt32LE(buffer, offset + 4);
    const chunkDataStart = offset + 8;
    const next = chunkDataStart + chunkSize + (chunkSize % 2);

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new Error("WAV fmt 块过短。");
      }
      fmt = {
        audioFormat: readUInt16LE(buffer, chunkDataStart),
        numChannels: readUInt16LE(buffer, chunkDataStart + 2),
        sampleRate: readUInt32LE(buffer, chunkDataStart + 4),
        byteRate: readUInt32LE(buffer, chunkDataStart + 8),
        blockAlign: readUInt16LE(buffer, chunkDataStart + 12),
        bitsPerSample: readUInt16LE(buffer, chunkDataStart + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkDataStart;
      dataSize = chunkSize;
      break;
    }

    offset = next;
  }

  if (!fmt) {
    throw new Error("WAV 缺少 fmt 块。");
  }
  if (dataOffset < 0) {
    throw new Error("WAV 缺少 data 块。");
  }
  if (fmt.audioFormat !== 1) {
    throw new Error(`仅支持 PCM WAV（audioFormat=1），当前为 ${fmt.audioFormat}。`);
  }

  return {
    ...fmt,
    dataOffset,
    dataSize,
  };
}

export function extractPcmFromWav(buffer: Buffer): { format: WavFormatInfo; pcm: Buffer } {
  const format = parseWavInfo(buffer);
  const end = Math.min(buffer.length, format.dataOffset + format.dataSize);
  const pcm = buffer.subarray(format.dataOffset, end);
  return { format, pcm };
}

export function buildWavBuffer(pcm: Buffer, format: Pick<
  WavFormatInfo,
  "numChannels" | "sampleRate" | "bitsPerSample"
>): Buffer {
  const numChannels = format.numChannels;
  const sampleRate = format.sampleRate;
  const bitsPerSample = format.bitsPerSample;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);

  return buffer;
}

/**
 * 拼接同格式 PCM WAV 文件列表（顺序）。空列表抛错。
 * 用于 chunk → chapter、chapter → full-book。
 */
export function concatWavFiles(inputPaths: string[], outputPath: string): {
  bytes: number;
  chunks: number;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
} {
  if (inputPaths.length === 0) {
    throw new Error("没有可拼接的 WAV 文件。");
  }

  let baseFormat: WavFormatInfo | null = null;
  const pcmParts: Buffer[] = [];

  for (const filePath of inputPaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`WAV 文件不存在：${filePath}`);
    }
    const raw = fs.readFileSync(filePath);
    const { format, pcm } = extractPcmFromWav(raw);
    if (!baseFormat) {
      baseFormat = format;
    } else if (
      format.numChannels !== baseFormat.numChannels
      || format.sampleRate !== baseFormat.sampleRate
      || format.bitsPerSample !== baseFormat.bitsPerSample
    ) {
      throw new Error(
        `WAV 格式不一致：期望 ${baseFormat.sampleRate}Hz/${baseFormat.numChannels}ch/${baseFormat.bitsPerSample}bit，`
        + `实际 ${format.sampleRate}Hz/${format.numChannels}ch/${format.bitsPerSample}bit（${filePath}）。`,
      );
    }
    if (pcm.length > 0) {
      pcmParts.push(pcm);
    }
  }

  if (!baseFormat) {
    throw new Error("无法解析 WAV 格式。");
  }

  const pcm = Buffer.concat(pcmParts);
  const out = buildWavBuffer(pcm, baseFormat);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, out);

  return {
    bytes: out.length,
    chunks: inputPaths.length,
    sampleRate: baseFormat.sampleRate,
    numChannels: baseFormat.numChannels,
    bitsPerSample: baseFormat.bitsPerSample,
  };
}

/** 静音 16-bit mono PCM 一段（毫秒），用于章间可选间隔；当前默认不用。 */
export function createSilentPcm(ms: number, sampleRate = 24_000, numChannels = 1): Buffer {
  const samples = Math.max(0, Math.floor((sampleRate * ms) / 1000));
  return Buffer.alloc(samples * numChannels * 2);
}
