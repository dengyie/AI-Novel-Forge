import type {
  PayoffLedgerItem,
  PayoffLedgerResponse,
  PayoffLedgerRiskSignal,
  PayoffLedgerSourceRef,
  PayoffLedgerStatus,
  PayoffLedgerSummary,
} from "@ai-novel/shared/types/payoffLedger";
import { isSourceSupersededFailedItem } from "./payoffLedgerSourceLifecycle";

type PayoffLedgerRowLike = {
  id: string;
  novelId: string;
  ledgerKey: string;
  title: string;
  summary: string;
  scopeType: "book" | "volume" | "chapter";
  currentStatus: "setup" | "hinted" | "pending_payoff" | "paid_off" | "failed" | "overdue";
  targetStartChapterOrder: number | null;
  targetEndChapterOrder: number | null;
  firstSeenChapterOrder: number | null;
  lastTouchedChapterOrder: number | null;
  lastTouchedChapterId: string | null;
  setupChapterId: string | null;
  payoffChapterId: string | null;
  lastSnapshotId: string | null;
  sourceRefsJson: string | null;
  evidenceJson: string | null;
  riskSignalsJson: string | null;
  statusReason: string | null;
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type PayoffLedgerSyncCandidate = {
  ledgerKey: string;
  title: string;
  scopeType: "book" | "volume" | "chapter";
  currentStatus: PayoffLedgerStatus;
  targetStartChapterOrder?: number | null;
  targetEndChapterOrder?: number | null;
  payoffChapterId?: string | null;
  payoffChapterOrder?: number | null;
  riskSignals: PayoffLedgerRiskSignal[];
  statusReason?: string | null;
  // 退化匹配用：新 key 的 setup 章号。优先 setupChapterOrder，缺失时回落
  // firstSeenChapterOrder。LM 为同剧情造的无窗口新 key 变体靠这个跟已兑现终态行
  // 的 setup 章做区间校验，避免误拦续卷同类新伏笔。
  firstSeenChapterOrder?: number | null;
  setupChapterId?: string | null;
  setupChapterOrder?: number | null;
};

type ExistingLedgerIdentityRow = {
  ledgerKey: string;
  title: string;
  scopeType: "book" | "volume" | "chapter";
  currentStatus: PayoffLedgerStatus;
  targetStartChapterOrder: number | null;
  targetEndChapterOrder: number | null;
  lastTouchedChapterOrder: number | null;
  updatedAt: Date | string;
  // 退化匹配用：终态行的 setup 章号来源有两种形态——Prisma row 嵌套在
  // setupChapter.order（两条写路径都裸传 row），或拓平到 setupChapterOrder。
  // matchDegenerateTerminalRow 两者都读，优先 setupChapterOrder，回落 setupChapter.order。
  firstSeenChapterOrder?: number | null;
  setupChapterId?: string | null;
  setupChapterOrder?: number | null;
  setupChapter?: { order: number | null } | null;
};

export interface SyntheticPayoffIssue {
  ledgerKey: string;
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: string;
  fixSuggestion: string;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw?.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function serializeLedgerJson(value: unknown): string {
  return JSON.stringify(value ?? []);
}

export function dedupeRiskSignals(signals: PayoffLedgerRiskSignal[]): PayoffLedgerRiskSignal[] {
  const seen = new Set<string>();
  const results: PayoffLedgerRiskSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.code}:${signal.summary}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(signal);
  }
  return results;
}

export function appendStaleRiskSignal(
  signals: PayoffLedgerRiskSignal[],
  summary: string,
): PayoffLedgerRiskSignal[] {
  return dedupeRiskSignals([
    ...signals.filter((signal) => signal.code !== "sync_stale"),
    {
      code: "sync_stale",
      severity: "medium",
      summary,
      stale: true,
    },
  ]);
}

export function clearStaleRiskSignal(signals: PayoffLedgerRiskSignal[]): PayoffLedgerRiskSignal[] {
  return signals.filter((signal) => signal.code !== "sync_stale");
}

