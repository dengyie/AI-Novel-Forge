import type {
  DirectorCommandAcceptedResponse,
  DirectorRuntimePolicyUpdateRequest,
  DirectorRunCommandType,
} from "@ai-novel/shared/types/directorRuntime";
import type {
  DirectorCandidatePatchRequest,
  DirectorCandidateTitleRefineRequest,
  DirectorCandidatesRequest,
  DirectorConfirmRequest,
  DirectorLLMOptions,
  DirectorRefinementRequest,
  DirectorTakeoverRequest,
} from "@ai-novel/shared/types/novelDirector";
import { prisma } from "../../../../db/prisma";
import { AppError } from "../../../../middleware/errorHandler";
import { NovelWorkflowService } from "../../workflow/NovelWorkflowService";
import {
  applyDirectorLlmOverride,
  applyDirectorRunModeContract,
  buildDirectorSessionState,
  buildDirectorWorkflowSeedPayload,
  type DirectorWorkflowSeedPayload,
} from "../runtime/novelDirectorHelpers";
import { parseSeedPayload } from "../../workflow/novelWorkflow.shared";
import {
  hashPayload,
  isUniqueConstraintError,
  parsePayload,
  stableJson,
  toAcceptedResponse,
  type DirectorCommandPayload,
} from "./DirectorCommandServiceHelpers";
import {
  DirectorCommandAcceptanceService,
  type DirectorTaskAcceptanceExpectation,
} from "./DirectorCommandAcceptanceService";
import {
  DIRECTOR_ACTIVE_COMMAND_STATUSES as ACTIVE_COMMAND_STATUSES,
  DIRECTOR_EXECUTION_COMMAND_TYPES as EXECUTION_COMMAND_TYPES,
  DirectorCommandLeaseService,
} from "./leases/DirectorCommandLeaseService";

export type DirectorRunCommandRow = Awaited<ReturnType<DirectorCommandService["getCommandById"]>>;

export class DirectorCommandService {
  private readonly commandAcceptanceService = new DirectorCommandAcceptanceService();

  constructor(
    private readonly workflowService = new NovelWorkflowService(),
    private readonly commandLeaseService = new DirectorCommandLeaseService(),
  ) {}

