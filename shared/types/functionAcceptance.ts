import { z } from "zod";
import type { SettingQualityMode } from "./settingQualityPolicy.js";
import { isSettingQualityEnforced } from "./settingQualityPolicy.js";

/**
 * 功能验收表（设定对齐 B2）。
 * SoT：VolumePlanDocument.functionAcceptanceTables[]
 * 章挂载：VolumeChapterPlan.functionIds[]
 */

export const FUNCTION_ACCEPTANCE_STATUSES = [
  "planned",
  "assigned",
  "satisfied",
  "missed",
] as const;
export type FunctionAcceptanceStatus = (typeof FUNCTION_ACCEPTANCE_STATUSES)[number];

export const FUNCTION_ACCEPTANCE_SOURCES = [
  "import",
  "generated",
  "hybrid",
] as const;
export type FunctionAcceptanceSource = (typeof FUNCTION_ACCEPTANCE_SOURCES)[number];

export const functionAcceptanceStatusSchema = z.enum(FUNCTION_ACCEPTANCE_STATUSES);
export const functionAcceptanceSourceSchema = z.enum(FUNCTION_ACCEPTANCE_SOURCES);

export const functionAcceptanceItemSchema = z.object({
  id: z.string().trim().min(1),
  order: z.number().int().min(1),
  title: z.string().trim().min(1),
  mustHappen: z.string().trim().min(1),
  mustNotHappen: z.array(z.string().trim().min(1)).max(16).optional(),
  charactersOnPage: z.array(z.string().trim().min(1)).max(16).optional(),
  locationHints: z.array(z.string().trim().min(1)).max(16).optional(),
  foreshadowIds: z.array(z.string().trim().min(1)).max(16).optional(),
  /** 软提示，非字数闸 */
  targetChapterHint: z.string().trim().max(120).optional(),
  acceptanceChecks: z.array(z.string().trim().min(1)).min(1).max(16),
  status: functionAcceptanceStatusSchema.default("planned"),
  assignedChapterOrders: z.array(z.number().int().positive()).max(64).optional(),
});

export type FunctionAcceptanceItem = z.infer<typeof functionAcceptanceItemSchema>;

export const functionAcceptanceTableSchema = z.object({
  volumeId: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  source: functionAcceptanceSourceSchema,
  items: z.array(functionAcceptanceItemSchema).max(64),
});

export type FunctionAcceptanceTable = z.infer<typeof functionAcceptanceTableSchema>;

export type FunctionCoverageChapterRef = {
  chapterOrder: number;
  functionIds?: string[] | null;
  mustAvoid?: string | null;
};

export type FunctionCoverageResult = {
  ok: boolean;
  missingIds: string[];
  unreferencedIds: string[];
  issues: string[];
  /** 合并 mustNotHappen 后的章级建议 mustAvoid 增量（按 chapterOrder） */
  mustAvoidByChapterOrder: Record<number, string[]>;
};

export type FunctionTableEnforceGuardResult = {
  ok: boolean;
  canEnforce: boolean;
  reason: string | null;
};