export function normalizePayoffLedgerIdentity(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s"'“”‘’`.,，。:：;；!！?？()[\]{}（）【】《》<>、\\/|_\-—~·…]+/g, "");
}

function isUnfinishedPayoffStatus(status: PayoffLedgerStatus): boolean {
  return status !== "paid_off" && status !== "failed";
}

const TERMINAL_PAYOFF_STATUSES: ReadonlySet<PayoffLedgerStatus> = new Set(["paid_off", "failed"]);

/**
 * 终态判定：paid_off / failed。终态一旦落定，LLM 对账不得自动重开为 active 状态
 * （setup/hinted/pending_payoff/overdue）。重复登记的旧窗口伏笔每轮都会被 LLM 重报，
 * 若无保护会反复 reopen→replan→failed。终态只能由显式人工/系统动作改变。
 */
export function isTerminalPayoffStatus(status: PayoffLedgerStatus | string | null | undefined): boolean {
  return Boolean(status) && TERMINAL_PAYOFF_STATUSES.has(status as PayoffLedgerStatus);
}

/**
 * 构造 payoff_regressed 信号：LLM 对账试图把已终态（paid_off/failed）的伏笔重开为
 * active 状态时，记一条人工可见的风险信号。终态 currentStatus 由调用方负责保留，
 * 本函数只产出信号，不改变状态。
 */
export function buildReopenedTerminalRiskSignal(
  previousStatus: PayoffLedgerStatus,
  nextStatus: PayoffLedgerStatus,
): PayoffLedgerRiskSignal {
  return {
    code: "payoff_regressed",
    severity: "high",
    summary: `LLM 对账试图把已${previousStatus === "paid_off" ? "兑现" : "失败"}的伏笔重新标记为「${nextStatus}」，已拒绝重开，保留终态。`,
  };
}

function hasExplicitPayoffWindow(item: PayoffLedgerSyncCandidate): boolean {
  return typeof item.targetStartChapterOrder === "number"
    || typeof item.targetEndChapterOrder === "number"
    || typeof item.payoffChapterOrder === "number"
    || Boolean(item.payoffChapterId?.trim());
}

/**
 * 判定"窗口未过却标 overdue"这类逻辑自相矛盾的伏笔项。
 *
 * overdue 的定义是"已过 targetEnd 仍未兑现"。若 targetEnd ≥ 当前章，目标窗口
 * 尚未结束，标逾期不成立——多半是 LLM 把剧情内的紧迫感（倒计时、危机、处境恶化）
 * 误当成账本逾期。写入层（sanitizePayoffLedgerSyncItem）与读取层
 * （CanonicalStateService overduePayoffs 过滤）共用此判据，避免逻辑漂移。
 */
export function isPrematureOverduePayoff(
  item: { currentStatus: string; targetEndChapterOrder?: number | null },
  chapterOrder: number | null | undefined,
): boolean {
  return item.currentStatus === "overdue"
    && typeof chapterOrder === "number"
    && Number.isFinite(chapterOrder)
    && typeof item.targetEndChapterOrder === "number"
    && item.targetEndChapterOrder >= chapterOrder;
}

