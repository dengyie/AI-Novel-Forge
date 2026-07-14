import type {
  StoryWorldSlice,
  StoryWorldSliceElement,
  StoryWorldSliceLockMode,
} from "@ai-novel/shared/types/storyWorldSlice";
import { resolveStoryWorldSliceLockMode } from "@ai-novel/shared/types/storyWorldSlice";
import type { WorldStructuredData } from "@ai-novel/shared/types/world";

export type CanonicalGuardResult = {
  /** false = 有 violations（可能已 strip）；始终带可用 slice */
  ok: boolean;
  slice: StoryWorldSlice;
  violations: string[];
  stripped: boolean;
};

export type CanonicalGuardInput = {
  slice: StoryWorldSlice;
  structure: WorldStructuredData;
  /** 额外允许专名（角色/地名导入表等） */
  entityRegistry?: string[] | null;
  lockMode?: StoryWorldSliceLockMode | null;
};

/**
 * 高置信发明术语（源世界生产实测 + 通用假机构造）。
 * 仅当短语不在允许名表中时 hard strip。
 * 金样例必须覆盖这些；合法压力句不得命中。
 */
export const HIGH_CONFIDENCE_INVENTED_TERMS = [
  "脱序者",
  "残渣流失",
  "失序渗漏",
  "本源残响体",
  "可用性黑市券",
  "协衡暗纹",
  "名噬回声",
] as const;

const MAX_VIOLATIONS = 32;

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

/** 从 structure 与 registry 建允许专名表（名 + 较短别名） */
export function buildAllowedProperNames(
  structure: WorldStructuredData,
  entityRegistry?: string[] | null,
): Set<string> {
  const names: string[] = [];
  for (const rule of structure.rules?.axioms ?? []) {
    if (rule.name) names.push(rule.name);
    if (rule.id) names.push(rule.id);
  }
  for (const force of structure.forces ?? []) {
    if (force.name) names.push(force.name);
    if (force.id) names.push(force.id);
    if (force.leader) names.push(force.leader);
  }
  for (const location of structure.locations ?? []) {
    if (location.name) names.push(location.name);
    if (location.id) names.push(location.id);
  }
  for (const faction of structure.factions ?? []) {
    if (faction.name) names.push(faction.name);
    if (faction.id) names.push(faction.id);
  }
  if (structure.profile?.identity) names.push(structure.profile.identity);
  if (Array.isArray(entityRegistry)) {
    names.push(...entityRegistry);
  }
  const set = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    set.add(trimmed);
    // 允许作为子串匹配的短名（≥2 字）
    if (trimmed.length >= 2) {
      set.add(trimmed);
    }
  }
  return set;
}