const EMPTY_COVERAGE: FunctionCoverageResult = {
  ok: true,
  missingIds: [],
  unreferencedIds: [],
  issues: [],
  mustAvoidByChapterOrder: {},
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function uniqueOrders(values: number[]): number[] {
  return Array.from(new Set(values.filter((n) => Number.isFinite(n) && n > 0)))
    .map((n) => Math.trunc(n))
    .sort((a, b) => a - b);
}

export function normalizeFunctionAcceptanceItem(
  raw: unknown,
  index = 0,
): FunctionAcceptanceItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const mustHappen = typeof record.mustHappen === "string"
    ? record.mustHappen.trim()
    : typeof record.must_happen === "string"
      ? record.must_happen.trim()
      : "";
  const checksRaw = Array.isArray(record.acceptanceChecks)
    ? record.acceptanceChecks
    : Array.isArray(record.acceptance_checks)
      ? record.acceptance_checks
      : [];
  const acceptanceChecks = uniqueStrings(
    checksRaw.map((item) => (typeof item === "string" ? item : "")),
  );
  if (!id || !title || !mustHappen || acceptanceChecks.length === 0) {
    return null;
  }
  const orderRaw = record.order;
  const order = typeof orderRaw === "number" && Number.isFinite(orderRaw)
    ? Math.max(1, Math.trunc(orderRaw))
    : index + 1;
  const statusRaw = typeof record.status === "string" ? record.status : "planned";
  const status = (FUNCTION_ACCEPTANCE_STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw as FunctionAcceptanceStatus
    : "planned";
  const assignedRaw = Array.isArray(record.assignedChapterOrders)
    ? record.assignedChapterOrders
    : Array.isArray(record.assigned_chapter_orders)
      ? record.assigned_chapter_orders
      : [];
  const assignedChapterOrders = uniqueOrders(
    assignedRaw.map((n) => (typeof n === "number" ? n : Number(n))),
  );

  const parsed = functionAcceptanceItemSchema.safeParse({
    id,
    order,
    title,
    mustHappen,
    mustNotHappen: uniqueStrings(
      (Array.isArray(record.mustNotHappen) ? record.mustNotHappen : Array.isArray(record.must_not_happen) ? record.must_not_happen : [])
        .map((item) => (typeof item === "string" ? item : "")),
    ),
    charactersOnPage: uniqueStrings(
      (Array.isArray(record.charactersOnPage) ? record.charactersOnPage : Array.isArray(record.characters_on_page) ? record.characters_on_page : [])
        .map((item) => (typeof item === "string" ? item : "")),
    ),
    locationHints: uniqueStrings(
      (Array.isArray(record.locationHints) ? record.locationHints : Array.isArray(record.location_hints) ? record.location_hints : [])
        .map((item) => (typeof item === "string" ? item : "")),
    ),
    foreshadowIds: uniqueStrings(
      (Array.isArray(record.foreshadowIds) ? record.foreshadowIds : Array.isArray(record.foreshadow_ids) ? record.foreshadow_ids : [])
        .map((item) => (typeof item === "string" ? item : "")),
    ),
    targetChapterHint: typeof record.targetChapterHint === "string"
      ? record.targetChapterHint.trim()
      : typeof record.target_chapter_hint === "string"
        ? record.target_chapter_hint.trim()
        : undefined,
    acceptanceChecks,
    status,
    assignedChapterOrders: assignedChapterOrders.length > 0 ? assignedChapterOrders : undefined,
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeFunctionAcceptanceTable(
  raw: unknown,
  fallbackVolumeId?: string,
): FunctionAcceptanceTable | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const volumeId = typeof record.volumeId === "string" && record.volumeId.trim()
    ? record.volumeId.trim()
    : typeof record.volume_id === "string" && record.volume_id.trim()
      ? record.volume_id.trim()
      : (fallbackVolumeId?.trim() || "");
  if (!volumeId) {
    return null;
  }
  const sourceRaw = typeof record.source === "string" ? record.source : "generated";
  const source = (FUNCTION_ACCEPTANCE_SOURCES as readonly string[]).includes(sourceRaw)
    ? sourceRaw as FunctionAcceptanceSource
    : "generated";
  const itemsRaw = Array.isArray(record.items) ? record.items : [];
  const items = itemsRaw
    .map((item, index) => normalizeFunctionAcceptanceItem(item, index))
    .filter((item): item is FunctionAcceptanceItem => Boolean(item))
    .slice(0, 64)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const parsed = functionAcceptanceTableSchema.safeParse({
    volumeId,
    schemaVersion: 1 as const,
    source,
    items,
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeFunctionAcceptanceTables(
  raw: unknown,
  fallbackVolumeIds: string[] = [],
): FunctionAcceptanceTable[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item, index) => normalizeFunctionAcceptanceTable(
        item,
        fallbackVolumeIds[index],
      ))
      .filter((item): item is FunctionAcceptanceTable => Boolean(item));
  }
  // 兼容计划文档中的单表字段
  if (raw && typeof raw === "object") {
    const single = normalizeFunctionAcceptanceTable(raw, fallbackVolumeIds[0]);
    return single ? [single] : [];
  }
  return [];
}

export function normalizeFunctionIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      return uniqueStrings(raw.split(/[\n,，；、]/g));
    }
    return [];
  }
  return uniqueStrings(raw.map((item) => (typeof item === "string" ? item : "")));
}

/**
 * generated 源不得启用 enforce（X4）。
 * import / hybrid 可 enforce。
 */
