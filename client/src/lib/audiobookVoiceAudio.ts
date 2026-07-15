/**
 * 有声书试听音频工具：base64 → object URL，并在 src 变化时尝试自动播放。
 * 人物卡与有声书面板共用，避免两套 atob / revoke 逻辑分叉。
 */

export type WavAudioInspection = {
  byteLength: number;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  isWav: boolean;
  reason?: string;
};

function stripDataUrlBase64(audioBase64: string): string {
  if (!audioBase64.includes(",")) {
    return audioBase64;
  }
  return audioBase64.split(",").pop() ?? audioBase64;
}

function decodeBase64ToBytes(audioBase64: string): Uint8Array {
  const bare = stripDataUrlBase64(audioBase64).replace(/\s+/g, "");
  if (!bare) {
    throw new Error("试听音频 base64 为空。");
  }
  let binary: string;
  try {
    binary = atob(bare);
  } catch {
    throw new Error("试听音频 base64 无法解码。");
  }
  if (!binary) {
    throw new Error("试听音频解码后为空。");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function readFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** 解析 WAV 头，用于试听前拒绝「能解码但时长为 0」的坏包。 */
export function inspectWavAudioBase64(audioBase64: string): WavAudioInspection {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64ToBytes(audioBase64);
  } catch (error) {
    return {
      byteLength: 0,
      durationSec: null,
      sampleRate: null,
      channels: null,
      isWav: false,
      reason: error instanceof Error ? error.message : "试听音频无法解码。",
    };
  }
  if (bytes.byteLength < 44) {
    return {
      byteLength: bytes.byteLength,
      durationSec: null,
      sampleRate: null,
      channels: null,
      isWav: false,
      reason: `音频过短（${bytes.byteLength} bytes），不像有效 WAV。`,
    };
  }

  if (readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WAVE") {
    return {
      byteLength: bytes.byteLength,
      durationSec: null,
      sampleRate: null,
      channels: null,
      isWav: false,
      reason: "响应不是 RIFF/WAVE，浏览器可能显示为 0 秒。",
    };
  }

  let offset = 12;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let byteRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readFourCC(bytes, offset);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset > bytes.byteLength) {
      break;
    }

    if (chunkId === "fmt " && chunkSize >= 16 && dataOffset + 16 <= bytes.byteLength) {
      channels = readUint16LE(bytes, dataOffset + 2);
      sampleRate = readUint32LE(bytes, dataOffset + 4);
      byteRate = readUint32LE(bytes, dataOffset + 8);
      bitsPerSample = readUint16LE(bytes, dataOffset + 14);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (dataSize == null || dataSize <= 0) {
    return {
      byteLength: bytes.byteLength,
      durationSec: 0,
      sampleRate,
      channels,
      isWav: true,
      reason: "WAV data 块为空或缺失，播放器会显示 0 秒。",
    };
  }

  let durationSec: number | null = null;
  if (byteRate && byteRate > 0) {
    durationSec = dataSize / byteRate;
  } else if (sampleRate && channels && bitsPerSample) {
    const frameBytes = Math.max(1, channels * Math.max(1, Math.floor(bitsPerSample / 8)));
    durationSec = dataSize / (sampleRate * frameBytes);
  }

  if (durationSec != null && durationSec < 0.05) {
    return {
      byteLength: bytes.byteLength,
      durationSec,
      sampleRate,
      channels,
      isWav: true,
      reason: `WAV 有效时长约 ${durationSec.toFixed(3)}s，接近 0 秒。`,
    };
  }

  return {
    byteLength: bytes.byteLength,
    durationSec,
    sampleRate,
    channels,
    isWav: true,
  };
}

export function decodeBase64AudioToObjectUrl(
  audioBase64: string,
  mimeType = "audio/wav",
): string {
  const inspection = inspectWavAudioBase64(audioBase64);
  if (!inspection.isWav || inspection.reason) {
    throw new Error(inspection.reason || "试听音频无效。");
  }
  const bytes = decodeBase64ToBytes(audioBase64);
  // 复制到新 ArrayBuffer，避免 SharedArrayBuffer / 子类型导致 Blob 兼容问题
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return URL.createObjectURL(new Blob([copy.buffer], { type: mimeType }));
}

/** data: URL 或裸 base64 均可，用于克隆参考音本地试听。 */
export function resolveLocalAudioSrc(audioBase64OrDataUrl: string): string {
  const value = audioBase64OrDataUrl.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("data:")) {
    return value;
  }
  return `data:audio/wav;base64,${value}`;
}

/**
 * 用 ref 持有当前 object URL，保证 revoke 只发生一次。
 * 避免「setState 时 revoke + useEffect cleanup 再 revoke」的双路径。
 */
export function createObjectUrlSlot() {
  let current: string | null = null;

  return {
    get(): string | null {
      return current;
    },
    set(next: string | null): string | null {
      if (current && current !== next) {
        URL.revokeObjectURL(current);
      }
      current = next;
      return current;
    },
    clear(): void {
      if (current) {
        URL.revokeObjectURL(current);
        current = null;
      }
    },
  };
}

function waitForAudioReady(el: HTMLAudioElement, timeoutMs = 4000): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("音频元数据加载超时。"));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("浏览器无法解码试听音频。"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener("loadeddata", onReady);
      el.removeEventListener("canplay", onReady);
      el.removeEventListener("error", onError);
    };

    el.addEventListener("loadeddata", onReady);
    el.addEventListener("canplay", onReady);
    el.addEventListener("error", onError);
  });
}

/**
 * 在 src 已绑定后尝试播放。
 * 先等元数据/可播，再 play；不再盲目 el.load()（会打断刚绑定的 src）。
 */
export async function tryAutoPlayAudio(el: HTMLAudioElement | null): Promise<{
  played: boolean;
  durationSec: number | null;
  error?: string;
}> {
  if (!el) {
    return { played: false, durationSec: null, error: "音频元素未挂载。" };
  }
  if (!el.getAttribute("src") && !el.src) {
    return { played: false, durationSec: null, error: "音频 src 为空。" };
  }

  try {
    await waitForAudioReady(el);
  } catch (error) {
    return {
      played: false,
      durationSec: Number.isFinite(el.duration) ? el.duration : null,
      error: error instanceof Error ? error.message : "音频未就绪。",
    };
  }

  const durationSec = Number.isFinite(el.duration) ? el.duration : null;
  if (durationSec != null && durationSec < 0.05) {
    return {
      played: false,
      durationSec,
      error: "浏览器解析到的时长接近 0 秒，请重试或换音色。",
    };
  }

  try {
    await el.play();
    return { played: true, durationSec };
  } catch {
    // 浏览器可能拦截 autoplay；controls 仍可手播。
    return { played: false, durationSec };
  }
}
