import type {
  DirectorRuntimePolicySnapshot,
  DirectorRuntimeProjection,
  DirectorRuntimeSnapshot,
} from "@ai-novel/shared/types/directorRuntime";
import { prisma } from "../../../db/prisma";
import { buildDefaultDirectorPolicy } from "./runtime/directorRuntimeDefaults";
import { DirectorEventProjectionService } from "./runtime/DirectorEventProjectionService";

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

export async function loadPersistentDirectorRuntimeProjection(
  taskId: string,
  projectionService = new DirectorEventProjectionService(),
): Promise<DirectorRuntimeProjection | null> {
  const run = await prisma.directorRun.findUnique({
    where: { taskId },
    select: {
      id: true,
      novelId: true,
      entrypoint: true,
      policyJson: true,
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
        },
      },
    },
  });
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
    })),
    artifacts: [],
    updatedAt: run.updatedAt.toISOString(),
  };
  return projectionService.buildSnapshotProjection(snapshot);
}
