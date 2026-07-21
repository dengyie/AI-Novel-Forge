import { prisma } from "../../db/prisma";

const ACTIVE_WORKFLOW_STATUSES = ["queued", "running", "waiting_approval"] as const;
const ACTIVE_AGENT_STATUSES = ["queued", "running", "waiting_approval"] as const;

export interface NovelDeleteCascadeSummary {
  workflowTasksCancelled: number;
  workflowTasksDeleted: number;
  agentRunsCancelled: number;
  agentRunsDeleted: number;
  generationJobsCancelled: number;
  runtimeRowsDeleted: number;
  archiveRowsDeleted: number;
  followUpRowsDeleted: number;
  ragIndexJobsCancelled: number;
}

function emptySummary(): NovelDeleteCascadeSummary {
  return {
    workflowTasksCancelled: 0,
    workflowTasksDeleted: 0,
    agentRunsCancelled: 0,
    agentRunsDeleted: 0,
    generationJobsCancelled: 0,
    runtimeRowsDeleted: 0,
    archiveRowsDeleted: 0,
    followUpRowsDeleted: 0,
    ragIndexJobsCancelled: 0,
  };
}

/**
 * Hard-delete workflow tasks of any status plus non-FK dependents.
 * Unlike TaskRetentionService (terminal-only), novel delete must purge active rows too.
 */
export async function deleteWorkflowTasksHard(
  taskIds: string[],
  summary: NovelDeleteCascadeSummary = emptySummary(),
): Promise<NovelDeleteCascadeSummary> {
  if (taskIds.length === 0) {
    return summary;
  }

  const runtimeDeleteResults = await Promise.all([
    prisma.directorRuntimeEvent.deleteMany({ where: { workflowTaskId: { in: taskIds } } }),
    prisma.directorRuntimeExecution.deleteMany({ where: { workflowTaskId: { in: taskIds } } }),
    prisma.directorRuntimeCommand.deleteMany({ where: { workflowTaskId: { in: taskIds } } }),
    prisma.directorRuntimeInstance.deleteMany({ where: { workflowTaskId: { in: taskIds } } }),
    prisma.autoDirectorFollowUpActionLog.deleteMany({ where: { taskId: { in: taskIds } } }),
    prisma.autoDirectorFollowUpNotificationLog.deleteMany({ where: { taskId: { in: taskIds } } }),
  ]);
  summary.runtimeRowsDeleted += runtimeDeleteResults.slice(0, 4).reduce((sum, r) => sum + r.count, 0);
  summary.followUpRowsDeleted += runtimeDeleteResults.slice(4).reduce((sum, r) => sum + r.count, 0);

  // autoApproval / director* with task FK cascade on task delete; explicit is fine too
  await prisma.autoDirectorAutoApprovalRecord.deleteMany({ where: { taskId: { in: taskIds } } });

  const workflowDeleteResult = await prisma.novelWorkflowTask.deleteMany({
    where: { id: { in: taskIds } },
  });
  summary.workflowTasksDeleted += workflowDeleteResult.count;

  const archiveWorkflowResult = await prisma.taskCenterArchive.deleteMany({
    where: { taskKind: "novel_workflow", taskId: { in: taskIds } },
  });
  summary.archiveRowsDeleted += archiveWorkflowResult.count;

  return summary;
}

/**
 * Purge every task-center / agent / director-runtime artifact owned by a novel
 * before the Novel row itself is deleted.
 *
 * Why application-level (not only FK Cascade):
 * - NovelWorkflowTask / AgentRun historically used onDelete: SetNull (create-before-bind).
 * - DirectorRuntime* and follow-up logs have no FK to Novel/Task.
 * - TaskCenterArchive has no FK.
 * - Active workers should see cancelRequestedAt / cancelled status when possible.
 */