/**
 * 识别"审计问题被 LLM 误当成伏笔回灌"的伪 ledger 项。
 *
 * 反馈环：章节审校产出 payoff_missing_progress / payoff_overdue 审计问题 →
 * 这些问题文本被喂进 payoffLedgerSync prompt 的 payoffAuditIssuesText →
 * LLM 把"审计问题"本身误当成一条伏笔，造出以章节+审计动词命名的 ledgerKey
 * （标题"第N章…未兑现/未touch"、evidence 引用"审校列出/审校指出"、
 * riskSignal 自指 payoff_missing_progress）。它带章节窗口 → 被标 overdue →
 * 触发 PIPELINE_REPLAN_REQUIRED → 任务 failed → 下一轮又回灌，自我放大。
 *
 * 判据是双重门（两者都满足才算伪项），真实伏笔（slate_map_clue、
 * flametail_golden_aftermath、northwest_anomaly_base）一律不命中：
 *   1. 章节作用域：key 里有 `chapterN` / `chN` 独立段（前缀或后缀都算），
 *      因为伪项永远绑定某个具体章节；真实伏笔按故事内容命名，不带章号。
 *   2. 审计语义 token：key 含审计动词短语（missing_progress、missing_obligation、
 *      touch_missing、overdue 等）。LLM 换命名方式（chapterN_missing_progress ↔
 *      missing_obligations_chN）都能被覆盖。
 *
 * 单独任一条件都不够：`ch9_foreshadow_02`（有章号无审计词）是真实伏笔；
 * `slate_map_clue_missing_progress`（有审计词无章号）按故事内容命名，不误删。
 */
const PSEUDO_LEDGER_AUDIT_TOKENS = [
  "missing_progress",
  "missing_obligation",
  "touch_missing",
  "not_touched",
  "untouched",
  "no_progress",
  "payoff_overdue",
  "overdue",
];

// `chapterN` / `chN` / `ch12_13` 作为独立段出现（^ 或 _ 边界，_ 或 $ 收尾）。
const CHAPTER_SCOPED_KEY = /(^|_)(chapter|ch)\d+(_\d+)*(_|$)/;

export function isAuditArtifactLedgerKey(ledgerKey: string | null | undefined): boolean {
  const key = String(ledgerKey ?? "").trim().toLowerCase();
  if (!key) {
    return false;
  }
  if (!CHAPTER_SCOPED_KEY.test(key)) {
    return false;
  }
  return PSEUDO_LEDGER_AUDIT_TOKENS.some((token) => key.includes(token));
}

function compareExistingLedgerIdentityRows(
  item: PayoffLedgerSyncCandidate,
  left: ExistingLedgerIdentityRow,
  right: ExistingLedgerIdentityRow,
): number {
  const leftScopeScore = left.scopeType === item.scopeType ? 1 : 0;
  const rightScopeScore = right.scopeType === item.scopeType ? 1 : 0;
  if (leftScopeScore !== rightScopeScore) {
    return rightScopeScore - leftScopeScore;
  }
  const leftWindowScore = typeof left.targetEndChapterOrder === "number" ? 1 : 0;
  const rightWindowScore = typeof right.targetEndChapterOrder === "number" ? 1 : 0;
  if (leftWindowScore !== rightWindowScore) {
    return rightWindowScore - leftWindowScore;
  }
  const leftTouched = left.lastTouchedChapterOrder ?? Number.NEGATIVE_INFINITY;
  const rightTouched = right.lastTouchedChapterOrder ?? Number.NEGATIVE_INFINITY;
  if (leftTouched !== rightTouched) {
    return rightTouched - leftTouched;
  }
  const leftUpdatedAt = new Date(left.updatedAt).getTime() || 0;
  const rightUpdatedAt = new Date(right.updatedAt).getTime() || 0;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return left.ledgerKey.localeCompare(right.ledgerKey);
}