function textContainsAllowedName(text: string, allowed: Set<string>): boolean {
  for (const name of allowed) {
    if (name.length >= 2 && text.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * 对单段自由文本：若含高置信发明术语且术语本身不在允许表，则移除该术语。
 * 不整句删除合法描写，只挖掉发明词。
 */
export function stripInventedTermsFromText(
  text: string,
  allowed: Set<string>,
): { text: string; violations: string[] } {
  if (!text.trim()) {
    return { text, violations: [] };
  }
  let next = text;
  const violations: string[] = [];
  for (const term of HIGH_CONFIDENCE_INVENTED_TERMS) {
    if (allowed.has(term)) {
      continue;
    }
    if (!next.includes(term)) {
      continue;
    }
    violations.push(`invented_term:${term}`);
    next = next.split(term).join("").replace(/\s{2,}/g, " ").replace(/[，、；;]{2,}/g, "，").trim();
  }
  return { text: next, violations };
}

function sanitizeStringList(
  items: string[],
  allowed: Set<string>,
  field: string,
): { items: string[]; violations: string[] } {
  const violations: string[] = [];
  const kept: string[] = [];
  for (const item of items) {
    const { text, violations: itemViolations } = stripInventedTermsFromText(item, allowed);
    for (const v of itemViolations) {
      violations.push(`${field}:${v}`);
    }
    // 整项若几乎只剩发明词被挖空，或原项本身是纯发明词 → drop
    if (!text.trim()) {
      if (item.trim()) {
        violations.push(`${field}:dropped_empty_after_strip`);
      }
      continue;
    }
    // 保守：若 strip 后仍像「××者」且不在允许表、原串含发明模式
    if (/[一-鿿]{1,8}者$/.test(text.trim()) && !textContainsAllowedName(text, allowed)) {
      const bare = text.trim();
      if (
        HIGH_CONFIDENCE_INVENTED_TERMS.some((t) => bare.includes(t))
        || /^(脱序|失序|残渣|名噬)/.test(bare)
      ) {
        violations.push(`${field}:dropped_agent_suffix:${bare}`);
        continue;
      }
    }
    kept.push(text);
  }
  return { items: uniqueNonEmpty(kept), violations };
}

function sanitizeElements(
  elements: StoryWorldSliceElement[],
  allowed: Set<string>,
): { elements: StoryWorldSliceElement[]; violations: string[] } {
  const violations: string[] = [];
  const next: StoryWorldSliceElement[] = [];
  for (const el of elements) {
    const labelResult = stripInventedTermsFromText(el.label, allowed);
    const summaryResult = stripInventedTermsFromText(el.summary, allowed);
    violations.push(
      ...labelResult.violations.map((v) => `activeElements.label:${v}`),
      ...summaryResult.violations.map((v) => `activeElements.summary:${v}`),
    );
    const label = labelResult.text.trim();
    if (!label) {
      violations.push(`activeElements:dropped:${el.id || el.label}`);
      continue;
    }
    // 纯发明 label
    if (
      HIGH_CONFIDENCE_INVENTED_TERMS.some((t) => el.label.includes(t) && !allowed.has(t))
      && !textContainsAllowedName(label, allowed)
      && label.length <= 8
    ) {
      violations.push(`activeElements:dropped_invented_label:${el.label}`);
      continue;
    }
    next.push({
      ...el,
      label,
      summary: summaryResult.text,
    });
  }
  return { elements: next.slice(0, 6), violations };
}

/**
 * Canonical guard：永不抛业务致命错误；始终返回可用 slice。
 * theme_invent：原样返回，lockMode 写入 metadata。
 * canonical：strip 高置信发明术语并记录 violations。
 */
export function applyCanonicalStoryWorldSliceGuard(
  input: CanonicalGuardInput,
): CanonicalGuardResult {
  const lockMode = resolveStoryWorldSliceLockMode(input.lockMode);
  const baseMeta = {
    ...input.slice.metadata,
    lockMode,
  };

  if (lockMode === "theme_invent") {
    const slice: StoryWorldSlice = {
      ...input.slice,
      metadata: {
        ...baseMeta,
        inventViolations: input.slice.metadata.inventViolations,
      },
    };
    return {
      ok: true,
      slice,
      violations: [],
      stripped: false,
    };
  }

  const allowed = buildAllowedProperNames(input.structure, input.entityRegistry);
  const violations: string[] = [];

  const core = stripInventedTermsFromText(input.slice.coreWorldFrame, allowed);
  violations.push(...core.violations.map((v) => `coreWorldFrame:${v}`));

  const scope = stripInventedTermsFromText(input.slice.storyScopeBoundary, allowed);
  violations.push(...scope.violations.map((v) => `storyScopeBoundary:${v}`));

  const pressure = sanitizeStringList(input.slice.pressureSources, allowed, "pressureSources");
  const mystery = sanitizeStringList(input.slice.mysterySources, allowed, "mysterySources");
  const conflict = sanitizeStringList(input.slice.conflictCandidates, allowed, "conflictCandidates");
  const axes = sanitizeStringList(input.slice.suggestedStoryAxes, allowed, "suggestedStoryAxes");
  const entries = sanitizeStringList(
    input.slice.recommendedEntryPoints,
    allowed,
    "recommendedEntryPoints",
  );
  const forbidden = sanitizeStringList(
    input.slice.forbiddenCombinations,
    allowed,
    "forbiddenCombinations",
  );
  const elements = sanitizeElements(input.slice.activeElements, allowed);

  violations.push(
    ...pressure.violations,
    ...mystery.violations,
    ...conflict.violations,
    ...axes.violations,
    ...entries.violations,
    ...forbidden.violations,
    ...elements.violations,
  );

  const uniqueViolations = uniqueNonEmpty(violations).slice(0, MAX_VIOLATIONS);
  const stripped = uniqueViolations.length > 0;

  // 元素被挖空时回退到基于已白名单 force/rule 的占位，保证 slice 可消费
  let activeElements = elements.elements;
  if (activeElements.length === 0 && input.slice.activeElements.length > 0) {
    activeElements = buildStructureOnlyElements(input.slice);
  }

  const slice: StoryWorldSlice = {
    ...input.slice,
    coreWorldFrame: core.text || input.structure.profile?.summary || input.structure.profile?.identity || input.slice.coreWorldFrame,
    storyScopeBoundary: scope.text,
    pressureSources: pressure.items,
    mysterySources: mystery.items,
    conflictCandidates: conflict.items,
    suggestedStoryAxes: axes.items,
    recommendedEntryPoints: entries.items,
    forbiddenCombinations: forbidden.items,
    activeElements,
    metadata: {
      ...baseMeta,
      inventViolations: uniqueViolations.length > 0 ? uniqueViolations : undefined,
    },
  };

  return {
    ok: !stripped,
    slice,
    violations: uniqueViolations,
    stripped,
  };
}

function buildStructureOnlyElements(slice: StoryWorldSlice): StoryWorldSliceElement[] {
  const fromForces = slice.activeForces.slice(0, 3).map((force, index) => ({
    id: `fallback-force-${index + 1}`,
    label: force.name,
    type: "force",
    summary: force.summary || force.pressure,
  }));
  if (fromForces.length > 0) {
    return fromForces;
  }
  return slice.appliedRules.slice(0, 3).map((rule, index) => ({
    id: `fallback-rule-${index + 1}`,
    label: rule.name,
    type: "rule",
    summary: rule.summary,
  }));
}

/**
 * 无 LLM 的 structure-only fallback：仅用已 ID 白名单实体拼最小可用 slice 字段。
 * 供 build 失败或 violations 过多时使用；不引入自由发明。
 */
export function buildStructureOnlyStoryWorldSliceFallback(
  slice: StoryWorldSlice,
  structure: WorldStructuredData,
): StoryWorldSlice {
  const frame = structure.profile?.summary || structure.profile?.identity || slice.coreWorldFrame;
  return {
    ...slice,
    coreWorldFrame: frame,
    activeElements: buildStructureOnlyElements(slice),
    // 保留 ID 白名单实体；自由列表压到 structure 可验证压力
    conflictCandidates: slice.conflictCandidates.filter((item) =>
      slice.activeForces.some((f) => item.includes(f.name))
      || slice.activeLocations.some((l) => item.includes(l.name)),
    ).slice(0, 8),
    pressureSources: slice.activeForces
      .map((f) => `${f.name}：${f.pressure}`.replace(/：$/, ""))
      .filter(Boolean)
      .slice(0, 8),
    mysterySources: [],
    suggestedStoryAxes: [],
    recommendedEntryPoints: slice.activeLocations.map((l) => l.name).slice(0, 6),
    forbiddenCombinations: slice.forbiddenCombinations.slice(0, 8),
    storyScopeBoundary: slice.storyScopeBoundary,
    metadata: {
      ...slice.metadata,
      lockMode: "canonical",
      inventViolations: uniqueNonEmpty([
        ...(slice.metadata.inventViolations ?? []),
        "fallback:structure_only",
      ]).slice(0, MAX_VIOLATIONS),
      builtFromStructuredData: true,
    },
  };
}
