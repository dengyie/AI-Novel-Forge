import type { FunctionAcceptanceTable } from "./functionAcceptance.js";
import {
  evaluateFunctionCoverageGate,
  getFunctionTableForVolume,
  normalizeFunctionIds,
  validateFunctionCoverage,
} from "./functionAcceptance.js";
import type { SettingQualityMode } from "./settingQualityPolicy.js";
import { resolveSettingQualityPolicy } from "./settingQualityPolicy.js";

/**
 * C1 Outline Freeze（复用 structured_outline_ready，禁止平行 checkpoint）。
 * SoT 建议挂 VolumePlanDocument.outlineFreezeSnapshots[] 或 director artifact JSON。
 *
 * shared 包无 node types：指纹用 FNV-1a 64-bit 字符串，不依赖 node:crypto。
 */

export const OUTLINE_FREEZE_SCHEMA_VERSION = 1 as const;
export const OUTLINE_DIFF_REPORT_VERSION = "outline-diff-v1" as const;

export type OutlineFunctionCoverageMatrixRow = {
  functionId: string;
  title: string;
  chapterOrders: number[];
  status: string;
};

export type OutlineDiffHardBanHit = {
  term: string;
  chapterOrders: number[];
  source: "function_must_not" | "must_avoid" | "hard_forbidden";
};

export type OutlineDiffReport = {
  version: typeof OUTLINE_DIFF_REPORT_VERSION;
  volumeId: string;
  mode: SettingQualityMode;
  coverageOk: boolean;
  blocking: boolean;
  /** item → 挂载章序 */
  coverageMatrix: OutlineFunctionCoverageMatrixRow[];
  hardBanHits: OutlineDiffHardBanHit[];
  /** 舞台/人物坑信息性窗口（非 hard gate） */
  stageAnchorHints: string[];
  characterPitHints: string[];
  /** 与 beat 名仅信息性对比 */
  beatNameHints: string[];
  issues: string[];
  summary: string;
  builtAt: string;
};

export type OutlineFreezeSnapshot = {
  schemaVersion: typeof OUTLINE_FREEZE_SCHEMA_VERSION;
  volumeId: string;
  novelId?: string | null;
  mode: SettingQualityMode;
  /** 卷章列表 + functionIds 稳定指纹 */
  contentHash: string;
  /** 功能表指纹（id/title/checks） */
  tableFingerprint: string;
  coverageOk: boolean;
  diffSummary: string;
  diffReport: OutlineDiffReport;
  /** 绑定 structured_outline_ready 审批，非新 checkpointType */
  approvalPoint: "structured_outline_ready";
  frozenAt: string;
  actor?: string | null;
  reason?: string | null;
};

export type OutlineFreezeChapterRef = {
  chapterOrder: number;
  title?: string | null;
  summary?: string | null;
  exclusiveEvent?: string | null;
  mustAvoid?: string | null;
  functionIds?: string[] | null;
  purpose?: string | null;
};

/** 稳定指纹（非加密）：FNV-1a 双 32-bit 拼 16 hex，shared 包无 crypto。 */
function stableHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x01000193);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function uniqueOrders(values: number[]): number[] {
  return Array.from(new Set(values.filter((n) => Number.isFinite(n) && n > 0)))
    .map((n) => Math.trunc(n))
    .sort((a, b) => a - b);
}

export function fingerprintFunctionAcceptanceTable(
  table: FunctionAcceptanceTable | null | undefined,
): string {
  if (!table || table.items.length === 0) {
    return stableHash("empty-function-table");
  }
  const payload = {
    volumeId: table.volumeId,
    source: table.source,
    items: table.items.map((item) => ({
      id: item.id,
      order: item.order,
      title: item.title,
      mustHappen: item.mustHappen,
      mustNotHappen: item.mustNotHappen ?? [],
      acceptanceChecks: item.acceptanceChecks,
      status: item.status,
    })),
  };
  return stableHash(JSON.stringify(payload));
}

