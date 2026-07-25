/**
 * 解析客户端 IP（与 rateLimit 口径对齐）。
 * 反代后 req.ip 常为 loopback，优先 x-forwarded-for 首段。
 */
export function resolveClientIp(req: {
  ip?: string;
  header?: (name: string) => string | undefined;
  get?: (name: string) => string | undefined;
  socket?: { remoteAddress?: string | null };
}): string | null {
  const header = (name: string): string | undefined => {
    if (typeof req.header === "function") {
      return req.header(name);
    }
    if (typeof req.get === "function") {
      return req.get(name);
    }
    return undefined;
  };
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }
  if (req.ip && String(req.ip).trim()) {
    return String(req.ip).trim();
  }
  const remote = req.socket?.remoteAddress;
  return remote ? String(remote) : null;
}

export function truncateMeta(value: string | null | undefined, max = 200): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}