// 第四级退化匹配：终态行无窗口时的 setup 区间 + 标题最长公共子串兜底。
// LLM 为同一段已兑现剧情反复造新 ledgerKey 变体——部分终态行（如 league_traitor、
// alliance_mole）根本没有 targetStart/targetEnd，窗口指纹（第三级）对不上新 key 的
// 过期窗口，新 key 直落 overdue→replan。本级在窗口指紋未命中后兜底：用 setup 章区间
// 重叠 + 归一化标题最长公共连续子串长度门槛把新 key 重映射到已兑现终态行，让下游
// 终态守卫拒重开。用 LCS 而非子串：同源变体标题常含插入词（「联盟内部卧底」vs
// 「联盟内部反派卧底」中间插了「反派」），互非子串但有连续命中段「联盟内部」。
//
// 三重收敛防误拦续卷真实新伏笔：
// 1. setup 章区间：新 key setup 章在终态行 setup±容差内（容差=max(新 key 窗口跨度,10)），
//    同源剧情 setup 章必然靠近；续卧行 setup 章在很后面，超容差不命中。
// 2. scopeType 一致：book/volume/chapter 不同 scope 不比。
// 3. LCS 长度门槛 4：归一化后两串最长公共连续子串 <4 字符（如单字「卧」命中所有含卧
//    标题）不命中，避免误抓。同源变体必有 ≥4 的连续段（「联盟内部」）。
function matchDegenerateTerminalRow(
  item: PayoffLedgerSyncCandidate,
  rows: ExistingLedgerIdentityRow[],
): ExistingLedgerIdentityRow | undefined {
  const itemNorm = normalizePayoffLedgerIdentity(item.title);
  if (!itemNorm) {
    return undefined;
  }
  const MIN_SUBSTRING = 4;
  const WINDOW_TOLERANCE = 10;
  const itemSetup = item.setupChapterOrder ?? item.firstSeenChapterOrder ?? null;
  if (itemSetup == null) {
    return undefined;
  }
  const resolveRowSetup = (row: ExistingLedgerIdentityRow): number | null => {
    if (typeof row.setupChapterOrder === "number") {
      return row.setupChapterOrder;
    }
    if (row.setupChapter && typeof row.setupChapter.order === "number") {
      return row.setupChapter.order;
    }
    return null;
  };
  // 最长公共连续子串（LCS substring）。同源剧情变体标题虽非彼此子串（如「联盟内部卧底」
  // vs「联盟内部反派卧底」中间插入了「反派」），但归一化后必有连续命中段（"联盟内部"
  // 4 字）。共享关键令牌长度门槛拒「卧」单字这类误抓。
  const longestCommonSubstring = (a: string, b: string): number => {
    if (!a || !b) {
      return 0;
    }
    let longest = 0;
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      const prev = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          prev[j] = dp[j - 1] + 1;
          if (prev[j] > longest) {
            longest = prev[j];
          }
        }
      }
      dp.splice(0, dp.length, ...prev);
    }
    return longest;
  };
  const windowSpan = Math.abs(
    (item.targetEndChapterOrder ?? 0) - (item.targetStartChapterOrder ?? 0),
  );
  const tolerance = Math.max(windowSpan, WINDOW_TOLERANCE);
  const candidates = rows
    .filter((row) => {
      if (!isTerminalPayoffStatus(row.currentStatus) || row.scopeType !== item.scopeType) {
        return false;
      }
      const rowSetup = resolveRowSetup(row);
      return rowSetup != null && Math.abs(rowSetup - itemSetup) <= tolerance;
    })
    .filter((row) => {
      const rowNorm = normalizePayoffLedgerIdentity(row.title);
      if (!rowNorm) {
        return false;
      }
      return longestCommonSubstring(itemNorm, rowNorm) >= MIN_SUBSTRING;
    })
    .sort((left, right) => compareExistingLedgerIdentityRows(item, left, right));
  return candidates[0];
}

