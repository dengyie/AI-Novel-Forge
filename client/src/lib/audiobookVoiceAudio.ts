/**
 * 有声书试听音频工具：base64 → object URL，并在 src 变化时尝试自动播放。
 * 人物卡与有声书面板共用，避免两套 atob / revoke 逻辑分叉。
 */

function stripDataUrlBase64(audioBase64: string): string {
  if (!audioBase64.includes(",")) {
    return audioBase64;
  }
  return audioBase64.split(",").pop() ?? audioBase64;
}

export function decodeBase64AudioToObjectUrl(
  audioBase64: string,
  mimeType = "audio/wav",
): string {
  const bare = stripDataUrlBase64(audioBase64);
  const binary = atob(bare);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
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

export async function tryAutoPlayAudio(el: HTMLAudioElement | null): Promise<void> {
  if (!el) {
    return;
  }
  el.load();
  try {
    await el.play();
  } catch {
    // 浏览器可能拦截 autoplay；controls 仍可手播。
  }
}