export function fingerprintOutlineChapterAssignments(
  chapters: OutlineFreezeChapterRef[],
): string {
  const payload = chapters
    .slice()
    .sort((a, b) => a.chapterOrder - b.chapterOrder)
    .map((chapter) => ({
      order: chapter.chapterOrder,
      title: chapter.title ?? "",
      exclusiveEvent: chapter.exclusiveEvent ?? "",
      functionIds: normalizeFunctionIds(chapter.functionIds),
      mustAvoid: chapter.mustAvoid ?? "",
    }));
  return stableHash(JSON.stringify(payload));
}

function scanHardBanHits(
  chapters: OutlineFreezeChapterRef[],
  table: FunctionAcceptanceTable | null | undefined,
  extraHardForbidden: string[] = [],
): OutlineDiffHardBanHit[] {
  const termToOrders = new Map<string, { orders: number[]; source: OutlineDiffHardBanHit["source"] }>();
  const banFromTable = (table?.items ?? []).flatMap((item) => item.mustNotHappen ?? []);
  const catalog = uniqueStrings([...banFromTable, ...extraHardForbidden]);

  for (const chapter of chapters) {
    const blob = [
      chapter.title,
      chapter.summary,
      chapter.exclusiveEvent,
      chapter.purpose,
      chapter.mustAvoid,
    ].filter(Boolean).join("\n");
    for (const term of catalog) {
      if (term && blob.includes(term)) {
        const prev = termToOrders.get(term);
        if (prev) {
          prev.orders.push(chapter.chapterOrder);
        } else {
          termToOrders.set(term, {
            orders: [chapter.chapterOrder],
            source: banFromTable.includes(term) ? "function_must_not" : "hard_forbidden",
          });
        }
      }
    }
  }

  return Array.from(termToOrders.entries()).map(([term, meta]) => ({
    term,
    chapterOrders: uniqueOrders(meta.orders),
    source: meta.source,
  }));
}

function buildCoverageMatrix(
  table: FunctionAcceptanceTable | null | undefined,
  chapters: OutlineFreezeChapterRef[],
): OutlineFunctionCoverageMatrixRow[] {
  if (!table) {
    return [];
  }
  return table.items.map((item) => {
    const chapterOrders = uniqueOrders(
      chapters
        .filter((chapter) => normalizeFunctionIds(chapter.functionIds).includes(item.id))
        .map((chapter) => chapter.chapterOrder),
    );
    return {
      functionId: item.id,
      title: item.title,
      chapterOrders,
      status: item.status,
    };
  });
}

/**
 * 相对功能表的 outline diff（信息性 + coverage 结果）。
 * mode=off：轻量报告，coverageOk=true，blocking=false。
 */