export function resolvePayoffLedgerSyncLedgerKey(
  item: PayoffLedgerSyncCandidate,
  existingRows: ExistingLedgerIdentityRow[],
): string {
  if (existingRows.some((row) => row.ledgerKey === item.ledgerKey)) {
    return item.ledgerKey;
  }
  const identity = normalizePayoffLedgerIdentity(item.title);

  // 标题归一化匹配：只复用"未终态"的同名行。终态行（paid_off/failed）不复用——
  // 同名可能是续作里的新伏笔，强行复用会被终态守卫误压。保持既有行为。
  const titleCandidates = identity
    ? existingRows
        .filter((row) => isUnfinishedPayoffStatus(row.currentStatus))
        .filter((row) => normalizePayoffLedgerIdentity(row.title) === identity)
        .sort((left, right) => compareExistingLedgerIdentityRows(item, left, right))
    : [];

  if (titleCandidates[0]) {
    return titleCandidates[0].ledgerKey;
  }

  // 跨 key 重复登记防御（窗口指纹兜底）：LLM 会给同一段已兑现剧情反复发明新
  // ledgerKey 变体（碎鳞救治弧已出现 5 个 key，全指向 ch40 已兑现的同一段剧情）。
  // 按 key 查 previous 的终态守卫拦不住新 key——新 key 无 previous 终态可保护，落到
  // overdue 就触发 replan。这里用"窗口指纹"（targetStart+targetEnd 完全相同）把新 key
  // 重映射到同窗口的终态行，让终态守卫生效：LLM 想把已兑现剧情重报为 overdue 时，
  // previous 命中终态行 → 守卫拒绝重开 → 保留 paid_off。
  //
  // 窗口指纹是强信号（同 start+end 几乎必是同一伏笔弧），比标题更可靠——标题会被
  // LLM 微调（"碎鳞药剂倒计时与救治" vs "碎鳞药剂倒计时与救治压力"），但窗口是结构
  // 化字段，LLM 抄自同一来源，稳定一致。仅终态行参与：active 行的同窗口匹配走标题
  // 路径已处理；这里专治"已兑现剧情的新 key 变体"。
  const itemStart = item.targetStartChapterOrder ?? null;
  const itemEnd = item.targetEndChapterOrder ?? null;
  if (typeof itemStart === "number" && typeof itemEnd === "number") {
    const windowMatch = existingRows
      .filter((row) => isTerminalPayoffStatus(row.currentStatus))
      .filter((row) => row.targetEndChapterOrder === itemEnd
        && row.targetStartChapterOrder === itemStart)
      .sort((left, right) => compareExistingLedgerIdentityRows(item, left, right));
    if (windowMatch[0]) {
      return windowMatch[0].ledgerKey;
    }
  }

  // 第四级退化匹配：终态行无窗口（窗口指纹够不着）时，靠 setup 章区间 + 标题最长
  // 公共子串把新 key 重映射到已兑现终态行，让下游终态守卫拒重开。详见 matchDegenerateTerminalRow。
  const degenerateMatch = matchDegenerateTerminalRow(item, existingRows);
  if (degenerateMatch) {
    return degenerateMatch.ledgerKey;
  }

  return item.ledgerKey;
}

export function sanitizePayoffLedgerSyncItem<T extends PayoffLedgerSyncCandidate>(
  item: T,
  chapterOrder?: number | null,
): T {
  // 伪 ledger 项（审计问题被误当成伏笔回灌）即使带章节窗口也强制降级，
  // 永不允许进 overdue —— 否则触发 PIPELINE_REPLAN_REQUIRED 形成自我放大环。
  if (isAuditArtifactLedgerKey(item.ledgerKey) && item.currentStatus === "overdue") {
    return {
      ...item,
      currentStatus: "pending_payoff",
      riskSignals: dedupeRiskSignals([
        ...item.riskSignals.filter((signal) => signal.code !== "payoff_missing_progress"),
        {
          code: "pseudo_ledger_demoted",
          severity: "low",
          summary: "该账本项疑似由审计问题回灌生成（非真实伏笔），已降级为待推进，不再触发逾期重规划。",
        },
      ]),
    };
  }
  if (item.currentStatus !== "overdue") {
    return item;
  }
  // 窗口未过却标 overdue —— 逻辑自相矛盾。overdue 的定义是"已过 targetEnd 仍未兑现"，
  // 若 targetEnd ≥ 当前章，说明目标窗口尚未结束，标逾期不成立。这类多半是 LLM 把剧情
  // 内的紧迫感（倒计时、危机、处境恶化）误当成账本逾期。降级为 pending_payoff，避免
  // 未到窗口末尾就触发 PIPELINE_REPLAN_REQUIRED。窗口过后（targetEnd < 当前章）仍未
  // 兑现，才允许自然进入 overdue。
  if (isPrematureOverduePayoff(item, chapterOrder)) {
    return {
      ...item,
      currentStatus: "pending_payoff",
      riskSignals: dedupeRiskSignals([
        ...item.riskSignals,
        {
          code: "payoff_premature_overdue_demoted",
          severity: "low",
          summary: `目标窗口（至第${item.targetEndChapterOrder}章）尚未结束，当前第${chapterOrder}章标记逾期不成立，已降级为待推进。`,
        },
      ]),
    };
  }
  if (hasExplicitPayoffWindow(item)) {
    return item;
  }
  return {
    ...item,
    currentStatus: "pending_payoff",
    riskSignals: dedupeRiskSignals([
      ...item.riskSignals,
      {
        code: "payoff_missing_progress",
        severity: "medium",
        summary: item.statusReason?.trim()
          || "AI 对账认为该伏笔已逾期，但缺少明确目标窗口，已按待推进风险继续跟踪。",
      },
    ]),
  };
}

