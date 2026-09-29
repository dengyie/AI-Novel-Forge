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
 * 解析 PCM WAV（RIFF / RF64）。返回 fmt + data 位置；不拷贝整段 PCM。
 */
export function parseWavInfo(buffer: Buffer): WavFormatInfo {
  if (buffer.length < 44) {
    throw new Error("WAV 文件过短。");
  }
  const container = buffer.toString("ascii", 0, 4);
  if ((container !== "RIFF" && container !== "RF64") || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是合法的 RIFF/WAVE 文件。");
  }

  let rf64DataSize: number | null = null;
  let offset = 12;
  let fmt: Omit<WavFormatInfo, "dataOffset" | "dataSize"> | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = readUInt32LE(buffer, offset + 4);
    const chunkDataStart = offset + 8;
    const next = chunkDataStart + chunkSize + (chunkSize % 2);

    if (chunkId === "ds64" && container === "RF64") {
      if (chunkSize < 28 || chunkDataStart + 28 > buffer.length) throw new Error("RF64 ds64 块过短。");
      const size64 = buffer.readBigUInt64LE(chunkDataStart + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RF64 data 长度超过安全范围。");
      rf64DataSize = Number(size64);
    } else if (chunkId === "fmt ") {
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
      if (container === "RF64" && chunkSize === 0xffffffff) {
        if (rf64DataSize === null) throw new Error("RF64 缺少 ds64 长度。");
        dataSize = rf64DataSize;
      } else {
        dataSize = chunkSize;
      }
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

/** 校验磁盘 WAV 是否为可用 PCM（用于 resume）。 */
export function isValidPcmWavFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 44) {
      return false;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const header = Buffer.alloc(Math.min(stat.size, 12 * 1024));
      fs.readSync(fd, header, 0, header.length, 0);
      const info = parseWavInfo(header);
      const expectedEnd = info.dataOffset + info.dataSize;
      // 允许极小 rounding；文件不得短于 data 声明
      if (stat.size + 1 < expectedEnd) {
        return false;
      }
      if (info.dataSize < 2) {
        return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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
  const header = buildWavHeaderOnly(pcm.length, format);
  return Buffer.concat([header, pcm]);
}

function buildWavHeaderOnly(
  dataSize: number,
  format: Pick<WavFormatInfo, "numChannels" | "sampleRate" | "bitsPerSample">,
): Buffer {
  const numChannels = format.numChannels;
  const sampleRate = format.sampleRate;
  const bitsPerSample = format.bitsPerSample;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  if (!Number.isSafeInteger(dataSize) || dataSize < 0) throw new Error("WAV data 长度无效。");
  const large = dataSize + 36 > 0xffffffff;
  const buffer = Buffer.alloc(large ? 80 : 44);
  buffer.write(large ? "RF64" : "RIFF", 0, "ascii");
  buffer.writeUInt32LE(large ? 0xffffffff : 36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  let fmtOffset = 12;
  if (large) {
    buffer.write("ds64", 12, "ascii");
    buffer.writeUInt32LE(28, 16);
    buffer.writeBigUInt64LE(BigInt(dataSize) + 72n, 20);
    buffer.writeBigUInt64LE(BigInt(dataSize), 28);
    buffer.writeBigUInt64LE(BigInt(Math.floor(dataSize / blockAlign)), 36);
    buffer.writeUInt32LE(0, 44);
    fmtOffset = 48;
  }
  buffer.write("fmt ", fmtOffset, "ascii");
  buffer.writeUInt32LE(16, fmtOffset + 4);
  buffer.writeUInt16LE(1, fmtOffset + 8);
  buffer.writeUInt16LE(numChannels, fmtOffset + 10);
  buffer.writeUInt32LE(sampleRate, fmtOffset + 12);
  buffer.writeUInt32LE(byteRate, fmtOffset + 16);
  buffer.writeUInt16LE(blockAlign, fmtOffset + 20);
  buffer.writeUInt16LE(bitsPerSample, fmtOffset + 22);
  buffer.write("data", fmtOffset + 24, "ascii");
  buffer.writeUInt32LE(large ? 0xffffffff : dataSize, fmtOffset + 28);
  return buffer;
}

/**
 * 拼接同格式 PCM WAV 文件列表（顺序）。空列表抛错。
 * 流式写入：先扫格式与 dataSize，再写 header + 顺序 append PCM，避免全书 2× 内存。
 *
 * @param silenceBetweenMs 段间插入静音（毫秒）。长度应为 paths.length-1；
 *   缺省/更短则按 0；更长忽略多余项。仅支持 16-bit PCM（与 createSilentPcm 一致）。
 */
export function concatWavFiles(
  inputPaths: string[],
  outputPath: string,
  silenceBetweenMs?: ReadonlyArray<number>,
): {
  bytes: number;
  chunks: number;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  silenceInsertedMs: number;
} {
  if (inputPaths.length === 0) {
    throw new Error("没有可拼接的 WAV 文件。");
  }

  let baseFormat: WavFormatInfo | null = null;
  let totalDataSize = 0;
  const segments: Array<{ path: string; dataOffset: number; dataSize: number }> = [];

  for (const filePath of inputPaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`WAV 文件不存在：${filePath}`);
    }
    const stat = fs.statSync(filePath);
    const headerBuf = Buffer.alloc(Math.min(stat.size, 16 * 1024));
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
      const format = parseWavInfo(headerBuf);
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
      const available = Math.max(0, Math.min(format.dataSize, stat.size - format.dataOffset));
      segments.push({ path: filePath, dataOffset: format.dataOffset, dataSize: available });
      totalDataSize += available;
    } finally {
      fs.closeSync(fd);
    }
  }

  if (!baseFormat) {
    throw new Error("无法解析 WAV 格式。");
  }
  if (baseFormat.bitsPerSample !== 16) {
    throw new Error(`concat 仅支持 16-bit PCM，当前为 ${baseFormat.bitsPerSample}bit。`);
  }

  const gaps: number[] = [];
  let silenceInsertedMs = 0;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const raw = silenceBetweenMs?.[i];
    const ms = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    gaps.push(ms);
    if (ms > 0) {
      const silent = createSilentPcm(ms, baseFormat.sampleRate, baseFormat.numChannels);
      totalDataSize += silent.length;
      silenceInsertedMs += ms;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.part`;
  const header = buildWavHeaderOnly(totalDataSize, baseFormat);
  const outFd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(outFd, header, 0, header.length, 0);
    let writeOffset = header.length;
    const copyBuf = Buffer.alloc(1024 * 1024);
    for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
      const segment = segments[segIndex];
      if (segment.dataSize > 0) {
        const inFd = fs.openSync(segment.path, "r");
        try {
          let remaining = segment.dataSize;
          let readPos = segment.dataOffset;
          while (remaining > 0) {
            const toRead = Math.min(copyBuf.length, remaining);
            const n = fs.readSync(inFd, copyBuf, 0, toRead, readPos);
            if (n <= 0) {
              break;
            }
            fs.writeSync(outFd, copyBuf, 0, n, writeOffset);
            writeOffset += n;
            readPos += n;
            remaining -= n;
          }
        } finally {
          fs.closeSync(inFd);
        }
      }
      if (segIndex < gaps.length && gaps[segIndex] > 0) {
        const silent = createSilentPcm(gaps[segIndex], baseFormat.sampleRate, baseFormat.numChannels);
        fs.writeSync(outFd, silent, 0, silent.length, writeOffset);
        writeOffset += silent.length;
      }
    }
  } finally {
    fs.closeSync(outFd);
  }

  fs.renameSync(tmpPath, outputPath);
  const bytes = header.length + totalDataSize;

  return {
    bytes,
    chunks: inputPaths.length,
    sampleRate: baseFormat.sampleRate,
    numChannels: baseFormat.numChannels,
    bitsPerSample: baseFormat.bitsPerSample,
    silenceInsertedMs,
  };
}

/** 静音 16-bit mono PCM 一段（毫秒）。 */
export function createSilentPcm(ms: number, sampleRate = 24_000, numChannels = 1): Buffer {
  const samples = Math.max(0, Math.floor((sampleRate * ms) / 1000));
  return Buffer.alloc(samples * numChannels * 2);
}

/** 原子写 WAV 文件（.part → rename）。 */
export function writeWavFileAtomic(filePath: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.part`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);
}
