/**
 * must_on_page vs intentional offscreen 角色出场语义。
 * 仅 planned 本章 / 核心角色连续缺席达阈时进入「必须出场」；
 * warn 级偏好或明确他章计划不得升格为 high missing_appearance。
 */

export const MUST_ON_PAGE_ABSENCE_SPAN_THRESHOLD = 3;
export const MUST_ON_PAGE_HIGH_RISK_MIN_SPAN = 2;

export interface CharacterAppearanceGuideLike {
  name: string;
  plannedChapterOrders?: number[] | null;
  shouldPreferAppearance?: boolean | null;
  isCoreInVolume?: boolean | null;
  absenceRisk?: string | null;
  absenceSpan?: number | null;
}

export function isMustOnPageCharacter(
  guide: CharacterAppearanceGuideLike,
  chapterOrder: number,
): boolean {
  const planned = Array.isArray(guide.plannedChapterOrders) ? guide.plannedChapterOrders : [];
  if (planned.includes(chapterOrder)) {
    return true;
  }
  const span = typeof guide.absenceSpan === "number" && Number.isFinite(guide.absenceSpan)
    ? guide.absenceSpan
    : 0;
  const risk = String(guide.absenceRisk ?? "");
  const isCore = Boolean(guide.isCoreInVolume);
  const prefer = Boolean(guide.shouldPreferAppearance);

  // 核心角色连续高风险缺席：强制 must_on_page（→ patch 路径）
  if (isCore && risk === "high" && span >= MUST_ON_PAGE_ABSENCE_SPAN_THRESHOLD) {
    return true;
  }
  // 已 prefer 且 high + 至少 2 章缺席：进入 must_on_page
  if (prefer && risk === "high" && span >= MUST_ON_PAGE_HIGH_RISK_MIN_SPAN) {
    return true;
  }
  return false;
}

/** 有出场偏好但不应记为本章硬 must_on_page（可延后 / 他章计划 / warn 级）。 */
export function isIntentionalOffscreenCharacter(
  guide: CharacterAppearanceGuideLike,
  chapterOrder: number,
): boolean {
  if (isMustOnPageCharacter(guide, chapterOrder)) {
    return false;
  }
  const planned = Array.isArray(guide.plannedChapterOrders) ? guide.plannedChapterOrders : [];
  if (planned.length > 0 && !planned.includes(chapterOrder)) {
    return true;
  }
  const risk = String(guide.absenceRisk ?? "");
  if (Boolean(guide.shouldPreferAppearance) && (risk === "warn" || risk === "info" || risk === "")) {
    return true;
  }
  if (Boolean(guide.isCoreInVolume) && risk !== "high") {
    return true;
  }
  return false;
}

export function formatMustOnPageAppearanceLabel(
  guide: CharacterAppearanceGuideLike,
  chapterOrder: number,
): string {
  const name = String(guide.name ?? "").trim();
  if (!name) {
    return "";
  }
  const span = typeof guide.absenceSpan === "number" && Number.isFinite(guide.absenceSpan)
    ? guide.absenceSpan
    : 0;
  if (guide.absenceRisk === "high" && span > 0) {
    return `${name}（must_on_page；已缺席 ${span} 章，须本场可见）`;
  }
  if (Array.isArray(guide.plannedChapterOrders) && guide.plannedChapterOrders.includes(chapterOrder)) {
    return `${name}（must_on_page；本章计划出场）`;
  }
  return `${name}（must_on_page）`;
}

export function formatOffscreenAppearanceDeferLabel(guide: CharacterAppearanceGuideLike): string {
  const name = String(guide.name ?? "").trim();
  if (!name) {
    return "";
  }
  return `${name}（可延后出场/offscreen，不记硬缺席）`;
}

export function selectMustOnPageAppearanceLabels(
  guides: CharacterAppearanceGuideLike[],
  chapterOrder: number,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const guide of guides) {
    if (!isMustOnPageCharacter(guide, chapterOrder)) {
      continue;
    }
    const label = formatMustOnPageAppearanceLabel(guide, chapterOrder);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

export function selectOffscreenDeferLabels(
  guides: CharacterAppearanceGuideLike[],
  chapterOrder: number,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const guide of guides) {
    if (!isIntentionalOffscreenCharacter(guide, chapterOrder)) {
      continue;
    }
    const label = formatOffscreenAppearanceDeferLabel(guide);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/** 验收 missing 中「故意 offscreen」类 character_appearance 应降级，不抬高 hard repair。 */
export function isSoftOffscreenCharacterAppearanceMissing(input: {
  kind?: string | null;
  summary?: string | null;
  evidence?: string | null;
}): boolean {
  if (input.kind !== "character_appearance") {
    return false;
  }
  const text = `${input.summary ?? ""}\n${input.evidence ?? ""}`;
  if (/must_on_page|必须出场|连续缺席|已缺席\s*\d+\s*章/.test(text)) {
    return false;
  }
  return /offscreen|可延后|不必出场|非必须出场|背景角色|仅提及|他章计划|不记硬缺席/i.test(text);
}
