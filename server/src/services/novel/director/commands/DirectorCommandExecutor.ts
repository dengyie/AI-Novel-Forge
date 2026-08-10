import { AppError } from "../../../../middleware/errorHandler";
import { prisma } from "../../../../db/prisma";
import { NovelWorkflowService } from "../../workflow/NovelWorkflowService";
import { mergeSeedPayload, parseSeedPayload } from "../../workflow/novelWorkflow.shared";
import { DirectorCommandInterpreter } from "./DirectorCommandInterpreter";
import { DirectorCommandService } from "./DirectorCommandService";
import type { DirectorCommandPayload } from "./DirectorCommandServiceHelpers";
import { DirectorStateStore } from "../DirectorStateStore";
import { NovelDirectorService } from "../NovelDirectorService";
import {
  getDirectorInputFromSeedPayload,
  type DirectorWorkflowSeedPayload,
} from "../runtime/novelDirectorHelpers";
import type { DirectorTakeoverRequest } from "@ai-novel/shared/types/novelDirector";
import {
  DirectorCommandLeaseLostError,
  throwIfDirectorCommandLeaseLost,
  type DirectorCommandExecutionContext,
} from "./DirectorCommandLeaseGuard";
import { runWithDirectorExecutionContext } from "../runtime/DirectorExecutionContext";

export type DirectorCommandExecutionOutcome = "completed" | "cancelled";

export class DirectorCommandExecutor {
  private readonly directorService: NovelDirectorService;
  private readonly workflowService: NovelWorkflowService;
  private readonly commandService: DirectorCommandService;
  private readonly interpreter: DirectorCommandInterpreter;
  private readonly stateStore: DirectorStateStore;

  constructor(deps: {
    directorService?: NovelDirectorService;
    workflowService?: NovelWorkflowService;
    commandService?: DirectorCommandService;
    interpreter?: DirectorCommandInterpreter;
    stateStore?: DirectorStateStore;
  } = {}) {
    this.directorService = deps.directorService ?? new NovelDirectorService();
    this.workflowService = deps.workflowService ?? new NovelWorkflowService();
    this.commandService = deps.commandService ?? new DirectorCommandService(this.workflowService);
    this.interpreter = deps.interpreter ?? new DirectorCommandInterpreter();
    this.stateStore = deps.stateStore ?? new DirectorStateStore();
  }

  async execute(
    commandId: string,
    context: DirectorCommandExecutionContext = {},
  ): Promise<DirectorCommandExecutionOutcome> {
    throwIfDirectorCommandLeaseLost(context.signal, { commandId, leaseOwner: context.leaseOwner });
    const command = await this.commandService.getCommandById(commandId);
    throwIfDirectorCommandLeaseLost(context.signal, { commandId, leaseOwner: context.leaseOwner });
    if (!command) {
      throw new AppError("Director command not found.", 404);
    }
    const payload = this.commandService.parseCommandPayload(command);
    return runWithDirectorExecutionContext(
      { signal: context.signal, waitForCompletion: true },
      () => this.dispatch(command, payload, context),
    );
  }

