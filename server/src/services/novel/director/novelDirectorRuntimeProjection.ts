import type {
  DirectorRunCommandStatus,
  DirectorRunCommandType,
  DirectorRuntimePolicySnapshot,
  DirectorRuntimeProjectionEvent,
  DirectorRuntimeProjection,
  DirectorRuntimeSnapshot,
} from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../db/prisma";
import { buildDefaultDirectorPolicy } from "./runtime/directorRuntimeDefaults";
import { DirectorEventProjectionService } from "./runtime/DirectorEventProjectionService";
import { directorUsageTelemetryQueryService } from "./runtime/DirectorUsageTelemetryQueryService";

function parseJsonOrNull<T>(value: string | null | undefined): T | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

type ActiveRuntimeCommand = {
  id: string;
  commandType: DirectorRunCommandType;
  status: DirectorRunCommandStatus;
  updatedAt: Date;
};

function resolveActiveCommandCopy(command: ActiveRuntimeCommand): {
  headline: string;
  currentLabel: string;
  detail: string;
} {
  if (command.status === "queued") {
    if (command.commandType === "confirm_candidate") {
      return {
        headline: "AI 正在处理书级方向",
        currentLabel: "书级方向提交完成，等待 AI 创建小说项目。",
        detail: "后台执行器接手后，会创建小说并继续后续流程。",
      };
    }
    return {
      headline: "AI 自动导演等待后台接手",
      currentLabel: "任务进入后台队列，正在等待后台执行器接手。",
      detail: "后台执行器接手后会从当前位置继续推进。",
    };
  }
  if (command.status === "leased") {
    return {
      headline: "后台执行器正在接手",
      currentLabel: "后台执行器正在接手任务。",
      detail: "任务分配给后台执行器，即将进入实际执行。",
    };
  }
  if (command.commandType === "confirm_candidate") {
    return {
      headline: "AI 正在创建小说项目",
      currentLabel: "正在根据选择方向创建小说项目。",
      detail: "AI 正在把你选择的书级方向落成小说项目，并接上后续流程。",
    };
  }
  return {
    headline: "AI 正在推进自动导演",
    currentLabel: "后台执行器正在推进自动导演流程。",
    detail: "AI 正在后台处理当前任务，完成后会写入新的进度。",
  };
}

function overlayActiveCommand(
  projection: DirectorRuntimeProjection,
  command: ActiveRuntimeCommand | null,
): DirectorRuntimeProjection {
  if (!command) {
    return projection;
  }
  if (command.status === "running" && projection.status === "running") {
    return projection;
  }
  const copy = resolveActiveCommandCopy(command);
  return {
    ...projection,
    status: "running",
    headline: copy.headline,
    currentLabel: copy.currentLabel,
    detail: copy.detail,
    requiresUserAction: false,
    blockedReason: null,
    blockingReason: null,
    updatedAt: command.updatedAt.getTime() > Date.parse(projection.updatedAt)
      ? command.updatedAt.toISOString()
      : projection.updatedAt,
  };
}