export async function purgeTasksOwnedByNovel(novelId: string): Promise<NovelDeleteCascadeSummary> {
  const summary = emptySummary();
  const now = new Date();

  const workflowTasks = await prisma.novelWorkflowTask.findMany({
    where: { novelId },
    select: { id: true, status: true },
  });
  const workflowIds = workflowTasks.map((row) => row.id);

  if (workflowIds.length > 0) {
    const activeIds = workflowTasks
      .filter((row) => (ACTIVE_WORKFLOW_STATUSES as readonly string[]).includes(row.status))
      .map((row) => row.id);
    if (activeIds.length > 0) {
      const cancelled = await prisma.novelWorkflowTask.updateMany({
        where: { id: { in: activeIds } },
        data: {
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          heartbeatAt: now,
          lastError: "小说已删除，任务已自动取消并清理。",
        },
      });
      summary.workflowTasksCancelled += cancelled.count;
    }
    await deleteWorkflowTasksHard(workflowIds, summary);
  }

  // Runtime rows keyed only by novelId (workflowTaskId may be null / already purged)
  const novelRuntimeDeletes = await Promise.all([
    prisma.directorRuntimeEvent.deleteMany({ where: { novelId } }),
    prisma.directorRuntimeExecution.deleteMany({ where: { novelId } }),
    prisma.directorRuntimeCommand.deleteMany({ where: { novelId } }),
    prisma.directorRuntimeInstance.deleteMany({ where: { novelId } }),
  ]);
  summary.runtimeRowsDeleted += novelRuntimeDeletes.reduce((sum, r) => sum + r.count, 0);

  // GenerationJob cascades with Novel, but cancel first so any in-flight poller sees terminal state.
  const activeJobs = await prisma.generationJob.updateMany({
    where: { novelId, status: { in: ["queued", "running"] } },
    data: {
      status: "cancelled",
      cancelRequestedAt: now,
      finishedAt: now,
      heartbeatAt: now,
      error: "小说已删除，任务已自动取消并清理。",
    },
  });
  summary.generationJobsCancelled += activeJobs.count;
  const generationIds = (
    await prisma.generationJob.findMany({
      where: { novelId },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (generationIds.length > 0) {
    const archivePipeline = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: "novel_pipeline", taskId: { in: generationIds } },
    });
    summary.archiveRowsDeleted += archivePipeline.count;
  }

  const audiobookIds = (
    await prisma.audiobookTask.findMany({
      where: { novelId },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (audiobookIds.length > 0) {
    await prisma.audiobookTask.updateMany({
      where: {
        id: { in: audiobookIds },
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        heartbeatAt: now,
        error: "小说已删除，任务已自动取消并清理。",
      },
    });
    const archiveAudiobook = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: "novel_audiobook", taskId: { in: audiobookIds } },
    });
    summary.archiveRowsDeleted += archiveAudiobook.count;
  }

  const imageTaskIds = (
    await prisma.imageGenerationTask.findMany({
      where: { novelId },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (imageTaskIds.length > 0) {
    await prisma.imageGenerationTask.updateMany({
      where: {
        id: { in: imageTaskIds },
        status: { in: ["queued", "running"] },
      },
      data: {
        status: "cancelled",
        cancelRequestedAt: now,
        finishedAt: now,
        heartbeatAt: now,
        error: "小说已删除，任务已自动取消并清理。",
      },
    });
    const archiveImage = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: "image_generation", taskId: { in: imageTaskIds } },
    });
    summary.archiveRowsDeleted += archiveImage.count;
  }

  const agentRuns = await prisma.agentRun.findMany({
    where: { novelId },
    select: { id: true, status: true },
  });
  const agentIds = agentRuns.map((row) => row.id);
  if (agentIds.length > 0) {
    const activeAgentIds = agentRuns
      .filter((row) => (ACTIVE_AGENT_STATUSES as readonly string[]).includes(row.status))
      .map((row) => row.id);
    if (activeAgentIds.length > 0) {
      await prisma.agentApproval.updateMany({
        where: { runId: { in: activeAgentIds }, status: "pending" },
        data: {
          status: "expired",
          decisionNote: "小说已删除，审批已失效。",
          decidedAt: now,
        },
      });
      const cancelledAgents = await prisma.agentRun.updateMany({
        where: { id: { in: activeAgentIds } },
        data: {
          status: "cancelled",
          finishedAt: now,
          currentStep: "cancelled",
          error: "小说已删除，任务已自动取消并清理。",
        },
      });
      summary.agentRunsCancelled += cancelledAgents.count;
    }
    const deletedAgents = await prisma.agentRun.deleteMany({
      where: { id: { in: agentIds } },
    });
    summary.agentRunsDeleted += deletedAgents.count;
    const archiveAgent = await prisma.taskCenterArchive.deleteMany({
      where: { taskKind: "agent_run", taskId: { in: agentIds } },
    });
    summary.archiveRowsDeleted += archiveAgent.count;
  }

  // Drop queued RAG upserts for this novel so the queue does not thrash missing owners.
  // Keep delete jobs so the index worker can still remove vectors.
  const ragCancel = await prisma.ragIndexJob.updateMany({
    where: {
      ownerId: novelId,
      ownerType: { in: ["novel", "bible"] },
      status: "queued",
      jobType: "upsert",
    },
    data: {
      status: "cancelled",
      lastError: "novel deleted before upsert ran",
    },
  });
  summary.ragIndexJobsCancelled += ragCancel.count;

  return summary;
}
