/**
 * OpsRun 运行面（§3.0, §12-C,D,E）。
 *
 *职责：
 * - 生命周期：queued → running → succeeded|failed|cancelled
 * - 幂等短窗：同 inputFingerprint 60s 内返回已有 run（§E）
 * - 取消：cancelRequestedAt + AbortController；Agent 内检查 signal.aborted
 * - 编排：按 profile 调度 Agent/stub（阶段 1 dry-run 只列计划不改库）
 *
 * 进程内 approve 门禁 §D：EarAgent 升权前 self-call assertOpsApproveAllowed()。
 * 真实 setStatus 门禁（sha/license/heardAt）在 voiceLibraryService.setStatus 内已内建。
 */
import { AppError } from "../../../middleware/errorHandler";
import type {
  OpsRunInput,
  OpsRunProfile,
  OpsRunCreateResponse,
  OpsRunListEntry,
  OpsRunReport,
  OpsRunStatus,
  OpsRunStepName,
  OpsRunStepSummary,
  OpsRunSummary,
  OpsOverrideInput,
} from "@ai-novel/shared/types/audiobookOps";
import {
  appendRunLog,
  computeInputFingerprint,
  ensureRunDir,
  listRunStates,
  newRunId,
  readReport,
  readRunState,
  writeReport,
  writeRunState,
  type StoredRunState,
} from "./OpsRunStorage";
import {
  createReportBuilder,
  finalizeReport,
  type OpsReportBuilder,
} from "./OpsReport";
import { earAgent } from "./agents/EarAgent";
import { readyAgent } from "./agents/ReadyAgent";
import { patrolAgent } from "./agents/PatrolAgent";
import { voiceLibraryService } from "../voiceLibraryService";

const IDEMPOTENCY_WINDOW_MS = 60_000;
const STALE_RUN_MS_DEFAULT = 30 * 60_000;

interface OpsRunContext {
  runId: string;
  profile: OpsRunProfile;
  input: OpsRunInput;
  signal: AbortSignal;
  report: OpsReportBuilder;
  updateState: (patch: Partial<StoredRunState>) => void;
  log: (line: string) => void;
}

const STEP_ORDER: OpsRunStepName[] = ["import", "label", "ear", "approve", "ready", "synth", "patrol", "matrix"];

