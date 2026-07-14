import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveApiAuthToken } from "../../middleware/auth";

/** 媒体短时访问令牌 TTL（秒），供 <audio>/<a> 无 header 场景。 */
const DEFAULT_TTL_SEC = Math.max(
  300,
  Number(process.env.AUDIOBOOK_MEDIA_ACCESS_TTL_SEC ?? 6 * 3600) || 6 * 3600,
);

export type AudiobookMediaResource =
  | { kind: "full" }
  | { kind: "chapter"; chapterId: string };

function resolveSigningSecret(): string | null {
  const dedicated = process.env.AUDIOBOOK_MEDIA_SIGNING_SECRET?.trim();
  if (dedicated) {
    return dedicated;
  }
  return resolveApiAuthToken();
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function resourceKey(resource: AudiobookMediaResource): string {
  if (resource.kind === "full") {
    return "full";
  }
  return `chapter:${resource.chapterId}`;
}

/**
 * 签发绑定 novelId/taskId/resource 的短时 access token。
 * open 模式（无签名密钥）返回 null，调用方直接给裸 URL。
 */
export function issueAudiobookMediaAccess(input: {
  novelId: string;
  taskId: string;
  resource: AudiobookMediaResource;
  ttlSec?: number;
}): { access: string; expiresAt: number } | null {
  const secret = resolveSigningSecret();
  if (!secret) {
    return null;
  }
  const ttl = Math.max(60, input.ttlSec ?? DEFAULT_TTL_SEC);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = [
    "v1",
    String(exp),
    input.novelId.trim(),
    input.taskId.trim(),
    resourceKey(input.resource),
  ].join("|");
  const sig = signPayload(payload, secret);
  return {
    access: `${base64Url(payload)}.${sig}`,
    expiresAt: exp,
  };
}

export function verifyAudiobookMediaAccess(input: {
  access: string | null | undefined;
  novelId: string;
  taskId: string;
  resource: AudiobookMediaResource;
}): boolean {
  const secret = resolveSigningSecret();
  if (!secret) {
    // open 模式：无密钥时不校验 access（由 authMiddleware 决定是否放行）
    return false;
  }
  const raw = input.access?.trim();
  if (!raw) {
    return false;
  }
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expectedSig = signPayload(payload, secret);
  if (!safeEqual(sig, expectedSig)) {
    return false;
  }
  const parts = payload.split("|");
  if (parts.length !== 5 || parts[0] !== "v1") {
    return false;
  }
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  if (parts[2] !== input.novelId.trim() || parts[3] !== input.taskId.trim()) {
    return false;
  }
  if (parts[4] !== resourceKey(input.resource)) {
    return false;
  }
  return true;
}

/** token 模式下，媒体请求是否已通过 access 或 header 鉴权（header 由 middleware 处理）。 */
export function isAudiobookMediaAuthorized(input: {
  access: string | null | undefined;
  novelId: string;
  taskId: string;
  resource: AudiobookMediaResource;
  /** middleware 已通过时为 true */
  headerAuthorized?: boolean;
}): boolean {
  if (input.headerAuthorized) {
    return true;
  }
  const modeSecret = resolveSigningSecret();
  // open：无 API token
  if (!modeSecret && !resolveApiAuthToken()) {
    return true;
  }
  // token 模式但 open 无 secret 的边界：require header only
  return verifyAudiobookMediaAccess({
    access: input.access,
    novelId: input.novelId,
    taskId: input.taskId,
    resource: input.resource,
  });
}
