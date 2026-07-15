/** 角色 ttsSpeakerAliases：JSON 数组或逗号/顿号分隔。 */
export function parseSpeakerAliases(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 24);
  }
  const text = raw?.trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 24);
    }
  } catch {
    // fall through to delimiter split
  }
  return text
    .split(/[,，、;；|/\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}