function stepsForProfile(profile: OpsRunProfile): OpsRunStepName[] {
  if (profile === "library_only") return ["import", "ear", "approve"];
  if (profile === "patrol_only") return ["patrol"];
  if (profile === "ear_auto") return ["ear", "approve"];
  if (profile === "library_ai_fill") return ["import", "label", "ear", "approve", "matrix"];
  return ["import", "ear", "approve", "ready", "patrol"];
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialStepsSummary(steps: OpsRunStepName[]): OpsRunStepSummary[] {
  return steps.map((step) => ({
    step,
    status: "pending" as const,
    durationMs: null,
    counts: null,
    message: null,
  }));
}

export class OpsRunService {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly flagOverrides = new Map<string, { forceKeepDraft: Set<string>; forceReject: Set<string> }>();
  private reapedAtStartup = false;

  constructor() {
    // 惰性启动回收：单例首次构造（import 时）扫一次 stale running。
    // 非 fatal：扫失败（无 storage 根、权限）不影响服务起。
    if (!this.reapedAtStartup) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const storage = require("./OpsRunStorage") as typeof import("./OpsRunStorage");
        storage.reapStaleRuns(STALE_RUN_MS_DEFAULT);
        this.reapedAtStartup = true;
      } catch {
        /* ignore */
      }
    }
  }

  /** 创建 run；幂等短窗命中返回 duplicateOfRunId（不另开）。 */
  createRun(input: OpsRunInput): OpsRunCreateResponse {
    const profile = normalizeProfile(input.profile);
    const normalizedInput: OpsRunInput = {
      profile,
      novelId: input.novelId ?? null,
      packRoots: input.packRoots ?? null,
      assetIds: input.assetIds ?? null,
      autoFix: input.autoFix === true,
      dryRun: input.dryRun === true,
    };
    const fingerprint = computeInputFingerprint(normalizedInput);

    const dup = this.findRecentRunning(fingerprint);
    if (dup) {
      return { runId: dup.id, status: dup.status, duplicateOfRunId: dup.id };
    }

    const runId = newRunId();
    ensureRunDir(runId);
    const steps = stepsForProfile(profile);
    const state: StoredRunState = {
      id: runId,
      profile,
      input: normalizedInput,
      inputFingerprint: fingerprint,
      status: "queued",
      startedAt: nowIso(),
      finishedAt: null,
      cancelRequestedAt: null,
      currentStep: null,
      stepsSummary: initialStepsSummary(steps),
      reportPath: `storage/audiobook-ops/${runId}/report.json`,
      error: null,
    };
    writeRunState(state);

    // 异步启动（不 await）；调用方通过 status 查询
    void this.startRun(state);

    return { runId, status: state.status };
  }

  private findRecentRunning(fingerprint: string): StoredRunState | null {
    const all = listRunStates(200);
    const nowMs = Date.now();
    for (const state of all) {
      if (state.inputFingerprint !== fingerprint) continue;
      if (state.status !== "running" && state.status !== "queued") continue;
      const started = Date.parse(state.startedAt);
      if (Number.isFinite(started) && nowMs - started < IDEMPOTENCY_WINDOW_MS) {
        return state;
      }
    }
    return null;
  }

  private async startRun(state: StoredRunState): Promise<void> {
    const abort = new AbortController();
    this.activeRuns.set(state.id, abort);
    const ctx = this.buildContext(state, abort.signal);
    try {
      await this.runToCompletion(ctx, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failRun(state.id, message, ctx);
    } finally {
      this.activeRuns.delete(state.id);
    }
  }

  private buildContext(state: StoredRunState, signal: AbortSignal): OpsRunContext {
    return {
      runId: state.id,
      profile: state.profile,
      input: state.input,
      signal,
      report: createReportBuilder({
        runId: state.id,
        profile: state.profile,
        startedAt: state.startedAt,
        dryRun: state.input.dryRun === true,
      }),
      updateState: (patch) => {
        const cur = readRunState(state.id);
        if (!cur) return;
        writeRunState({ ...cur, ...patch });
      },
      log: (line) => {
        appendRunLog(state.id, line);
      },
    };
  }

  private async runToCompletion(ctx: OpsRunContext, state: StoredRunState): Promise<void> {
    if (ctx.signal.aborted) {
      this.cancelRunInternal(state);
      return;
    }
    const report = ctx.report;
    report.startedAt = state.startedAt;

    state.status = "running";
    writeRunState(state);
    ctx.log(`start profile=${state.profile} dryRun=${report.dryRun}`);

    if (report.dryRun) {
      report.dryRunPlan = {
        packsToImport: (state.input.packRoots ?? []).filter(Boolean),
        draftsToAudit: (state.input.assetIds ?? []).filter(Boolean),
        charactersToPlan: null,
      };
    }

    const steps = stepsForProfile(state.profile);
    const summaries: OpsRunStepSummary[] = steps.map((step) => ({
      step,
      status: "pending" as const,
      durationMs: null,
      counts: null,
      message: null,
    }));

    for (let i = 0; i < steps.length; i += 1) {
      if (ctx.signal.aborted) {
        summaries[i] = { step: steps[i]!, status: "skipped", durationMs: null, counts: null, message: "cancelled" };
        continue;
      }
      const stepName = steps[i]!;
      state.currentStep = stepName;
      summaries[i] = { step: stepName, status: "running", durationMs: null, counts: null, message: null };
      writeRunState({ ...state, currentStep: stepName });
      ctx.log(`step ${stepName} running`);

      const start = Date.now();
      try {
        const summary = await this.executeStep(stepName, ctx);
        const durationMs = Date.now() - start;
        summaries[i] = { ...summary, durationMs };
        ctx.log(`step ${stepName} ${summary.status} (${durationMs}ms)`);
      } catch (err) {
        const durationMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        summaries[i] = { step: stepName, status: "failed", durationMs, counts: null, message };
        ctx.log(`step ${stepName} failed: ${message}`);
        state.stepsSummary = summaries;
        state.error = { code: "step_failed", message: `${stepName}:${message}` };
        // 先持久化 in-mem 突变（stepsSummary + error），再让 failRun 读取并补完终态。
        // 否则 failRun 内部 readRunState 拿不到这两项突变 → 丢失失败步骤与原因。
        writeRunState(state);
        // cancel 与 step 抛错竞态：cancel 在先 → 标 cancelled 而非 failed。
        if (ctx.signal.aborted) {
          this.cancelRunInternal(state);
        } else {
          this.failRun(state.id, message, ctx);
        }
        return;
      }
    }

    state.stepsSummary = summaries;
    state.status = ctx.signal.aborted ? "cancelled" : "succeeded";
    state.finishedAt = nowIso();
    state.currentStep = null;

    report.finishedAt = state.finishedAt;
    const finalReport = finalizeReport(report);
    writeReport(state.id, finalReport);

    if (state.status === "succeeded") {
      const clean = isReportClean(finalReport);
      if (!clean) {
        // 巡检/audit 发现问题不影响 succeeded 状态，但记进 error 字段供运维快速识别
        state.error = { code: "issues_found", message: "ops run succeeded but reported findings/issues" };
      }
    }
    writeRunState(state);
  }

  private async executeStep(step: OpsRunStepName, ctx: OpsRunContext): Promise<OpsRunStepSummary> {
    if (ctx.report.dryRun) {
      return dryRunStepSummary(step, ctx);
    }
    switch (step) {
      case "import": {
        // seed pack 导入留作 backlog（§K）：阶段 1 不改库
        return { step, status: "skipped", durationMs: null, counts: null, message: "阶段 2：pack 导入留 backlog（§K）" };
      }
      case "label": {
        // LabelAgent：tags-only AI/规则重标
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { labelAgent } = require("./agents/LabelAgent") as typeof import("./agents/LabelAgent");
          const labelResult = labelAgent.run({ dryRun: false });
          ctx.log(`label changed=${labelResult.changed} skipped=${labelResult.skipped} lead=${labelResult.leadCount}`);
          return {
            step,
            status: "succeeded",
            durationMs: null,
            counts: {
              changed: labelResult.changed,
              skipped: labelResult.skipped,
              lead: labelResult.leadCount,
            },
            message: "label",
          };
        } catch (err) {
          ctx.log(`label skip: ${err instanceof Error ? err.message : String(err)}`);
          return {
            step,
            status: "skipped",
            durationMs: null,
            counts: { changed: 0 },
            message: "label unavailable",
          };
        }
      }
      case "matrix": {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { writeVoiceLibraryMatrixGapReport } = require("./matrixReport") as typeof import("./matrixReport");
          const { report: matrix, path: gapPath } = writeVoiceLibraryMatrixGapReport();
          ctx.log(`matrix gaps=${matrix.gaps.length} lead=${matrix.clusterCounts.lead ?? 0} file=${gapPath}`);
          return {
            step,
            status: "succeeded",
            durationMs: null,
            counts: {
              assets: matrix.totalAssets,
              speakers: matrix.speakerCount,
              gaps: matrix.gaps.length,
              lead: matrix.clusterCounts.lead ?? 0,
            },
            message: `matrix written ${gapPath}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log(`matrix fail: ${msg}`);
          return {
            step,
            status: "failed",
            durationMs: null,
            counts: { gaps: 0 },
            message: `matrix failed: ${msg}`,
          };
        }
      }
      case "ear": {
        const result = earAgent.run({
          assetIds: ctx.input.assetIds ?? null,
          skipApprove: false,
          // 默认 requireHardApprove（生产安全）；EAR_AUTO_SOFT_APPROVE=1 才 soft 升
          isForceKeepDraft: (id) => this.isForceKeepDraft(id),
          isForceReject: (id) => this.isForceReject(id),
        });
        ctx.report.ear = result.verdicts;
        ctx.report.approve.attempted += result.approve.attempted;
        ctx.report.approve.approved += result.approve.approved;
        ctx.report.approve.approvedHard = (ctx.report.approve.approvedHard ?? 0) + (result.approve.approvedHard ?? 0);
        ctx.report.approve.approvedSoft = (ctx.report.approve.approvedSoft ?? 0) + (result.approve.approvedSoft ?? 0);
        ctx.report.approve.rejected += result.approve.rejected;
        ctx.report.approve.skipped += result.approve.skipped;
        ctx.report.approve.gateBlocked += result.approve.gateBlocked;
        const softHeld = result.verdicts.filter((v) => v.decision === "approve_with_low_confidence").length;
        return {
          step,
          status: "succeeded",
          durationMs: null,
          counts: {
            verdicts: result.verdicts.length,
            approved: result.approve.approved,
            approvedHard: result.approve.approvedHard ?? 0,
            approvedSoft: result.approve.approvedSoft ?? 0,
            softHeld,
            rejected: result.approve.rejected,
            needs_human: result.verdicts.filter((v) => v.decision === "needs_human").length,
          },
          message: softHeld > 0
            ? `soft 未升权 ${softHeld}（EAR_AUTO_SOFT_APPROVE=1 可开）`
            : null,
        };
      }
      case "approve": {
        // ear 步已尝试升权；此步仅作 phase 标记，无需独立动作
        return { step, status: "succeeded", durationMs: null, counts: ctx.report.approve, message: null };
      }
      case "ready": {
        if (!ctx.input.novelId) {
          return { step, status: "skipped", durationMs: null, counts: null, message: "无 novelId：跳过 ReadyAgent" };
        }
        const report = await readyAgent.run({
          novelId: ctx.input.novelId,
          dryRun: false,
        });
        ctx.report.ready = {
          planned: report.planned,
          bound: report.bound,
          failed: report.failed,
          skipped: report.skipped,
        };
        return {
          step,
          status: report.failed > 0 ? "failed" : "succeeded",
          durationMs: null,
          counts: { planned: report.planned, bound: report.bound, failed: report.failed, skipped: report.skipped },
          message: report.failed > 0 ? `ReadyAgent ${report.failed} 个角色失败` : null,
        };
      }
      case "synth": {
        return { step, status: "skipped", durationMs: null, counts: null, message: "H 计划：synth 仅触发 task 元信息，非替 task 报告" };
      }
      case "patrol": {
        const patrolReport = await patrolAgent.run({
          novelId: ctx.input.novelId ?? null,
          taskId: null,
          autoFix: ctx.input.autoFix === true,
          dryRun: false,
        });
        ctx.report.patrol = patrolReport;
        return {
          step,
          status: "succeeded",
          durationMs: null,
          counts: {
            findings: patrolReport.findings.length,
            checkedTasks: patrolReport.checkedTasks,
            checkedChapters: patrolReport.checkedChapters,
          },
          message: patrolReport.clean ? "clean" : `${patrolReport.findings.length} findings`,
        };
      }
    }
  }

  cancel(runId: string): OpsRunSummary {
    const state = this.requireRun(runId);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") {
      return storedToSummary(state);
    }
    const abort = this.activeRuns.get(runId);
    state.cancelRequestedAt = nowIso();
    writeRunState(state);
    if (abort) {
      abort.abort();
    } else {
      state.status = "cancelled";
      state.finishedAt = nowIso();
      writeRunState(state);
    }
    return storedToSummary(state);
  }

  private cancelRunInternal(state: StoredRunState): void {
    state.status = "cancelled";
    state.finishedAt = nowIso();
    writeRunState(state);
  }

  private failRun(runId: string, message: string, ctx: OpsRunContext): void {
    const state = readRunState(runId);
    if (!state) return;
    state.status = "failed";
    state.finishedAt = nowIso();
    state.error = state.error ?? { code: "run_failed", message };
    writeRunState(state);
    const report = finalizeReport({ ...ctx.report, finishedAt: state.finishedAt });
    writeReport(runId, report);
  }

  getRun(runId: string): OpsRunSummary | null {
    const state = readRunState(runId);
    return state ? storedToSummary(state) : null;
  }

  getReport(runId: string): OpsRunReport | null {
    return readReport(runId);
  }

  listRuns(limit = 50): OpsRunListEntry[] {
    return listRunStates(limit).map((s) => ({
      id: s.id,
      profile: s.profile,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      currentStep: s.currentStep,
      input: s.input,
    }));
  }

  requireRun(runId: string): StoredRunState {
    const state = readRunState(runId);
    if (!state) {
      throw new AppError("Ops Run 不存在。", 404);
    }
    return state;
  }

  /** 启动时调用：清理 stale running。 */
  reapStale(): number {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage = require("./OpsRunStorage") as typeof import("./OpsRunStorage");
    return storage.reapStaleRuns(STALE_RUN_MS_DEFAULT);
  }

  /** override 注册（人工覆盖，非默认）。Agent 读此表尊重 force 标记。
   *
   * forceBind：阶段 2 未实施（ReadyAgent 仍走库 bind 流，未支持强制绑指定 asset）。
   * 调用方应当先校验 action；本方法对 forceBind 显式抛错而非静默，
   * 避免 POST /overrides 误以为已写入。
   */
  registerOverride(input: {
    action: "forceKeepDraft" | "forceReject" | "forceBind";
    assetId?: string | null;
  }): void {
    if (input.action === "forceBind") {
      throw new AppError(
        "forceBind 未在阶段 2 实施；ReadyAgent 仍走库 suggest→apply 流。请用 seed→Ear→Ready 默认链。",
        501,
      );
    }
    const runId = "_override_global";
    let entry = this.flagOverrides.get(runId);
    if (!entry) {
      entry = { forceKeepDraft: new Set(), forceReject: new Set() };
      this.flagOverrides.set(runId, entry);
    }
    if (input.action === "forceKeepDraft" && input.assetId) {
      entry.forceKeepDraft.add(input.assetId);
      entry.forceReject.delete(input.assetId);
    } else if (input.action === "forceReject" && input.assetId) {
      entry.forceReject.add(input.assetId);
      entry.forceKeepDraft.delete(input.assetId);
    }
  }

  isForceKeepDraft(assetId: string): boolean {
    return !!this.flagOverrides.get("_override_global")?.forceKeepDraft.has(assetId);
  }

  isForceReject(assetId: string): boolean {
    return !!this.flagOverrides.get("_override_global")?.forceReject.has(assetId);
  }
}

function normalizeProfile(profile: unknown): OpsRunProfile {
  if (
    typeof profile === "string"
    && (
      profile === "full"
      || profile === "library_only"
      || profile === "patrol_only"
      || profile === "ear_auto"
      || profile === "library_ai_fill"
    )
  ) {
    return profile;
  }
  throw new AppError("profile 非法（full/library_only/patrol_only/ear_auto/library_ai_fill）。", 400);
}

function dryRunStepSummary(step: OpsRunStepName, ctx?: OpsRunContext): OpsRunStepSummary {
  // dry-run：对 ear/ready/patrol 步查实际可入参的资产/角色数（不改库）
  // charactersToPlan 在 ready 步即使可数，因 dry-run 不连真业务留 null，
  // 前端应将 null 解释为「待 dry-run=false 时确定」，不视作错误
  if (ctx && step === "ear") {
    try {
      const drafts = voiceLibraryService.list({ status: ["draft"] });
      if (ctx.report.dryRunPlan) {
        ctx.report.dryRunPlan.draftsToAudit = drafts.items
          .map((a) => a.id)
          .filter(Boolean) as string[];
      }
      // assetIds 优先入选
      if (ctx.input.assetIds && ctx.input.assetIds.length > 0 && ctx.report.dryRunPlan) {
        ctx.report.dryRunPlan.draftsToAudit = ctx.input.assetIds.filter(Boolean);
      }
      return {
        step,
        status: "succeeded",
        durationMs: 0,
        counts: { draftsToAudit: ctx.report.dryRunPlan?.draftsToAudit?.length ?? 0 },
        message: "dry-run plan only",
      };
    } catch {
      return { step, status: "succeeded", durationMs: 0, counts: null, message: "dry-run plan only" };
    }
  }
  if (ctx && step === "ready") {
    // dry-run 不连真角色；counts.preserve null，message 标注
    return {
      step,
      status: "succeeded",
      durationMs: 0,
      counts: null,
      message: ctx.input.novelId ? "dry-run：将就绪该 novel 所有角色" : "dry-run：缺 novelId，ready 跳过",
    };
  }
  if (ctx && step === "patrol") {
    return {
      step,
      status: "succeeded",
      durationMs: 0,
      counts: null,
      message: ctx.input.novelId ? "dry-run：仅巡检该 novel" : "dry-run：巡检全 novel",
    };
  }
  return {
    step,
    status: "succeeded",
    durationMs: 0,
    counts: null,
    message: "dry-run plan only",
  };
}

function isReportClean(report: OpsRunReport): boolean {
  if (report.patrol && !report.patrol.clean) return false;
  for (const verdict of report.ear) {
    if (verdict.decision === "needs_human") return false;
  }
  // soft 批量升权视为 issues（需人工复核库质量）
  if ((report.approve.approvedSoft ?? 0) > 0) return false;
  // 中区被硬策略挡住也记 issues，便于运维看见
  if (report.ear.some((v) => v.decision === "approve_with_low_confidence")) return false;
  return true;
}

function storedToSummary(state: StoredRunState): OpsRunSummary {
  return {
    id: state.id,
    profile: state.profile,
    input: state.input,
    inputFingerprint: state.inputFingerprint,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    cancelRequestedAt: state.cancelRequestedAt,
    currentStep: state.currentStep,
    stepsSummary: state.stepsSummary ?? [],
    reportPath: state.reportPath,
    error: state.error,
  };
}

export const opsRunService = new OpsRunService();
export type { OpsRunStatus };