export function buildOutlineDiffAgainstFunctions(input: {
  volumeId: string;
  chapters: OutlineFreezeChapterRef[];
  table?: FunctionAcceptanceTable | null;
  mode?: SettingQualityMode | null;
  beatNames?: string[] | null;
  hardForbiddenTerms?: string[] | null;
  builtAt?: string;
}): OutlineDiffReport {
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  const table = input.table ?? null;
  const chapters = input.chapters ?? [];
  const builtAt = input.builtAt ?? new Date().toISOString();

  if (mode === "off" || !table || table.items.length === 0) {
    return {
      version: OUTLINE_DIFF_REPORT_VERSION,
      volumeId: input.volumeId,
      mode,
      coverageOk: true,
      blocking: false,
      coverageMatrix: buildCoverageMatrix(table, chapters),
      hardBanHits: [],
      stageAnchorHints: [],
      characterPitHints: [],
      beatNameHints: uniqueStrings(input.beatNames ?? []).slice(0, 12),
      issues: [],
      summary: mode === "off"
        ? "settingQualityMode=off：outline diff 仅信息性，不挡 structured_outline 事实。"
        : "无功能验收表：outline diff 空跑通过。",
      builtAt,
    };
  }

  const gate = evaluateFunctionCoverageGate({
    table,
    chapters: chapters.map((chapter) => ({
      chapterOrder: chapter.chapterOrder,
      functionIds: chapter.functionIds,
      mustAvoid: chapter.mustAvoid,
    })),
    mode,
  });
  const coverage = validateFunctionCoverage({
    table,
    chapters: chapters.map((chapter) => ({
      chapterOrder: chapter.chapterOrder,
      functionIds: chapter.functionIds,
      mustAvoid: chapter.mustAvoid,
    })),
    mode,
  });
  const hardBanHits = scanHardBanHits(chapters, table, input.hardForbiddenTerms ?? []);
  const stageAnchorHints = uniqueStrings(
    chapters
      .map((chapter) => chapter.exclusiveEvent?.trim() || "")
      .filter(Boolean),
  ).slice(0, 12);
  const characterPitHints = uniqueStrings(
    (table.items ?? []).flatMap((item) => item.charactersOnPage ?? []),
  ).slice(0, 12);
  const beatNameHints = uniqueStrings(input.beatNames ?? []).slice(0, 12);

  const summaryParts = [
    gate.blocking ? "coverage 未通过（enforce 应保持 outline 事实未完成）" : "coverage 通过",
    `功能 ${table.items.length} 项`,
    coverage.missingIds.length > 0 ? `未挂载 ${coverage.missingIds.length}` : "全部挂载",
    hardBanHits.length > 0 ? `硬禁扫描命中 ${hardBanHits.length}` : "硬禁扫描无命中",
  ];

  return {
    version: OUTLINE_DIFF_REPORT_VERSION,
    volumeId: input.volumeId,
    mode,
    coverageOk: coverage.ok && gate.enforcible.canEnforce !== false,
    blocking: gate.blocking,
    coverageMatrix: buildCoverageMatrix(table, chapters),
    hardBanHits,
    stageAnchorHints,
    characterPitHints,
    beatNameHints,
    issues: gate.issues,
    summary: summaryParts.join("；"),
    builtAt,
  };
}

/**
 * 审批 structured_outline_ready 通过后构建 freeze snapshot。
 * 不创建新 checkpointType。
 */
export function buildOutlineFreezeSnapshot(input: {
  volumeId: string;
  novelId?: string | null;
  chapters: OutlineFreezeChapterRef[];
  table?: FunctionAcceptanceTable | null;
  mode?: SettingQualityMode | null;
  beatNames?: string[] | null;
  hardForbiddenTerms?: string[] | null;
  actor?: string | null;
  reason?: string | null;
  frozenAt?: string;
  builtAt?: string;
}): OutlineFreezeSnapshot {
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  const diffReport = buildOutlineDiffAgainstFunctions({
    volumeId: input.volumeId,
    chapters: input.chapters,
    table: input.table,
    mode,
    beatNames: input.beatNames,
    hardForbiddenTerms: input.hardForbiddenTerms,
    builtAt: input.builtAt,
  });
  const contentHash = fingerprintOutlineChapterAssignments(input.chapters);
  const tableFingerprint = fingerprintFunctionAcceptanceTable(input.table);
  return {
    schemaVersion: OUTLINE_FREEZE_SCHEMA_VERSION,
    volumeId: input.volumeId,
    novelId: input.novelId ?? null,
    mode,
    contentHash,
    tableFingerprint,
    coverageOk: diffReport.coverageOk && !diffReport.blocking,
    diffSummary: diffReport.summary,
    diffReport,
    approvalPoint: "structured_outline_ready",
    frozenAt: input.frozenAt ?? new Date().toISOString(),
    actor: input.actor ?? null,
    reason: input.reason ?? null,
  };
}

export function isOutlineFreezeSnapshotValid(
  snapshot: OutlineFreezeSnapshot | null | undefined,
  input: {
    chapters: OutlineFreezeChapterRef[];
    table?: FunctionAcceptanceTable | null;
    mode?: SettingQualityMode | null;
  },
): boolean {
  if (!snapshot || snapshot.schemaVersion !== OUTLINE_FREEZE_SCHEMA_VERSION) {
    return false;
  }
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  if (mode === "off" || mode === "advisory") {
    // off/advisory：不因缺 snapshot 拦截
    return true;
  }
  if (snapshot.volumeId.length === 0) {
    return false;
  }
  if (!snapshot.coverageOk) {
    return false;
  }
  const contentHash = fingerprintOutlineChapterAssignments(input.chapters);
  const tableFingerprint = fingerprintFunctionAcceptanceTable(input.table);
  return snapshot.contentHash === contentHash && snapshot.tableFingerprint === tableFingerprint;
}