export function assertFunctionTableEnforcible(
  table: FunctionAcceptanceTable | null | undefined,
): FunctionTableEnforceGuardResult {
  if (!table) {
    return {
      ok: false,
      canEnforce: false,
      reason: "缺少功能验收表，不能启用 enforce 覆盖门禁。",
    };
  }
  if (table.items.length === 0) {
    return {
      ok: false,
      canEnforce: false,
      reason: "功能验收表为空，不能启用 enforce。",
    };
  }
  if (table.source === "generated") {
    return {
      ok: false,
      canEnforce: false,
      reason: "生成表未人工确认（source=generated），不能启用强制门禁；请导入或改为 hybrid。",
    };
  }
  return { ok: true, canEnforce: true, reason: null };
}

/**
 * 覆盖校验：每个非 missed item 至少被一章 functionIds 引用。
 * mode=off 时直接 ok；advisory/enforce 都可算，是否挡门由调用方决定。
 */
export function validateFunctionCoverage(input: {
  table: FunctionAcceptanceTable | null | undefined;
  chapters: FunctionCoverageChapterRef[];
  mode?: SettingQualityMode | null;
}): FunctionCoverageResult {
  const mode = input.mode ?? "off";
  if (mode === "off" || !input.table || input.table.items.length === 0) {
    return { ...EMPTY_COVERAGE };
  }

  const requiredItems = input.table.items.filter((item) => item.status !== "missed");
  const referenced = new Set<string>();
  const mustAvoidByChapterOrder: Record<number, string[]> = {};

  for (const chapter of input.chapters) {
    const ids = normalizeFunctionIds(chapter.functionIds);
    for (const id of ids) {
      referenced.add(id);
    }
    const bans = uniqueStrings(
      requiredItems
        .filter((item) => ids.includes(item.id))
        .flatMap((item) => item.mustNotHappen ?? []),
    );
    if (bans.length > 0) {
      mustAvoidByChapterOrder[chapter.chapterOrder] = bans;
    }
  }

  const missingIds = requiredItems
    .filter((item) => !referenced.has(item.id))
    .map((item) => item.id);
  const knownIds = new Set(input.table.items.map((item) => item.id));
  const unreferencedIds = Array.from(referenced).filter((id) => !knownIds.has(id));

  const issues: string[] = [];
  for (const id of missingIds) {
    const item = requiredItems.find((row) => row.id === id);
    issues.push(
      item
        ? `功能未覆盖：${item.id}「${item.title}」未挂到任何章 functionIds`
        : `功能未覆盖：${id}`,
    );
  }
  for (const id of unreferencedIds) {
    issues.push(`未知 functionId 挂载：${id}（不在表 ${input.table.volumeId} 中）`);
  }

  return {
    ok: missingIds.length === 0,
    missingIds,
    unreferencedIds,
    issues,
    mustAvoidByChapterOrder,
  };
}

/**
 * enforce 门禁：表必须可 enforce 且 coverage ok。
 * advisory：仅返回结果，不 throw。
 * off：始终 ok。
 */
export function evaluateFunctionCoverageGate(input: {
  table: FunctionAcceptanceTable | null | undefined;
  chapters: FunctionCoverageChapterRef[];
  mode: SettingQualityMode;
}): {
  mode: SettingQualityMode;
  blocking: boolean;
  enforcible: FunctionTableEnforceGuardResult;
  coverage: FunctionCoverageResult;
  issues: string[];
} {
  if (input.mode === "off") {
    return {
      mode: "off",
      blocking: false,
      enforcible: { ok: true, canEnforce: false, reason: null },
      coverage: { ...EMPTY_COVERAGE },
      issues: [],
    };
  }

  const enforcible = assertFunctionTableEnforcible(input.table);
  const coverage = validateFunctionCoverage({
    table: input.table,
    chapters: input.chapters,
    mode: input.mode,
  });
  const issues = [
    ...(enforcible.reason ? [enforcible.reason] : []),
    ...coverage.issues,
  ];

  if (input.mode === "advisory") {
    return {
      mode: "advisory",
      blocking: false,
      enforcible,
      coverage,
      issues,
    };
  }

  // enforce
  const blocking = !enforcible.canEnforce || !coverage.ok;
  return {
    mode: "enforce",
    blocking,
    enforcible,
    coverage,
    issues,
  };
}