  async enqueueGenerateCandidatesCommand(input: DirectorCandidatesRequest): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.ensureCandidateTask(input, {
      mode: "generate",
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "generate_candidates",
      payload: {
        candidatesRequest: {
          ...input,
          workflowTaskId: task.id,
        },
      },
    });
  }

  async enqueueRefineCandidatesCommand(input: DirectorRefinementRequest): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.ensureCandidateTask(input, {
      mode: "refine",
      presets: input.presets ?? [],
      feedback: input.feedback ?? null,
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "refine_candidates",
      payload: {
        refinementRequest: {
          ...input,
          workflowTaskId: task.id,
        },
      },
    });
  }

  async enqueuePatchCandidateCommand(input: DirectorCandidatePatchRequest): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.ensureCandidateTask(input, {
      mode: "patch_candidate",
      batchId: input.batchId,
      candidateId: input.candidateId,
      presets: input.presets ?? [],
      feedback: input.feedback,
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "patch_candidate",
      payload: {
        candidatePatchRequest: {
          ...input,
          workflowTaskId: task.id,
        },
      },
    });
  }

  async enqueueRefineTitlesCommand(input: DirectorCandidateTitleRefineRequest): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.ensureCandidateTask(input, {
      mode: "refine_titles",
      batchId: input.batchId,
      candidateId: input.candidateId,
      feedback: input.feedback,
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "refine_titles",
      payload: {
        titleRefineRequest: {
          ...input,
          workflowTaskId: task.id,
        },
      },
    });
  }

  async enqueueConfirmCandidateCommand(input: DirectorConfirmRequest): Promise<DirectorCommandAcceptedResponse> {
    const confirmedInput = applyDirectorRunModeContract(input);
    const runMode = confirmedInput.runMode;
    const task = await this.workflowService.bootstrapTask({
      workflowTaskId: input.workflowTaskId,
      lane: "auto_director",
      title: input.candidate.workingTitle.trim() || input.title?.trim() || "自动导演开书",
      seedPayload: buildDirectorWorkflowSeedPayload(confirmedInput, null, {
        directorSession: buildDirectorSessionState({
          runMode,
          phase: "candidate_selection",
          isBackgroundRunning: false,
        }),
      }),
      initialState: {
        stage: "auto_director",
        itemKey: "candidate_confirm",
        itemLabel: "等待创建小说项目",
        progress: 0.18,
      },

    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "confirm_candidate",
      payload: {
        confirmRequest: {
          ...confirmedInput,
          workflowTaskId: task.id,
        },
      },
    });
  }

  async enqueueContinueCommand(
    taskId: string,
    input: DirectorCommandPayload = {},
    options: { expectedTaskState?: DirectorTaskAcceptanceExpectation } = {},
  ): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "continue",
      payload: input,
      expectedTaskState: options.expectedTaskState,
    });
  }

  async enqueueApproveGateCommand(taskId: string, input: DirectorCommandPayload = {}): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "approve_gate",
      payload: {
        ...input,
        continuationMode: "resume",
        forceResume: true,
      },
    });
  }

  async enqueuePolicyUpdateCommand(taskId: string, input: DirectorRuntimePolicyUpdateRequest): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "policy_update",
      payload: {
        policyUpdateRequest: input,
      },
    });
  }

  async enqueueWorkspaceAnalysisCommand(input: {
    novelId: string;
    workflowTaskId?: string | null;
    includeAiInterpretation?: boolean;
  }): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.workflowService.bootstrapTask({
      workflowTaskId: input.workflowTaskId?.trim() || undefined,
      novelId: input.novelId,
      lane: "auto_director",
      title: "AI 自动导演工作区分析",
      initialState: {
        stage: "auto_director",
        itemKey: "workspace_analysis",
        itemLabel: "AI 正在检查当前小说产物和可继续状态",
        progress: 0.08,
      },
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "workspace_analysis",
      payload: {
        workspaceAnalysisRequest: {
          novelId: input.novelId,
          workflowTaskId: task.id,
          includeAiInterpretation: input.includeAiInterpretation,
        },
      },
    });
  }

  async enqueueManualEditImpactCommand(input: {
    novelId: string;
    workflowTaskId?: string | null;
    chapterId?: string | null;
    includeAiInterpretation?: boolean;
  }): Promise<DirectorCommandAcceptedResponse> {
    const task = await this.workflowService.bootstrapTask({
      workflowTaskId: input.workflowTaskId?.trim() || undefined,
      novelId: input.novelId,
      lane: "auto_director",
      title: "AI 自动导演编辑影响分析",
      initialState: {
        stage: "auto_director",
        itemKey: "manual_edit_impact",
        itemLabel: "AI 正在分析手动编辑对后续产物的影响",
        progress: 0.08,
      },
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "manual_edit_impact",
      payload: {
        manualEditImpactRequest: {
          novelId: input.novelId,
          workflowTaskId: task.id,
          chapterId: input.chapterId ?? null,
          includeAiInterpretation: input.includeAiInterpretation,
        },
      },
    });
  }

  async enqueueRecoveryCommand(
    taskId: string,
    input: DirectorCommandPayload = {},
    options: { expectedTaskState?: DirectorTaskAcceptanceExpectation } = {},
  ): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "resume_from_checkpoint",
      payload: {
        ...input,
        forceResume: true,
      },
      expectedTaskState: options.expectedTaskState,
    });
  }

  async enqueueRetryCommand(input: {
    taskId: string;
    llmOverride?: Pick<DirectorLLMOptions, "provider" | "model" | "temperature">;
    batchAlreadyStartedCount?: number;
  }): Promise<DirectorCommandAcceptedResponse> {
    const row = await this.workflowService.getTaskByIdWithoutHealing(input.taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    if ((row.status !== "failed" && row.status !== "cancelled") || row.pendingManualRecovery) {
      throw new AppError("Task is already being retried or no longer in a retryable state.", 409);
    }

    const payload = {
      forceResume: true,
      ...(typeof input.batchAlreadyStartedCount === "number"
        ? { batchAlreadyStartedCount: input.batchAlreadyStartedCount }
        : {}),
    } satisfies DirectorCommandPayload;
    const idempotencyKey = `retry:${row.updatedAt.getTime()}:${hashPayload(payload)}`;
    const nextSeedPayload = input.llmOverride
      ? applyDirectorLlmOverride(
        parseSeedPayload<DirectorWorkflowSeedPayload>(row.seedPayloadJson),
        input.llmOverride,
      )
      : null;
    if (input.llmOverride && !nextSeedPayload) {
      throw new AppError("当前自动导演任务缺少可覆盖的模型上下文。", 400);
    }
    const createCommand = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => tx.directorRunCommand.create({
      data: {
        taskId: input.taskId,
        novelId: row.novelId,
        commandType: "retry",
        idempotencyKey,
        status: "queued",
        payloadJson: stableJson(payload),
      },
    });

    try {
      const command = await this.commandAcceptanceService.createAndAcceptRetry({
        taskId: input.taskId,
        createCommand,
        expectedTaskState: {
          status: row.status,
          updatedAt: row.updatedAt,
          cancelRequestedAt: row.cancelRequestedAt,
          attemptCount: row.attemptCount,
          pendingManualRecovery: false,
        },
        supersedeStaleLeasesBefore: new Date(),
        ...(nextSeedPayload ? { seedPayloadJson: JSON.stringify(nextSeedPayload) } : {}),
      });
      return toAcceptedResponse(command, null);
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const existing = await prisma.directorRunCommand.findFirst({
        where: {
          taskId: input.taskId,
          commandType: "retry",
          idempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!existing) {
        throw error;
      }
      return toAcceptedResponse(existing, null);
    }
  }

  async enqueueCancelCommand(taskId: string): Promise<DirectorCommandAcceptedResponse> {
    const row = await this.workflowService.getTaskByIdWithoutHealing(taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    const { command } = await this.commandLeaseService.cancelTaskAndCommands(row);
    return toAcceptedResponse(command, null);
  }

  async enqueueTakeoverCommand(input: DirectorTakeoverRequest): Promise<DirectorCommandAcceptedResponse> {
    const takeoverInput = applyDirectorRunModeContract(input);
    const reusableCommand = await prisma.directorRunCommand.findFirst({
      where: {
        novelId: takeoverInput.novelId,
        commandType: "takeover",
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (reusableCommand) {
      return toAcceptedResponse(reusableCommand, null);
    }

    const task = await this.workflowService.bootstrapTask({
      novelId: takeoverInput.novelId,
      lane: "auto_director",
      title: "执行 AI 自动导演接管",
      forceNew: true,
      initialState: {
        stage: "auto_director",
        itemKey: "takeover",
        itemLabel: "自动导演接管任务已提交",
        progress: 0,
      },
      seedPayload: {
        takeover: {
          entryStep: takeoverInput.entryStep ?? null,
          startPhase: takeoverInput.startPhase ?? null,
          strategy: takeoverInput.strategy ?? null,
          autoExecutionPlan: takeoverInput.autoExecutionPlan ?? null,
        },
      },
    });
    return this.enqueueExecutionCommand({
      taskId: task.id,
      commandType: "takeover",
      payload: {
        takeoverRequest: takeoverInput,
      },
    });
  }

  async enqueueChapterTitleRepairCommand(taskId: string, input: {
    volumeId?: string | null;
  } = {}): Promise<DirectorCommandAcceptedResponse> {
    return this.enqueueExecutionCommand({
      taskId,
      commandType: "repair_chapter_titles",
      payload: {
        volumeId: input.volumeId?.trim() || null,
      },
      preserveLastError: true,
    });
  }

  private async ensureCandidateTask(
    input: DirectorCandidatesRequest | DirectorRefinementRequest | DirectorCandidatePatchRequest | DirectorCandidateTitleRefineRequest,
    candidateStage: {
      mode: "generate" | "refine" | "patch_candidate" | "refine_titles";
      presets?: unknown[];
      feedback?: string | null;
      batchId?: string | null;
      candidateId?: string | null;
    },
  ) {
    return this.workflowService.bootstrapTask({
      workflowTaskId: input.workflowTaskId?.trim() || undefined,
      lane: "auto_director",
      title: input.title?.trim() || "AI 自动导演候选方向",
      seedPayload: {
        idea: input.idea,
        provider: input.provider ?? null,
        model: input.model ?? null,
        temperature: input.temperature ?? null,
        runMode: input.runMode,
        batches: "previousBatches" in input ? input.previousBatches : [],
        candidateStage,
        directorSession: buildDirectorSessionState({
          runMode: input.runMode,
          phase: "candidate_selection",
          isBackgroundRunning: true,
        }),
      },
      initialState: {
        stage: "auto_director",
        itemKey: "candidate_direction_batch",
        itemLabel: "AI 正在生成书级方向候选",
        progress: 0.1,
      },
    });
  }

  async getCommandById(commandId: string) {
    return prisma.directorRunCommand.findUnique({
      where: { id: commandId },
    });
  }

  async getCommandResult(commandId: string) {
    const command = await this.getCommandById(commandId);
    if (!command) {
      throw new AppError("Director command not found.", 404);
    }
    const task = await this.workflowService.getTaskByIdWithoutHealing(command.taskId);
    const seedPayload = parseSeedPayload<{ directorCommandResults?: Record<string, { result?: unknown } | unknown> }>(
      task?.seedPayloadJson,
    ) ?? {};
    const resultEntry = seedPayload.directorCommandResults?.[commandId] ?? null;
    const result = resultEntry && typeof resultEntry === "object" && "result" in resultEntry
      ? (resultEntry as { result?: unknown }).result ?? null
      : resultEntry;
    return {
      commandId: command.id,
      taskId: command.taskId,
      commandType: command.commandType,
      status: command.status,
      result,
      errorMessage: command.errorMessage ?? null,
    };
  }

  async recoverStaleLeases(now = new Date(), options: {
    taskId?: string;
  } = {}): Promise<number> {
    return this.commandLeaseService.recoverStaleLeases(now, options);
  }

  async leaseNextCommand(input: {
    workerId: string;
    leaseMs: number;
  }) {
    return this.commandLeaseService.leaseNextCommand(input);
  }

  async markCommandRunning(commandId: string, workerId: string, leaseMs: number): Promise<boolean> {
    return this.commandLeaseService.markCommandRunning(commandId, workerId, leaseMs);
  }

  async renewLease(commandId: string, workerId: string, leaseMs: number): Promise<boolean> {
    return this.commandLeaseService.renewLease(commandId, workerId, leaseMs);
  }

  async markCommandSucceeded(commandId: string, workerId: string): Promise<boolean> {
    return this.commandLeaseService.markCommandSucceeded(commandId, workerId);
  }

  async markCommandCancelled(commandId: string, workerId: string): Promise<boolean> {
    return this.commandLeaseService.markCommandCancelled(commandId, workerId);
  }

  async markCommandFailed(commandId: string, workerId: string, error: unknown): Promise<boolean> {
    return this.commandLeaseService.markCommandFailed(commandId, workerId, error);
  }

  parseCommandPayload(command: NonNullable<DirectorRunCommandRow>): DirectorCommandPayload {
    return parsePayload(command.payloadJson);
  }

  async getLatestTakeoverRequestForTask(taskId: string): Promise<DirectorTakeoverRequest | null> {
    const command = await prisma.directorRunCommand.findFirst({
      where: {
        taskId,
        commandType: "takeover",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!command) {
      return null;
    }
    return parsePayload(command.payloadJson).takeoverRequest ?? null;
  }

  private async enqueueExecutionCommand(input: {
    taskId: string;
    commandType: DirectorRunCommandType;
    payload: DirectorCommandPayload;
    allowTerminalReuse?: boolean;
    preserveLastError?: boolean;
    expectedTaskState?: DirectorTaskAcceptanceExpectation;
  }): Promise<DirectorCommandAcceptedResponse> {
    // Command handlers read persisted task facts without invoking user-facing healing.
    // This keeps healing -> enqueue -> lookup from recursively entering healing again.
    const row = await this.workflowService.getTaskByIdWithoutHealing(input.taskId);
    if (!row) {
      throw new AppError("Task not found.", 404);
    }
    if (row.lane !== "auto_director") {
      throw new AppError("Only auto director workflow tasks can be queued as director commands.", 400);
    }
    // 全量 stale lease 扫描在 DirectorTaskQueue 后台节流；enqueue 热路径只对本 task
    // 做一次定点 recover：否则 attempt 耗尽仍 status=running 的 continue 会永远挡住新 continue。
    await this.recoverStaleLeases(new Date(), { taskId: input.taskId }).catch(() => null);
    const reusableCommand = await prisma.directorRunCommand.findFirst({
      where: {
        taskId: input.taskId,
        commandType: input.commandType === "cancel" ? "cancel" : { in: EXECUTION_COMMAND_TYPES },
        status: { in: ACTIVE_COMMAND_STATUSES },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (reusableCommand) {
      if (input.expectedTaskState) {
        await this.commandAcceptanceService.projectExistingQueuedCommandIfExpected(
          reusableCommand,
          input.expectedTaskState,
          { preserveLastError: input.preserveLastError },
        );
      } else {
        await this.commandAcceptanceService.acceptExisting(reusableCommand, {
          preserveLastError: input.preserveLastError,
        });
      }
      return toAcceptedResponse(reusableCommand, null);
    }

    const normalizedPayload = Object.fromEntries(
      Object.entries(input.payload).filter(([, value]) => value !== undefined),
    );
    const idempotencyKey = `${input.commandType}:${row.updatedAt.getTime()}:${hashPayload(normalizedPayload)}`;
    const payloadJson = stableJson(normalizedPayload);
    const createCommand = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => tx.directorRunCommand.create({
      data: {
        taskId: input.taskId,
        novelId: row.novelId,
        commandType: input.commandType,
        idempotencyKey,
        status: "queued",
        payloadJson,
      },
    });

    try {
      const command = await this.commandAcceptanceService.createAndAccept({
        taskId: input.taskId,
        commandType: input.commandType,
        createCommand,
        preserveLastError: input.preserveLastError,
        expectedTaskState: input.expectedTaskState,
      });
      return toAcceptedResponse(command, null);
    } catch (error) {
      if (!isUniqueConstraintError(error) || input.allowTerminalReuse === false) {
        throw error;
      }
      const existing = await prisma.directorRunCommand.findFirst({
        where: {
          taskId: input.taskId,
          commandType: input.commandType,
          idempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!existing) {
        throw error;
      }
      if (input.expectedTaskState) {
        await this.commandAcceptanceService.projectExistingQueuedCommandIfExpected(
          existing,
          input.expectedTaskState,
          { preserveLastError: input.preserveLastError },
        );
      } else {
        await this.commandAcceptanceService.acceptExisting(existing, {
          preserveLastError: input.preserveLastError,
        });
      }
      return toAcceptedResponse(existing, null);
    }
  }
}