const PAYOFF_WINDOW_EXTENSION_STEP = 10;
const PAYOFF_WINDOW_EXTENSION_MAX = 3;
const PAYOFF_WINDOW_EXTENDED_SIGNAL_CODE = "payoff_window_extended";

function countWindowExtensions(signals: PayoffLedgerRiskSignal[]): number {
  return signals.filter((signal) => signal.code === PAYOFF_WINDOW_EXTENDED_SIGNAL_CODE).length;
}

/**
 * 对"有明确窗口但 targetEnd 已过当前章仍未兑现"的 pending_payoff 项自动顺延目标窗口，
 * 避免被 LLM 在下次对账标 overdue 累积、触发强制 replan。
 * 顺延上限 PAYOFF_WINDOW_EXTENSION_MAX 次，超限则不再顺延（让其自然 overdue）。
 * 顺延次数通过 riskSignals 里 payoff_window_extended 信号计数体现，不改表结构。
 */
export function applyGraceExtension<T extends PayoffLedgerSyncCandidate>(
  item: T,
  chapterOrder: number | null | undefined,
): T {
  if (item.currentStatus !== "pending_payoff") {
    return item;
  }
  if (typeof chapterOrder !== "number" || !Number.isFinite(chapterOrder)) {
    return item;
  }
  const targetEnd = item.targetEndChapterOrder;
  if (typeof targetEnd !== "number" || targetEnd >= chapterOrder) {
    return item;
  }
  if (countWindowExtensions(item.riskSignals) >= PAYOFF_WINDOW_EXTENSION_MAX) {
    return item;
  }
  const hasTargetStart = typeof item.targetStartChapterOrder === "number";
  const nextStart = hasTargetStart
    ? item.targetStartChapterOrder! + PAYOFF_WINDOW_EXTENSION_STEP
    : targetEnd;
  const nextEnd = targetEnd + PAYOFF_WINDOW_EXTENSION_STEP;
  return {
    ...item,
    targetStartChapterOrder: nextStart,
    targetEndChapterOrder: nextEnd,
    riskSignals: dedupeRiskSignals([
      ...item.riskSignals,
      {
        code: PAYOFF_WINDOW_EXTENDED_SIGNAL_CODE,
        severity: "medium",
        summary: `目标窗口已过未兑现，自动顺延至第${nextStart}-${nextEnd}章。`,
      },
    ]),
  };
}