export async function loadPersistentDirectorRuntimeProjection(
  taskId: string,
  projectionService = new DirectorEventProjectionService(),
): Promise<DirectorRuntimeProjection | null> {
  const [run, activeCommand] = await Promise.all([
    prisma.directorRun.findUnique({
      where: { taskId },
      select: {
        id: true,
        novelId: true,
        entrypoint: true,
        policyJson: true,
        lastWorkspaceAnalysisJson: true,
        updatedAt: true,
        steps: {
          orderBy: [{ updatedAt: "desc" }, { startedAt: "desc" }],
          take: 30,
          select: {
            idempotencyKey: true,
            nodeKey: true,
            label: true,
            status: true,
            targetType: true,
            targetId: true,
            startedAt: true,
            finishedAt: true,
            error: true,
            policyDecisionJson: true,
          },
        },
        events: {
          orderBy: { occurredAt: "desc" },
          take: 30,
          select: {
            id: true,
            type: true,
            taskId: true,
            novelId: true,
            nodeKey: true,
            artifactId: true,
            artifactType: true,
            summary: true,
            affectedScope: true,
            severity: true,
            occurredAt: true,
            metadataJson: true,
          },
        },
      },
    }),
    prisma.directorRunCommand.findFirst({
      where: {
        taskId,
        status: { in: ["queued", "leased", "running"] },
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        commandType: true,
        status: true,
        updatedAt: true,
      },
    }) as Promise<ActiveRuntimeCommand | null>,
  ]);
  if (!run) {
    return null;
  }

  const snapshot: DirectorRuntimeSnapshot = {
    schemaVersion: 1,
    runId: run.id,
    novelId: run.novelId,
    entrypoint: run.entrypoint,
    policy: parseJsonOrNull<DirectorRuntimePolicySnapshot>(run.policyJson)
      ?? {
        ...buildDefaultDirectorPolicy(),
        updatedAt: run.updatedAt.toISOString(),
      },
    steps: [...run.steps].reverse().map((step) => ({
      idempotencyKey: step.idempotencyKey,
      nodeKey: step.nodeKey,
      label: step.label,
      status: step.status as DirectorRuntimeSnapshot["steps"][number]["status"],
      targetType: step.targetType as DirectorRuntimeSnapshot["steps"][number]["targetType"],
      targetId: step.targetId,
      startedAt: step.startedAt.toISOString(),
      finishedAt: step.finishedAt?.toISOString() ?? null,
      error: step.error,
      policyDecision: parseJsonOrNull<DirectorRuntimeSnapshot["steps"][number]["policyDecision"]>(step.policyDecisionJson),
    })),
    events: [...run.events].reverse().map((event) => ({
      eventId: event.id,
      type: event.type as DirectorRuntimeSnapshot["events"][number]["type"],
      taskId: event.taskId,
      novelId: event.novelId,
      nodeKey: event.nodeKey,
      artifactId: event.artifactId,
      artifactType: event.artifactType as DirectorRuntimeSnapshot["events"][number]["artifactType"],
      summary: event.summary,
      affectedScope: event.affectedScope,
      severity: event.severity as DirectorRuntimeSnapshot["events"][number]["severity"],
      occurredAt: event.occurredAt.toISOString(),
      metadata: parseJsonOrNull<Record<string, unknown>>(event.metadataJson) ?? undefined,
    })),
    artifacts: [],
    lastWorkspaceAnalysis: parseJsonOrNull<DirectorRuntimeSnapshot["lastWorkspaceAnalysis"]>(
      run.lastWorkspaceAnalysisJson,
    ),
    updatedAt: run.updatedAt.toISOString(),
  };
  const projection = projectionService.buildSnapshotProjection(snapshot);
  if (!projection) {
    return null;
  }
  const usageTelemetry = await directorUsageTelemetryQueryService.getTaskUsage(
    taskId,
    snapshot.steps,
  );
  return {
    ...overlayActiveCommand(projection, activeCommand),
    usageSummary: usageTelemetry.summary,
    recentUsage: usageTelemetry.recentUsage,
    stepUsage: usageTelemetry.stepUsage,
    promptUsage: usageTelemetry.promptUsage,
  };
}

export async function loadPersistentDirectorRuntimeEventHistory(
  taskId: string,
  limit = 200,
): Promise<{
  events: DirectorRuntimeProjectionEvent[];
  totalCount: number;
  limit: number;
}> {
  const normalizedLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const [totalCount, events] = await Promise.all([
    prisma.directorEvent.count({ where: { taskId } }),
    prisma.directorEvent.findMany({
      where: { taskId },
      orderBy: { occurredAt: "desc" },
      take: normalizedLimit,
      select: {
        id: true,
        type: true,
        nodeKey: true,
        artifactType: true,
        summary: true,
        severity: true,
        occurredAt: true,
      },
    }),
  ]);

  return {
    events: events.map((event) => ({
      eventId: event.id,
      type: event.type as DirectorRuntimeProjectionEvent["type"],
      summary: event.summary,
      nodeKey: event.nodeKey,
      artifactType: event.artifactType as DirectorRuntimeProjectionEvent["artifactType"],
      severity: event.severity as DirectorRuntimeProjectionEvent["severity"],
      occurredAt: event.occurredAt.toISOString(),
    })),
    totalCount,
    limit: normalizedLimit,
  };
}