export function formatFunctionCoverageFailure(
  result: ReturnType<typeof evaluateFunctionCoverageGate>,
): string {
  if (!result.blocking && result.issues.length === 0) {
    return "";
  }
  const head = result.blocking
    ? "功能验收覆盖未完成，structured outline 事实未完成。"
    : "功能验收覆盖存在提示：";
  return `${head}${result.issues.join("；")}`;
}

/**
 * chapter_list / sync 后：把挂载到章的功能标为 assigned，并写回 assignedChapterOrders。
 * 不改变 satisfied / missed。
 */
export function applyFunctionAssignmentsFromChapters(
  table: FunctionAcceptanceTable,
  chapters: FunctionCoverageChapterRef[],
): FunctionAcceptanceTable {
  const ordersByFunctionId = new Map<string, number[]>();
  for (const chapter of chapters) {
    for (const id of normalizeFunctionIds(chapter.functionIds)) {
      const list = ordersByFunctionId.get(id) ?? [];
      list.push(chapter.chapterOrder);
      ordersByFunctionId.set(id, list);
    }
  }

  const items = table.items.map((item) => {
    if (item.status === "satisfied" || item.status === "missed") {
      return item;
    }
    const orders = uniqueOrders(ordersByFunctionId.get(item.id) ?? []);
    if (orders.length === 0) {
      return {
        ...item,
        status: "planned" as const,
        assignedChapterOrders: undefined,
      };
    }
    return {
      ...item,
      status: "assigned" as const,
      assignedChapterOrders: orders,
    };
  });

  return {
    ...table,
    items,
  };
}

/**
 * 将指定 function 标 satisfied（人工或 alignment 规则段全过）。
 * 仅当 status 为 assigned/planned 时可标；missed 需 force。
 */
export function markFunctionsSatisfied(
  table: FunctionAcceptanceTable,
  functionIds: string[],
  options: { force?: boolean } = {},
): FunctionAcceptanceTable {
  const targets = new Set(normalizeFunctionIds(functionIds));
  if (targets.size === 0) {
    return table;
  }
  return {
    ...table,
    items: table.items.map((item) => {
      if (!targets.has(item.id)) {
        return item;
      }
      if (item.status === "missed" && !options.force) {
        return item;
      }
      return {
        ...item,
        status: "satisfied" as const,
      };
    }),
  };
}

/**
 * 卷末：仍未 satisfied 且非 force 的 assigned/planned → missed（仅 enforce 语义调用方）。
 */
export function markUnsatisfiedFunctionsMissed(
  table: FunctionAcceptanceTable,
): FunctionAcceptanceTable {
  return {
    ...table,
    items: table.items.map((item) => {
      if (item.status === "satisfied" || item.status === "missed") {
        return item;
      }
      return {
        ...item,
        status: "missed" as const,
      };
    }),
  };
}

export function getFunctionTableForVolume(
  tables: FunctionAcceptanceTable[] | null | undefined,
  volumeId: string,
): FunctionAcceptanceTable | null {
  if (!tables || tables.length === 0) {
    return null;
  }
  return tables.find((table) => table.volumeId === volumeId) ?? null;
}

export function upsertFunctionAcceptanceTable(
  tables: FunctionAcceptanceTable[] | null | undefined,
  next: FunctionAcceptanceTable,
): FunctionAcceptanceTable[] {
  const current = tables ?? [];
  const index = current.findIndex((table) => table.volumeId === next.volumeId);
  if (index < 0) {
    return [...current, next];
  }
  const copy = current.slice();
  copy[index] = next;
  return copy;
}

/** 将 mustNotHappen 合并进 mustAvoid 文本（不丢旧内容） */
export function mergeMustAvoidWithFunctionBans(
  existingMustAvoid: string | null | undefined,
  bans: string[] | null | undefined,
): string | null {
  const existing = (existingMustAvoid ?? "").trim();
  const nextBans = uniqueStrings(bans ?? []);
  if (nextBans.length === 0) {
    return existing || null;
  }
  const existingParts = uniqueStrings(existing.split(/[\n；;]/g));
  const merged = uniqueStrings([...existingParts, ...nextBans]);
  return merged.join("；") || null;
}

export function isFunctionCoverageBlockingMode(mode: SettingQualityMode): boolean {
  return isSettingQualityEnforced({ mode, canonicalSliceLock: mode === "enforce" });
}
