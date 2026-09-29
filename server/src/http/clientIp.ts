/** Client identity resolved by Express using the configured trusted proxy boundary. */
export function resolveClientIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string | null };
}): string | null {
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
