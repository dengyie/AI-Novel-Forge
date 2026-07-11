export type PayoffLedgerScopeType = "book" | "volume" | "chapter";

export type PayoffLedgerStatus = "setup" | "hinted" | "pending_payoff" | "paid_off" | "failed" | "overdue";

export interface PayoffLedgerSourceRef {
  kind: "major_payoff" | "volume_open_payoff" | "chapter_payoff_ref" | "foreshadow_state" | "open_conflict" | "audit_issue";
  refId?: string | null;
  refLabel: string;
  chapterId?: string | null;
  chapterOrder?: number | null;
  volumeId?: string | null;
  volumeSortOrder?: number | null;
}

export interface PayoffLedgerEvidence {
  summary: string;
  chapterId?: string | null;
  chapterOrder?: number | null;
}

export interface PayoffLedgerRiskSignal {
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  stale?: boolean;
}

export interface PayoffLedgerItem {
  id: string;
  novelId: string;
  ledgerKey: string;
  title: string;
  summary: string;
  scopeType: PayoffLedgerScopeType;
  currentStatus: PayoffLedgerStatus;
  targetStartChapterOrder?: number | null;
  targetEndChapterOrder?: number | null;
  firstSeenChapterOrder?: number | null;
  lastTouchedChapterOrder?: number | null;
  lastTouchedChapterId?: string | null;
  setupChapterId?: string | null;
  payoffChapterId?: string | null;
  lastSnapshotId?: string | null;
  sourceRefs: PayoffLedgerSourceRef[];
  evidence: PayoffLedgerEvidence[];
  riskSignals: PayoffLedgerRiskSignal[];
  statusReason?: string | null;
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayoffLedgerSummary {
  totalCount: number;
  /** setup + hinted + pending_payoff 合计（未终态待兑现） */
  pendingCount: number;
  urgentCount: number;
  overdueCount: number;
  paidOffCount: number;
  failedCount: number;
  /** hinted→paid 生命周期分层（P2-3 可视化；旧快照可缺省） */
  setupCount?: number;
  hintedCount?: number;
  pendingPayoffCount?: number;
  updatedAt?: string | null;
}

/** 单条账本的 hinted→paid 生命周期节点，供 UI 时间线渲染。 */
export type PayoffLifecycleStage =
  | "setup"
  | "hinted"
  | "pending_payoff"
  | "paid_off"
  | "failed"
  | "overdue";

export interface PayoffLifecycleNode {
  stage: PayoffLifecycleStage;
  labelZh: string;
  reached: boolean;
  current: boolean;
}

const LIFECYCLE_ORDER: PayoffLifecycleStage[] = [
  "setup",
  "hinted",
  "pending_payoff",
  "paid_off",
];

const LIFECYCLE_LABELS: Record<PayoffLifecycleStage, string> = {
  setup: "埋设",
  hinted: "提示",
  pending_payoff: "待兑现",
  paid_off: "已兑现",
  failed: "已失效",
  overdue: "已逾期",
};

/**
 * 从 currentStatus 推导 setup→hinted→pending→paid 进度条。
 * overdue/failed 为旁路终态：进度条标到 pending 为止并附加旁路节点。
 */
export function buildPayoffLifecycleNodes(
  currentStatus: PayoffLedgerStatus | string | null | undefined,
): PayoffLifecycleNode[] {
  const status = (currentStatus ?? "setup") as PayoffLifecycleStage;
  if (status === "failed") {
    return [
      ...LIFECYCLE_ORDER.slice(0, 3).map((stage) => ({
        stage,
        labelZh: LIFECYCLE_LABELS[stage],
        reached: true,
        current: false,
      })),
      {
        stage: "failed",
        labelZh: LIFECYCLE_LABELS.failed,
        reached: true,
        current: true,
      },
    ];
  }
  if (status === "overdue") {
    // 旁路终态：进度标到 pending 为止；仅 overdue 为 current（与 failed 对称，避免双高亮）。
    return [
      ...LIFECYCLE_ORDER.slice(0, 3).map((stage) => ({
        stage,
        labelZh: LIFECYCLE_LABELS[stage],
        reached: true,
        current: false,
      })),
      {
        stage: "overdue",
        labelZh: LIFECYCLE_LABELS.overdue,
        reached: true,
        current: true,
      },
    ];
  }
  const currentIndex = LIFECYCLE_ORDER.indexOf(status as typeof LIFECYCLE_ORDER[number]);
  const activeIndex = currentIndex >= 0 ? currentIndex : 0;
  return LIFECYCLE_ORDER.map((stage, index) => ({
    stage,
    labelZh: LIFECYCLE_LABELS[stage],
    reached: index <= activeIndex,
    current: index === activeIndex,
  }));
}

export interface PayoffLedgerResponse {
  summary: PayoffLedgerSummary;
  items: PayoffLedgerItem[];
  updatedAt?: string | null;
}