  async dispatch(
    command: NonNullable<Awaited<ReturnType<DirectorCommandService["getCommandById"]>>>,
    payload: DirectorCommandPayload,
    context: DirectorCommandExecutionContext = {},
  ): Promise<DirectorCommandExecutionOutcome> {
    const assertLease = () => throwIfDirectorCommandLeaseLost(context.signal, {
      commandId: command.id,
      leaseOwner: context.leaseOwner,
    });
    assertLease();
    const pipelineCommand = this.interpreter.interpret(command, payload);
    const state = await this.stateStore.readTaskState(pipelineCommand.taskId);
    assertLease();
    if (!state) {
      throw new AppError("Director workflow task not found.", 404);
    }
    await this.stateStore.recordPipelineDispatch({
      taskId: pipelineCommand.taskId,
      novelId: pipelineCommand.novelId ?? state.task.novelId,
      runtimeId: state.runtime?.id ?? null,
      commandType: pipelineCommand.intent,
      summary: "导演任务已进入单轨执行管线。",
    });
    assertLease();

    switch (pipelineCommand.intent) {
      case "cancel":
        assertLease();
        await this.workflowService.cancelTask(pipelineCommand.taskId);
        assertLease();
        return "cancelled";
      case "generate_candidates": {
        const request = pipelineCommand.payload.candidatesRequest;
        if (!request) {
          throw new AppError("Director candidate generation payload is missing.", 400);
        }
        const result = await this.directorService.generateCandidates({
          ...request,
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, result, {
          batches: [result.batch],
          candidateStage: null,
        }, true, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "refine_candidates": {
        const request = pipelineCommand.payload.refinementRequest;
        if (!request) {
          throw new AppError("Director candidate refinement payload is missing.", 400);
        }
        const result = await this.directorService.refineCandidates({
          ...request,
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, result, {
          batches: request.previousBatches.concat(result.batch),
          candidateStage: null,
        }, true, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "patch_candidate": {
        const request = pipelineCommand.payload.candidatePatchRequest;
        if (!request) {
          throw new AppError("Director candidate patch payload is missing.", 400);
        }
        const result = await this.directorService.patchCandidate({
          ...request,
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        const nextBatches = request.previousBatches.some((batch) => batch.id === result.batch.id)
          ? request.previousBatches.map((batch) => (batch.id === result.batch.id ? result.batch : batch))
          : request.previousBatches.concat(result.batch);
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, result, {
          batches: nextBatches,
          candidateStage: null,
        }, true, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "refine_titles": {
        const request = pipelineCommand.payload.titleRefineRequest;
        if (!request) {
          throw new AppError("Director title refinement payload is missing.", 400);
        }
        const result = await this.directorService.refineCandidateTitleOptions({
          ...request,
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        const nextBatches = request.previousBatches.some((batch) => batch.id === result.batch.id)
          ? request.previousBatches.map((batch) => (batch.id === result.batch.id ? result.batch : batch))
          : request.previousBatches.concat(result.batch);
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, result, {
          batches: nextBatches,
          candidateStage: null,
        }, true, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "confirm_candidate":
        if (!pipelineCommand.payload.confirmRequest) {
          throw new AppError("Director confirm command payload is missing.", 400);
        }
        await this.directorService.confirmCandidate({
          ...pipelineCommand.payload.confirmRequest,
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      case "takeover": {
        const request = pipelineCommand.takeoverRequest;
        if (!request) {
          throw new AppError("Director takeover command payload is missing.", 400);
        }
        await this.directorService.startTakeover(request, {
          workflowTaskId: pipelineCommand.taskId,
        });
        assertLease();
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "repair_chapter_titles":
        await this.directorService.executeChapterTitleRepair(pipelineCommand.taskId, {
          volumeId: pipelineCommand.payload.volumeId,
        });
        assertLease();
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      case "policy_update": {
        const request = pipelineCommand.payload.policyUpdateRequest;
        if (!request) {
          throw new AppError("Director policy update payload is missing.", 400);
        }
        const snapshot = await this.directorService.updateRuntimePolicy(pipelineCommand.taskId, {
          mode: request.mode,
          patch: {
            mayOverwriteUserContent: request.mayOverwriteUserContent,
            allowExpensiveReview: request.allowExpensiveReview,
            modelTier: request.modelTier,
          },
        });
        assertLease();
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, { snapshot }, {}, false, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "workspace_analysis": {
        const request = pipelineCommand.payload.workspaceAnalysisRequest;
        if (!request?.novelId) {
          throw new AppError("Director workspace analysis payload is missing.", 400);
        }
        const analysis = await this.directorService.analyzeRuntimeWorkspace(request.novelId, {
          workflowTaskId: request.workflowTaskId ?? pipelineCommand.taskId,
          includeAiInterpretation: request.includeAiInterpretation,
        });
        assertLease();
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, { analysis }, {}, false, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "manual_edit_impact": {
        const request = pipelineCommand.payload.manualEditImpactRequest;
        if (!request?.novelId) {
          throw new AppError("Director manual edit impact payload is missing.", 400);
        }
        const impact = await this.directorService.evaluateManualEditImpact(request.novelId, {
          workflowTaskId: request.workflowTaskId ?? pipelineCommand.taskId,
          chapterId: request.chapterId,
          includeAiInterpretation: request.includeAiInterpretation,
        });
        assertLease();
        await this.recordCommandResult(pipelineCommand.taskId, pipelineCommand.id, { impact }, {}, false, context);
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      case "continue":
      case "resume_from_checkpoint":
      case "retry":
      case "approve_gate": {
        const takeoverRequest = await this.resolveContextlessTakeoverRecovery(pipelineCommand.taskId);
        if (takeoverRequest) {
          await this.directorService.startTakeover(takeoverRequest, {
            workflowTaskId: pipelineCommand.taskId,
          });
          assertLease();
          return this.resolveCommandOutcome(pipelineCommand.taskId, context);
        }
        // Command-bus continue/resume/retry/approve_gate always forceResume so
        // pipeline re-enters fact-completed modules with reuseCompletedStep:false
        // (anti ghost-noop). Cost: may re-run planning LLM steps on every continue.
        // Do not silently drop this without product sign-off on ghost risk.
        await this.directorService.executeContinueTask(pipelineCommand.taskId, {
          ...pipelineCommand.payload,
          continuationMode: pipelineCommand.intent === "approve_gate" ? "resume" : pipelineCommand.payload.continuationMode,
          forceResume: true,
        });
        assertLease();
        return this.resolveCommandOutcome(pipelineCommand.taskId, context);
      }
      default:
        throw new AppError(`Unsupported director command type: ${pipelineCommand.intent}`, 400);
    }
  }

  private async resolveCommandOutcome(
    taskId: string,
    context: DirectorCommandExecutionContext,
  ): Promise<DirectorCommandExecutionOutcome> {
    throwIfDirectorCommandLeaseLost(context.signal, { leaseOwner: context.leaseOwner });
    const row = await this.workflowService.getTaskByIdWithoutHealing(taskId).catch(() => null);
    throwIfDirectorCommandLeaseLost(context.signal, { leaseOwner: context.leaseOwner });
    return row?.status === "cancelled" || row?.cancelRequestedAt ? "cancelled" : "completed";
  }

  private async resolveContextlessTakeoverRecovery(taskId: string): Promise<DirectorTakeoverRequest | null> {
    const row = await this.workflowService.getTaskByIdWithoutHealing(taskId);
    const seedPayload = parseSeedPayload<DirectorWorkflowSeedPayload>(row?.seedPayloadJson) ?? {};
    if (getDirectorInputFromSeedPayload(seedPayload)) {
      return null;
    }
    return this.commandService.getLatestTakeoverRequestForTask(taskId);
  }

  private async recordCommandResult(
    taskId: string,
    commandId: string,
    result: unknown,
    seedPatch: Record<string, unknown> = {},
    candidateSelectionReady = false,
    context: DirectorCommandExecutionContext = {},
  ): Promise<void> {
    throwIfDirectorCommandLeaseLost(context.signal, { commandId, leaseOwner: context.leaseOwner });
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      if (context.leaseOwner) {
        const fenced = await tx.directorRunCommand.updateMany({
          where: {
            id: commandId,
            leaseOwner: context.leaseOwner,
            status: { in: ["leased", "running"] },
            leaseExpiresAt: { gt: now },
          },
          data: {
            // This conditional update takes the command row lock before the task
            // projection, closing the check-then-write window on Postgres and SQLite.
            leaseExpiresAt: new Date(now.getTime() + (context.leaseMs ?? 120_000)),
          },
        });
        if (fenced.count !== 1) {
          throw new DirectorCommandLeaseLostError(commandId, context.leaseOwner);
        }
      }

      const row = await tx.novelWorkflowTask.findUnique({
        where: { id: taskId },
        select: { seedPayloadJson: true },
      });
      if (!row) {
        return;
      }
      const current = parseSeedPayload<{ directorCommandResults?: Record<string, unknown> }>(row.seedPayloadJson) ?? {};
      const directorCommandResults = {
        ...(current.directorCommandResults ?? {}),
        [commandId]: {
          result,
          completedAt: now.toISOString(),
        },
      };
      await tx.novelWorkflowTask.update({
        where: { id: taskId },
        data: {
          ...(candidateSelectionReady
            ? {
              status: "waiting_approval",
              currentStage: "AI 自动导演",
              currentItemKey: "candidate_selection_required",
              currentItemLabel: "书级方向已准备好，请选择一套继续",
              progress: 0.18,
              checkpointType: "candidate_selection_required",
              checkpointSummary: "AI 已生成可选的书级方向。",
            }
            : {}),
          seedPayloadJson: mergeSeedPayload(row.seedPayloadJson, {
            ...seedPatch,
            directorCommandResults,
          }),
          heartbeatAt: now,
          ownershipVersion: { increment: 1 },
        },
      });
    });
    throwIfDirectorCommandLeaseLost(context.signal, { commandId, leaseOwner: context.leaseOwner });
  }
}