/**
 * enforce 下：无合法 freeze 且 coverage 未过 → 视同 outline 事实未完成。
 * off/advisory：始终 allow。
 */
export function evaluateOutlineFreezeGate(input: {
  mode?: SettingQualityMode | null;
  snapshot?: OutlineFreezeSnapshot | null;
  chapters: OutlineFreezeChapterRef[];
  table?: FunctionAcceptanceTable | null;
}): {
  mode: SettingQualityMode;
  allowAutoExecute: boolean;
  requireFreeze: boolean;
  coverageBlocking: boolean;
  freezeValid: boolean;
  reason: string | null;
} {
  const mode = resolveSettingQualityPolicy(input.mode ? { mode: input.mode } : null).mode;
  if (mode === "off" || mode === "advisory") {
    return {
      mode,
      allowAutoExecute: true,
      requireFreeze: false,
      coverageBlocking: false,
      freezeValid: true,
      reason: null,
    };
  }

  const diff = buildOutlineDiffAgainstFunctions({
    volumeId: input.table?.volumeId ?? input.snapshot?.volumeId ?? "unknown",
    chapters: input.chapters,
    table: input.table,
    mode,
  });
  const freezeValid = isOutlineFreezeSnapshotValid(input.snapshot, {
    chapters: input.chapters,
    table: input.table,
    mode,
  });
  const coverageBlocking = diff.blocking;
  if (coverageBlocking) {
    return {
      mode,
      allowAutoExecute: false,
      requireFreeze: true,
      coverageBlocking: true,
      freezeValid,
      reason: "enforce 下功能覆盖未完成，structured_outline 事实未完成（等同未批 outline）。",
    };
  }
  if (!input.snapshot) {
    // 覆盖已过但尚未审批冻结：允许继续走现网审批，不单独拦 auto_execute
    // （auto_execute 仍受 structured_outline_ready 现网门禁）
    return {
      mode,
      allowAutoExecute: true,
      requireFreeze: true,
      coverageBlocking: false,
      freezeValid: false,
      reason: "enforce 覆盖已过，等待 structured_outline_ready 审批写入 freeze snapshot。",
    };
  }
  if (!freezeValid) {
    return {
      mode,
      allowAutoExecute: false,
      requireFreeze: true,
      coverageBlocking: false,
      freezeValid: false,
      reason: "freeze snapshot 与当前章/表指纹不一致，需重新审批 structured_outline_ready。",
    };
  }
  return {
    mode,
    allowAutoExecute: true,
    requireFreeze: true,
    coverageBlocking: false,
    freezeValid: true,
    reason: null,
  };
}

export function upsertOutlineFreezeSnapshot(
  snapshots: OutlineFreezeSnapshot[] | null | undefined,
  next: OutlineFreezeSnapshot,
): OutlineFreezeSnapshot[] {
  const current = snapshots ?? [];
  const index = current.findIndex((item) => item.volumeId === next.volumeId);
  if (index < 0) {
    return [...current, next];
  }
  const copy = current.slice();
  copy[index] = next;
  return copy;
}

export function getOutlineFreezeSnapshotForVolume(
  snapshots: OutlineFreezeSnapshot[] | null | undefined,
  volumeId: string,
): OutlineFreezeSnapshot | null {
  if (!snapshots || snapshots.length === 0) {
    return null;
  }
  return snapshots.find((item) => item.volumeId === volumeId) ?? null;
}

export function resolveFunctionTableForOutline(
  tables: FunctionAcceptanceTable[] | null | undefined,
  volumeId: string,
): FunctionAcceptanceTable | null {
  return getFunctionTableForVolume(tables, volumeId);
}