export function mapPayoffLedgerRow(row: PayoffLedgerRowLike): PayoffLedgerItem {
  return {
    id: row.id,
    novelId: row.novelId,
    ledgerKey: row.ledgerKey,
    title: row.title,
    summary: row.summary,
    scopeType: row.scopeType,
    currentStatus: row.currentStatus,
    targetStartChapterOrder: row.targetStartChapterOrder,
    targetEndChapterOrder: row.targetEndChapterOrder,
    firstSeenChapterOrder: row.firstSeenChapterOrder,
    lastTouchedChapterOrder: row.lastTouchedChapterOrder,
    lastTouchedChapterId: row.lastTouchedChapterId,
    setupChapterId: row.setupChapterId,
    payoffChapterId: row.payoffChapterId,
    lastSnapshotId: row.lastSnapshotId,
    sourceRefs: safeParseJson<PayoffLedgerSourceRef[]>(row.sourceRefsJson, []),
    evidence: safeParseJson(row.evidenceJson, []),
    riskSignals: safeParseJson<PayoffLedgerRiskSignal[]>(row.riskSignalsJson, []),
    statusReason: row.statusReason,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isPendingLike(status: PayoffLedgerStatus): boolean {
  return status === "setup" || status === "hinted" || status === "pending_payoff";
}

function isUrgent(item: PayoffLedgerItem, chapterOrder?: number | null): boolean {
  if (!chapterOrder || !isPendingLike(item.currentStatus)) {
    return false;
  }
  if (typeof item.targetEndChapterOrder === "number" && item.targetEndChapterOrder <= chapterOrder + 1) {
    return true;
  }
  if (typeof item.targetStartChapterOrder === "number" && item.targetStartChapterOrder <= chapterOrder) {
    return true;
  }
  return false;
}

export function classifyPayoffLedgerItems(
  items: PayoffLedgerItem[],
  chapterOrder?: number | null,
): {
  pendingItems: PayoffLedgerItem[];
  urgentItems: PayoffLedgerItem[];
  overdueItems: PayoffLedgerItem[];
  paidOffItems: PayoffLedgerItem[];
} {
  // premature overdue（窗口未过却标 overdue）不计入 overdueItems：它会同时污染
  // summary.overdueCount（给 planner 的文字摘要）和 buildSyntheticPayoffIssues 产出的
  // payoff_overdue 合成审计问题——后者会流回审计→ledger sync，是伪账本反馈环的同类风险。
  // 与 CanonicalStateService overduePayoffs 过滤共用 isPrematureOverduePayoff 判据。
  const overdueItems = items.filter(
    (item) => item.currentStatus === "overdue" && !isPrematureOverduePayoff(item, chapterOrder),
  );
  const pendingItems = items.filter((item) => isPendingLike(item.currentStatus));
  const urgentItems = pendingItems.filter((item) => isUrgent(item, chapterOrder));
  const paidOffItems = items.filter((item) => item.currentStatus === "paid_off");
  return {
    pendingItems,
    urgentItems,
    overdueItems,
    paidOffItems,
  };
}

export function buildPayoffLedgerSummary(
  items: PayoffLedgerItem[],
  chapterOrder?: number | null,
): PayoffLedgerSummary {
  const classified = classifyPayoffLedgerItems(items, chapterOrder);
  return {
    totalCount: items.length,
    pendingCount: classified.pendingItems.length,
    urgentCount: classified.urgentItems.length,
    overdueCount: classified.overdueItems.length,
    paidOffCount: classified.paidOffItems.length,
    // source_superseded 退役项不计入叙事/质量 failedCount
    failedCount: items.filter((item) => (
      item.currentStatus === "failed" && !isSourceSupersededFailedItem(item)
    )).length,
    setupCount: items.filter((item) => item.currentStatus === "setup").length,
    hintedCount: items.filter((item) => item.currentStatus === "hinted").length,
    pendingPayoffCount: items.filter((item) => item.currentStatus === "pending_payoff").length,
    updatedAt: items[0]?.updatedAt ?? null,
  };
}

export function buildPayoffLedgerResponse(
  items: PayoffLedgerItem[],
  chapterOrder?: number | null,
): PayoffLedgerResponse {
  const orderedItems = items.slice().sort((left, right) => {
    const leftPriority = left.currentStatus === "overdue" ? 0 : left.currentStatus === "pending_payoff" ? 1 : left.currentStatus === "hinted" ? 2 : left.currentStatus === "setup" ? 3 : left.currentStatus === "paid_off" ? 4 : 5;
    const rightPriority = right.currentStatus === "overdue" ? 0 : right.currentStatus === "pending_payoff" ? 1 : right.currentStatus === "hinted" ? 2 : right.currentStatus === "setup" ? 3 : right.currentStatus === "paid_off" ? 4 : 5;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    const leftOrder = left.targetEndChapterOrder ?? left.lastTouchedChapterOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.targetEndChapterOrder ?? right.lastTouchedChapterOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.title.localeCompare(right.title, "zh-Hans-CN");
  });
  return {
    summary: buildPayoffLedgerSummary(orderedItems, chapterOrder),
    items: orderedItems,
    updatedAt: orderedItems[0]?.updatedAt ?? null,
  };
}

export function buildSyntheticPayoffIssues(
  items: PayoffLedgerItem[],
  chapterOrder?: number | null,
): SyntheticPayoffIssue[] {
  const issues: SyntheticPayoffIssue[] = [];
  // 伪 ledger 项（审计问题被 LLM 误当成伏笔回灌生成，ledgerKey 形如
  // chapterN_missing_progress）整体排除：它们不是真实伏笔，再产出审计问题会与
  // ledger sync 形成"审计问题⇄ledger 项"自我放大环，最终触发 PIPELINE_REPLAN_REQUIRED。
  const realItems = items.filter((item) => !isAuditArtifactLedgerKey(item.ledgerKey));
  const classified = classifyPayoffLedgerItems(realItems, chapterOrder);

  for (const item of classified.overdueItems) {
    issues.push({
      ledgerKey: item.ledgerKey,
      code: "payoff_overdue",
      severity: "high",
      description: `伏笔“${item.title}”已经超过目标窗口仍未兑现。`,
      evidence: item.statusReason?.trim()
        || item.evidence[0]?.summary
        || `目标窗口截止第${item.targetEndChapterOrder ?? "?"}章，当前仍处于未兑现状态。`,
      fixSuggestion: "在当前章节或接下来的重规划中明确安排兑现，或解释为什么必须延后。",
    });
  }

  for (const item of classified.pendingItems) {
    if (chapterOrder && isUrgent(item, chapterOrder) && item.currentStatus !== "overdue") {
      issues.push({
        ledgerKey: item.ledgerKey,
        code: "payoff_missing_progress",
        severity: "medium",
        description: `伏笔“${item.title}”已经进入应触碰窗口，但当前仍缺少明确推进。`,
        evidence: item.statusReason?.trim()
          || item.evidence[0]?.summary
          || `目标窗口 ${item.targetStartChapterOrder ?? "?"}-${item.targetEndChapterOrder ?? "?"}。`,
        fixSuggestion: "在本章计划、正文或修复中补上推进动作，避免继续拖延。",
      });
    }
  }

  for (const item of realItems) {
    for (const signal of item.riskSignals) {
      if (
        signal.code !== "payoff_paid_without_setup"
        && signal.code !== "payoff_regressed"
        && signal.code !== "payoff_missing_progress"
      ) {
        continue;
      }
      issues.push({
        ledgerKey: item.ledgerKey,
        code: signal.code,
        severity: signal.severity,
        description: `伏笔“${item.title}”存在专项风险：${signal.summary}`,
        evidence: item.evidence[0]?.summary || item.summary,
        fixSuggestion: signal.code === "payoff_paid_without_setup"
          ? "补足前置铺垫，或将当前章节的兑现强度降回铺垫/推进态。"
          : signal.code === "payoff_regressed"
            ? "检查是否误把已兑现伏笔重新打开；如属新线索，请改成新的账本项。"
            : "为该伏笔补上明确推进动作，避免账本继续停滞。",
      });
    }
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.ledgerKey}:${issue.code}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
