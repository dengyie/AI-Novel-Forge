import { timingSafeEqual } from "node:crypto";
import { AppError } from "../../middleware/errorHandler";

/** Header 名：仅升到 approved 时需要（env 已配置时）。 */
export const VOICE_LIBRARY_APPROVE_TOKEN_HEADER = "x-voice-library-approve-token";

export function resolveVoiceLibraryApproveToken(): string | null {
  const raw = process.env.VOICE_LIBRARY_APPROVE_TOKEN?.trim();
  return raw ? raw : null;
}

function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * 仅当目标 status=approved 且 env 配置了 token 时校验 header。
 * 未配置 env → 与现网兼容（open）。
 * 不校验 draft/archived/deprecated。
 */
export function assertVoiceLibraryApproveToken(input: {
  nextStatus: string;
  headerToken: string | null | undefined;
}): void {
  if (input.nextStatus !== "approved") {
    return;
  }
  const expected = resolveVoiceLibraryApproveToken();
  if (!expected) {
    return;
  }
  const provided = input.headerToken?.trim() ?? "";
  if (!provided || !safeEqualString(provided, expected)) {
    throw new AppError(
      "升为 approved 需要有效的 X-Voice-Library-Approve-Token（VOICE_LIBRARY_APPROVE_TOKEN）。",
      403,
    );
  }
}

export function auditVoiceLibraryStatusChange(input: {
  assetId: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string;
}): void {
  const parts = [
    "voice_library_status",
    `assetId=${input.assetId}`,
    `from=${input.from}`,
    `to=${input.to}`,
    `ok=${input.ok ? 1 : 0}`,
  ];
  if (input.reason) {
    parts.push(`reason=${input.reason.replace(/\s+/g, "_").slice(0, 80)}`);
  }
  // 禁止打印 token 明文
  console.info(parts.join(" "));
}
