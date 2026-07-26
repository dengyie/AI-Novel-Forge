import { prisma } from "../../../../db/prisma";
import { buildPipelineJobLeaseOwnedCasWhere } from "../../pipelineJobTerminalGuard";

export class PipelineJobStateRepository {
  findById(jobId: string) {
    return prisma.generationJob.findUnique({ where: { id: jobId } });
  }

  cancelQueued(jobId: string, cancelledAt: Date) {
    return prisma.generationJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: {
        status: "cancelled",
        cancelRequestedAt: null,
        heartbeatAt: null,
        error: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        finishedAt: cancelledAt,
      },
    });
  }

  requestRunningCancellation(input: {
    jobId: string;
    leaseOwner: string | null;
    requestedAt: Date;
  }) {
    return prisma.generationJob.updateMany({
      where: buildPipelineJobLeaseOwnedCasWhere(input.jobId, input.leaseOwner),
      data: {
        status: "cancelled",
        cancelRequestedAt: input.requestedAt,
        heartbeatAt: input.requestedAt,
        finishedAt: null,
      },
    });
  }
}
