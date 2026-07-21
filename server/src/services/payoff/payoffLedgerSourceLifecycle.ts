import type {
  PayoffLedgerRiskSignal,
  PayoffLedgerSourceRef,
  PayoffLedgerStatus,
} from "@ai-novel/shared/types/payoffLedger";

export const BOOK_CONTRACT_REF_PREFIX = "book_contract.";

export const BOOK_CONTRACT_STAGE_REFS = [
  {
    field: "chapter3Payoff" as const,
    refId: "book_contract.chapter3Payoff",
    label: "第3章阶段回报",
    windowHint: "约第1–3章",
  },
  {
    field: "chapter10Payoff" as const,
    refId: "book_contract.chapter10Payoff",
    label: "第10章阶段回报",
    windowHint: "约第4–10章",
  },
  {
    field: "chapter30Payoff" as const,
    refId: "book_contract.chapter30Payoff",
    label: "第30章阶段回报",
    windowHint: "约第11–30章",
  },
] as const;

export type BookContractPayoffFields = {
  chapter3Payoff?: string | null;
  chapter10Payoff?: string | null;
  chapter30Payoff?: string | null;
};

interface SourceBoundLedgerItem {
  ledgerKey: string;
  currentStatus: PayoffLedgerStatus;
  sourceRefs: PayoffLedgerSourceRef[];
}

interface ResolvedLedgerItem {
  ledgerKey: string;
  sourceRefs: PayoffLedgerSourceRef[];
}

export interface ResolveSupersededBookContractLedgerKeysInput {
  existingItems: SourceBoundLedgerItem[];
  resolvedItems: ResolvedLedgerItem[];
  activeBookContractRefIds: string[];
}

