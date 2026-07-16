/**
 * clone 参考音频路径统一校验：必须落在 voice-refs 根内且为可读非空文件。
 * precheck / execute / probe / TTS load 共用，避免门禁松紧不一致。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveVoiceRefRoot } from "./audiobookPaths";

export function isPathInside(parent: string, target: string): boolean {
  const parentResolved = path.resolve(parent);
  const targetResolved = path.resolve(target);
  const rel = path.relative(parentResolved, targetResolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type VoiceRefPathCheck =
  | { ok: true; absolutePath: string }
  | { ok: false; reason: string };

/**
 * 校验 clone 参考路径。
 * - 空路径：missing（由调用方决定文案）
 * - 非法字符 / 越界 / 非文件 / 空文件：invalid
 */
export function checkVoiceRefAudioPath(refPath: string | null | undefined): VoiceRefPathCheck {
  const raw = refPath?.trim() || "";
  if (!raw) {
    return { ok: false, reason: "clone 参考音频路径为空。" };
  }
  if (raw.includes("\0") || raw.includes("..")) {
    return { ok: false, reason: "clone 参考音频路径非法。" };
  }

  let absolutePath: string;
  try {
    absolutePath = path.resolve(raw);
  } catch {
    return { ok: false, reason: "clone 参考音频路径无法解析。" };
  }

  const root = resolveVoiceRefRoot();
  if (!isPathInside(root, absolutePath)) {
    return { ok: false, reason: "clone 参考音频路径越界（必须位于 voice-refs 目录）。" };
  }

  try {
    if (!fs.existsSync(absolutePath)) {
      return { ok: false, reason: "clone 参考音频文件不存在。" };
    }
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "clone 参考音频路径不是文件。" };
    }
    if (stat.size <= 0) {
      return { ok: false, reason: "clone 参考音频为空文件。" };
    }
  } catch {
    return { ok: false, reason: "clone 参考音频无法读取。" };
  }

  return { ok: true, absolutePath };
}

/** readiness / 纯探测：true=可用，false=不可用，null=无路径 */
export function probeVoiceRefAudioOk(refPath?: string | null): boolean | null {
  const raw = refPath?.trim() || "";
  if (!raw) return null;
  return checkVoiceRefAudioPath(raw).ok;
}
