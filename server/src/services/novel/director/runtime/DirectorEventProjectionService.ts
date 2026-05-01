import type {
  DirectorArtifactType,
  DirectorAutopilotRecoveryDecision,
  DirectorEvent,
  DirectorNextAction,
  DirectorRuntimeProgressBreakdown,
  DirectorRuntimeProjection,
  DirectorRuntimeProjectionStatus,
  DirectorRuntimeSnapshot,
  DirectorRuntimeVisibleRiskBadge,
  DirectorStepRun,
  DirectorWorkspaceInventory,
} from "@ai-novel/shared/types/directorRuntime";

function timestampOf(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestStep(steps: DirectorStepRun[]): DirectorStepRun | null {
  return steps.reduce<DirectorStepRun | null>((latest, step) => {
    if (!latest) {
      return step;
    }
    const stepTime = Math.max(timestampOf(step.finishedAt), timestampOf(step.startedAt));
    const latestTime = Math.max(timestampOf(latest.finishedAt), timestampOf(latest.startedAt));
    return stepTime >= latestTime ? step : latest;
  }, null);
}

function latestEvent(events: DirectorEvent[]): DirectorEvent | null {
  return events.reduce<DirectorEvent | null>((latest, event) => {
    if (!latest) {
      return event;
    }
    return timestampOf(event.occurredAt) >= timestampOf(latest.occurredAt) ? event : latest;
  }, null);
}

function statusFromStep(step: DirectorStepRun | null): DirectorRuntimeProjectionStatus {
  if (!step) {
    return "idle";
  }
  if (step.status === "waiting_approval") {
    return "waiting_approval";
  }
  if (step.status === "blocked_scope") {
    return "blocked";
  }
  if (step.status === "failed") {
    return "failed";
  }
  if (step.status === "running") {
    return "running";
  }
  return "completed";
}

function resolveBlockedReason(step: DirectorStepRun | null, event: DirectorEvent | null): string | null {
  if (!step) {
    return null;
  }
  if (step.status === "waiting_approval" || step.status === "blocked_scope") {
    return step.policyDecision?.reason ?? event?.summary ?? step.error ?? null;
  }
  if (step.status === "failed") {
    return step.error ?? event?.summary ?? null;
  }
  return null;
}

function formatNextAction(action: DirectorNextAction | null | undefined): string | null {
  if (!action) {
    return null;
  }
  const labels: Record<DirectorNextAction["action"], string> = {
    generate_candidates: "生成可选开书方向",
    create_book_contract: "生成书级创作约定",
    complete_story_macro: "完善故事宏观规划",
    prepare_characters: "准备角色阵容",
    build_volume_strategy: "生成分卷策略",
    build_chapter_tasks: "生成章节任务单",
    continue_chapter_execution: "继续章节生成",
    review_recent_chapters: "复查最近章节",
    repair_scope: "修复受影响范围",
    ask_user_confirmation: "请确认后继续",
  };
  return labels[action.action];
}

function buildHeadline(input: {
  status: DirectorRuntimeProjectionStatus;
  step: DirectorStepRun | null;
  event: DirectorEvent | null;
}): string {
  const label = input.step?.label?.trim() || input.event?.summary?.trim() || "同步导演进度";
  if (input.status === "waiting_approval") {
    return `等待确认：${label}`;
  }
  if (input.status === "blocked") {
    return `暂停处理：${label}`;
  }
  if (input.status === "failed") {
    return `处理失败：${label}`;
  }
  if (input.status === "running") {
    return `推进任务：${label}`;
  }
  if (input.status === "completed") {
    return `步骤完成：${label}`;
  }
  return label;
}

function buildDetail(input: {
  status: DirectorRuntimeProjectionStatus;
  step: DirectorStepRun | null;
  event: DirectorEvent | null;
  blockedReason: string | null;
}): string | null {
  if (input.status === "running") {
    const eventSummary = input.event?.summary?.trim();
    return eventSummary ? `最近进展：${eventSummary}` : "系统正在处理这一步，完成后会写入新的进展。";
  }
  if (input.status === "waiting_approval" || input.status === "blocked" || input.status === "failed") {
    return input.blockedReason;
  }
  if (input.status === "completed") {
    return input.event?.summary?.trim() ?? null;
  }
  return null;
}

function buildScopeSummary(inventory: DirectorWorkspaceInventory | null | undefined): string | null {
  if (!inventory) {
    return null;
  }
  const parts = [
    `${inventory.chapterCount} 章`,
    `${inventory.draftedChapterCount} 章有正文`,
  ];
  if (inventory.pendingRepairChapterCount > 0) {
    parts.push(`${inventory.pendingRepairChapterCount} 章待修复`);
  }
  if (inventory.missingArtifactTypes.length > 0) {
    parts.push(`${inventory.missingArtifactTypes.length} 类产物待补齐`);
  }
  return `工作区：${parts.join("，")}。`;
}

function buildProgressSummary(snapshot: DirectorRuntimeSnapshot, inventory: DirectorWorkspaceInventory | null | undefined): string {
  const completedSteps = snapshot.steps.filter((step) => step.status === "succeeded").length;
  const waitingSteps = snapshot.steps.filter((step) => step.status === "waiting_approval" || step.status === "blocked_scope").length;
  const failedSteps = snapshot.steps.filter((step) => step.status === "failed").length;
  const protectedCount = inventory?.protectedUserContentArtifacts.length
    ?? snapshot.artifacts.filter((artifact) => artifact.protectedUserContent === true || artifact.source === "user_edited").length;
  const staleCount = inventory?.staleArtifacts.length
    ?? snapshot.artifacts.filter((artifact) => artifact.status === "stale").length;
  const repairCount = inventory?.needsRepairArtifacts.length
    ?? snapshot.artifacts.filter((artifact) => artifact.artifactType === "repair_ticket" && artifact.status !== "rejected").length;
  const parts = [
    `${completedSteps}/${snapshot.steps.length} 个步骤完成`,
    `${snapshot.artifacts.length} 个产物记录`,
  ];
  if (waitingSteps > 0) {
    parts.push(`${waitingSteps} 个步骤待确认`);
  }
  if (failedSteps > 0) {
    parts.push(`${failedSteps} 个步骤失败`);
  }
  if (protectedCount > 0) {
    parts.push(`${protectedCount} 个用户内容受保护`);
  }
  if (staleCount > 0) {
    parts.push(`${staleCount} 个产物需确认`);
  }
  if (repairCount > 0) {
    parts.push(`${repairCount} 个修复任务`);
  }
  return `进展：${parts.join("，")}。`;
}

const PLANNING_ARTIFACT_TYPES: DirectorArtifactType[] = [
  "book_contract",
  "story_macro",
  "character_cast",
  "volume_strategy",
  "chapter_task_sheet",
];

const PLANNING_NODE_HINTS = [
  "book_contract",
  "story_macro",
  "character",
  "volume_strategy",
  "chapter_task",
  "structured",
];

const CHAPTER_EXECUTION_NODE_HINTS = [
  "chapter_execution",
  "chapter.write",
  "chapter_draft",
];

const QUALITY_NODE_HINTS = [
  "quality",
  "review",
  "repair",
  "state_commit",
];

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentFromCount(done: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return clampPercent((done / total) * 100);
}

function stepMatches(step: DirectorStepRun, hints: string[]): boolean {
  const nodeKey = step.nodeKey.toLowerCase();
  return hints.some((hint) => nodeKey.includes(hint));
}

function stepProgressPercent(steps: DirectorStepRun[], hints: string[]): number {
  const matched = steps.filter((step) => stepMatches(step, hints));
  if (matched.length === 0) {
    return 0;
  }
  const completed = matched.filter((step) => step.status === "succeeded").length;
  const running = matched.some((step) => step.status === "running" || step.status === "waiting_approval")
    ? 0.5
    : 0;
  return percentFromCount(completed + running, matched.length);
}

function buildPlanningPercent(snapshot: DirectorRuntimeSnapshot, inventory: DirectorWorkspaceInventory | null | undefined): number {
  if (inventory) {
    const completed = [
      inventory.hasBookContract,
      inventory.hasStoryMacro,
      inventory.hasCharacters,
      inventory.hasVolumeStrategy,
      inventory.hasChapterPlan,
    ].filter(Boolean).length;
    return percentFromCount(completed, 5);
  }
  return stepProgressPercent(snapshot.steps, PLANNING_NODE_HINTS);
}

function buildChapterExecutionPercent(snapshot: DirectorRuntimeSnapshot, inventory: DirectorWorkspaceInventory | null | undefined): number {
  if (inventory?.chapterCount) {
    return percentFromCount(inventory.draftedChapterCount, inventory.chapterCount);
  }
  return stepProgressPercent(snapshot.steps, CHAPTER_EXECUTION_NODE_HINTS);
}

function buildQualityRepairPercent(snapshot: DirectorRuntimeSnapshot, inventory: DirectorWorkspaceInventory | null | undefined): number {
  if (inventory) {
    if (inventory.draftedChapterCount <= 0) {
      return 0;
    }
    return percentFromCount(
      Math.max(0, inventory.draftedChapterCount - inventory.pendingRepairChapterCount),
      inventory.draftedChapterCount,
    );
  }
  const percent = stepProgressPercent(snapshot.steps, QUALITY_NODE_HINTS);
  return percent > 0 ? percent : 100;
}

function buildProgressBreakdown(
  snapshot: DirectorRuntimeSnapshot,
  inventory: DirectorWorkspaceInventory | null | undefined,
): DirectorRuntimeProgressBreakdown {
  const completedSteps = snapshot.steps.filter((step) => step.status === "succeeded").length;
  const planningPercent = buildPlanningPercent(snapshot, inventory);
  const chapterExecutionPercent = buildChapterExecutionPercent(snapshot, inventory);
  const qualityRepairPercent = buildQualityRepairPercent(snapshot, inventory);
  const totalPercent = clampPercent(
    planningPercent * 0.35
    + chapterExecutionPercent * 0.5
    + qualityRepairPercent * 0.15,
  );
  const draftedChapters = inventory?.draftedChapterCount ?? 0;
  const totalChapters = inventory?.chapterCount ?? 0;
  const pendingRepairChapters = inventory?.pendingRepairChapterCount ?? 0;
  return {
    planningPercent,
    chapterExecutionPercent,
    qualityRepairPercent,
    totalPercent,
    completedSteps,
    totalSteps: snapshot.steps.length,
    draftedChapters,
    totalChapters,
    pendingRepairChapters,
    explanation: `规划完成度 ${planningPercent}%，章节执行完成度 ${chapterExecutionPercent}%，质量修复完成度 ${qualityRepairPercent}%，综合进度 ${totalPercent}%。`,
  };
}

function buildRecoveryDecision(input: {
  status: DirectorRuntimeProjectionStatus;
  inventory: DirectorWorkspaceInventory | null | undefined;
  blockedReason: string | null;
}): DirectorAutopilotRecoveryDecision {
  const protectedCount = input.inventory?.protectedUserContentArtifacts.length ?? 0;
  if (protectedCount > 0 && (input.status === "waiting_approval" || input.status === "blocked" || input.status === "failed")) {
    return "requires_manual_recovery";
  }
  if (input.status === "failed") {
    return "requires_manual_recovery";
  }
  if ((input.inventory?.pendingRepairChapterCount ?? 0) > 0) {
    return "auto_repair_chapter";
  }
  const missingArtifacts = input.inventory?.missingArtifactTypes ?? [];
  if (missingArtifacts.some((type) => PLANNING_ARTIFACT_TYPES.includes(type))) {
    return "auto_replan_window";
  }
  if (input.status === "waiting_approval" || input.status === "blocked") {
    return input.blockedReason ? "auto_resume_from_checkpoint" : "continue";
  }
  return "continue";
}

function isAutomaticPolicy(snapshot: DirectorRuntimeSnapshot): boolean {
  return snapshot.policy.mode === "auto_safe_scope";
}

function buildVisibleRiskBadges(input: {
  status: DirectorRuntimeProjectionStatus;
  blockedReason: string | null;
  inventory: DirectorWorkspaceInventory | null | undefined;
  events: DirectorEvent[];
}): DirectorRuntimeVisibleRiskBadge[] {
  const badges: DirectorRuntimeVisibleRiskBadge[] = [];
  const push = (badge: DirectorRuntimeVisibleRiskBadge) => {
    if (!badges.some((item) => item.label === badge.label)) {
      badges.push(badge);
    }
  };
  if (input.status === "failed") {
    push({ label: "执行失败", level: "danger", source: "status" });
  } else if (input.status === "blocked" || input.status === "waiting_approval") {
    push({ label: input.blockedReason ? "等待处理" : "等待确认", level: "warning", source: "status" });
  }
  const inventory = input.inventory;
  if (inventory) {
    if (inventory.protectedUserContentArtifacts.length > 0) {
      push({ label: "受保护正文", level: "danger", source: "artifact" });
    }
    if (inventory.pendingRepairChapterCount > 0) {
      push({ label: `${inventory.pendingRepairChapterCount} 章待修复`, level: "warning", source: "artifact" });
    }
    if (inventory.staleArtifacts.length > 0) {
      push({ label: `${inventory.staleArtifacts.length} 项需复核`, level: "warning", source: "artifact" });
    }
    if (inventory.missingArtifactTypes.length > 0) {
      push({ label: "缺少规划资源", level: "warning", source: "artifact" });
    }
  }
  for (const event of input.events) {
    if (event.type === "quality_issue_found" || event.type === "quality_loop_assessed") {
      push({ label: "质量风险", level: event.severity === "high" ? "danger" : "warning", source: "event" });
    }
    if (event.type === "replan_run_created") {
      push({ label: "已进入重规划", level: "info", source: "event" });
    }
    if (event.type === "circuit_breaker_opened") {
      push({ label: "连续失败保护", level: "danger", source: "event" });
    }
  }
  return badges.slice(0, 6);
}

export class DirectorEventProjectionService {
  buildSnapshotProjection(snapshot: DirectorRuntimeSnapshot | null): DirectorRuntimeProjection | null {
    if (!snapshot) {
      return null;
    }
    const step = latestStep(snapshot.steps);
    const event = latestEvent(snapshot.events);
    const status = statusFromStep(step);
    const requiresUserAction = status === "waiting_approval" || status === "blocked";
    const blockedReason = resolveBlockedReason(step, event);
    const inventory = snapshot.lastWorkspaceAnalysis?.inventory ?? null;
    const recommendation = snapshot.lastWorkspaceAnalysis?.recommendation
      ?? snapshot.lastWorkspaceAnalysis?.interpretation?.recommendedAction
      ?? null;
    const headline = buildHeadline({ status, step, event });
    const progressBreakdown = buildProgressBreakdown(snapshot, inventory);
    const recoveryDecision = buildRecoveryDecision({ status, inventory, blockedReason });
    const isAutopilotRecoverable = isAutomaticPolicy(snapshot)
      && recoveryDecision !== "requires_manual_recovery"
      && status !== "completed"
      && status !== "idle";
    const visibleRiskBadges = buildVisibleRiskBadges({
      status,
      blockedReason,
      inventory,
      events: snapshot.events,
    });
    const recentEvents = [...snapshot.events]
      .sort((left, right) => timestampOf(right.occurredAt) - timestampOf(left.occurredAt))
      .slice(0, 8)
      .map((item) => ({
        eventId: item.eventId,
        type: item.type,
        summary: item.summary,
        nodeKey: item.nodeKey,
        artifactType: item.artifactType,
        severity: item.severity,
        occurredAt: item.occurredAt,
      }));

    return {
      runId: snapshot.runId,
      novelId: snapshot.novelId,
      status,
      currentNodeKey: step?.nodeKey ?? event?.nodeKey ?? null,
      currentLabel: step?.label ?? event?.summary ?? null,
      headline,
      detail: buildDetail({ status, step, event, blockedReason }),
      lastEventSummary: event?.summary ?? null,
      requiresUserAction,
      blockedReason,
      blockingReason: blockedReason,
      nextActionLabel: formatNextAction(recommendation),
      recommendedAction: recommendation,
      recoveryDecision,
      isAutopilotRecoverable,
      scopeSummary: buildScopeSummary(inventory),
      progressSummary: buildProgressSummary(snapshot, inventory),
      progressBreakdown,
      visibleRiskBadges,
      policyMode: snapshot.policy.mode,
      updatedAt: snapshot.updatedAt,
      recentEvents,
    };
  }
}