function compactPayoffText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeIdentity(value: string | null | undefined): string {
  return compactPayoffText(value)
    .toLowerCase()
    .replace(/[\s"'“”‘’`.,，。:：;；!！?？()[\]{}（）【】《》<>、\\/|_\-—~·…]+/g, "");
}

export function readBookContractRefId(source: PayoffLedgerSourceRef): string | null {
  const refId = source.refId?.trim() ?? "";
  return source.kind === "major_payoff" && refId.startsWith(BOOK_CONTRACT_REF_PREFIX)
    ? refId
    : null;
}

function isTerminal(status: PayoffLedgerStatus): boolean {
  return status === "paid_off" || status === "failed";
}

/** 非空 Book Contract 阶段回报 → 活跃固定 refId 列表（无合同 / 空字段 → []）。 */
export function buildActiveBookContractRefIds(
  contract: BookContractPayoffFields | null | undefined,
): string[] {
  if (!contract) {
    return [];
  }
  const active: string[] = [];
  for (const stage of BOOK_CONTRACT_STAGE_REFS) {
    if (compactPayoffText(contract[stage.field])) {
      active.push(stage.refId);
    }
  }
  return active;
}

/**
 * P2a：把 Book Contract 三阶段回报投影进对账输入，带固定 refId。
 * 与 storyMacro major_payoffs 字符串列表并存；无合同字段时返回空串。
 */
export function projectBookContractMajorPayoffsText(
  contract: BookContractPayoffFields | null | undefined,
): string {
  if (!contract) {
    return "";
  }
  const lines = BOOK_CONTRACT_STAGE_REFS
    .map((stage) => {
      const text = compactPayoffText(contract[stage.field]);
      if (!text) {
        return null;
      }
      return `- refId=${stage.refId} | ${stage.label}（${stage.windowHint}）：${text}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return "";
  }
  return [
    "Book Contract 固定阶段回报（sourceRefs.kind=major_payoff 时必须使用下列 refId）：",
    ...lines,
  ].join("\n");
}

/**
 * 对 AI 产出的 major_payoff 来源补齐固定 refId（仅当 refId 缺失且文案命中活跃合同字段）。
 * 不发明新账项；匹配失败则原样返回。
 */
export function attachFixedBookContractRefIds<T extends {
  title?: string | null;
  summary?: string | null;
  sourceRefs: PayoffLedgerSourceRef[];
}>(
  items: T[],
  contract: BookContractPayoffFields | null | undefined,
): T[] {
  if (!contract || items.length === 0) {
    return items;
  }
  const stages = BOOK_CONTRACT_STAGE_REFS
    .map((stage) => {
      const text = compactPayoffText(contract[stage.field]);
      if (!text) {
        return null;
      }
      return {
        ...stage,
        text,
        identity: normalizeIdentity(text),
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage));
  if (stages.length === 0) {
    return items;
  }

  return items.map((item) => {
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) {
      return item;
    }
    const titleId = normalizeIdentity(item.title);
    const summaryId = normalizeIdentity(item.summary);
    let changed = false;
    const nextRefs = item.sourceRefs.map((source) => {
      if (source.kind !== "major_payoff") {
        return source;
      }
      const existing = source.refId?.trim();
      if (existing?.startsWith(BOOK_CONTRACT_REF_PREFIX)) {
        return source;
      }
      const labelId = normalizeIdentity(source.refLabel);
      const matched = stages.find((stage) => (
        stage.identity
        && (
          stage.identity === labelId
          || stage.identity === titleId
          || (summaryId.length > 0 && (
            summaryId.includes(stage.identity) || stage.identity.includes(summaryId)
          ))
        )
      ));
      if (!matched) {
        return source;
      }
      changed = true;
      return {
        ...source,
        refId: matched.refId,
        refLabel: source.refLabel?.trim() || matched.text,
      };
    });
    return changed ? { ...item, sourceRefs: nextRefs } : item;
  });
}

export const SOURCE_SUPERSEDED_RISK_CODE = "source_superseded";

export function buildSourceSupersededRiskSignal(summary?: string): PayoffLedgerRiskSignal {
  return {
    code: SOURCE_SUPERSEDED_RISK_CODE,
    severity: "medium",
    summary: summary?.trim()
      || "Book Contract 固定来源已被移除或由新账项接管，该义务已退役。",
  };
}

/** 消费侧去污：合同来源退役的 failed 不算叙事/质量失败。 */
export function isSourceSupersededFailedItem(item: {
  currentStatus?: string | null;
  riskSignals?: Array<{ code?: string | null }> | null;
  riskSignalsJson?: string | null;
}): boolean {
  if (item.currentStatus !== "failed") {
    return false;
  }
  const signals = Array.isArray(item.riskSignals)
    ? item.riskSignals
    : (() => {
      if (typeof item.riskSignalsJson !== "string" || !item.riskSignalsJson.trim()) {
        return [] as Array<{ code?: string | null }>;
      }
      try {
        const parsed = JSON.parse(item.riskSignalsJson) as unknown;
        return Array.isArray(parsed) ? parsed as Array<{ code?: string | null }> : [];
      } catch {
        return [];
      }
    })();
  return signals.some((signal) => signal?.code === SOURCE_SUPERSEDED_RISK_CODE);
}

/**
 * 退役候选：尚未终结、未被本轮复用、来源全部为 book_contract.*，
 * 且每个固定来源已从合同移除或被其他 ledgerKey 接管。
 */
export function resolveSupersededBookContractLedgerKeys(
  input: ResolveSupersededBookContractLedgerKeysInput,
): Set<string> {
  const activeRefIds = new Set(input.activeBookContractRefIds);
  const resolvedKeys = new Set(input.resolvedItems.map((item) => item.ledgerKey));
  const resolvedOwnerByRefId = new Map<string, string>();

  for (const item of input.resolvedItems) {
    for (const source of item.sourceRefs) {
      const refId = readBookContractRefId(source);
      if (refId) {
        resolvedOwnerByRefId.set(refId, item.ledgerKey);
      }
    }
  }

  const supersededKeys = new Set<string>();
  for (const item of input.existingItems) {
    if (isTerminal(item.currentStatus) || resolvedKeys.has(item.ledgerKey) || item.sourceRefs.length === 0) {
      continue;
    }
    const bookContractRefIds = item.sourceRefs
      .map(readBookContractRefId)
      .filter((refId): refId is string => Boolean(refId));
    // 混合来源保守保留：必须全部 source 都是 book_contract.*
    if (bookContractRefIds.length !== item.sourceRefs.length) {
      continue;
    }
    const allSourcesRetiredOrReassigned = bookContractRefIds.every((refId) => (
      !activeRefIds.has(refId)
      || resolvedOwnerByRefId.get(refId) !== item.ledgerKey
    ));
    if (allSourcesRetiredOrReassigned) {
      supersededKeys.add(item.ledgerKey);
    }
  }
  return supersededKeys;
}
