import { prisma } from "../../../../db/prisma";
import { buildPipelineLeaseClaimWhere } from "../../pipelineJobDedup";
import { PIPELINE_LEASE_TTL_MS } from "../../pipelineExecutionHelpers";

export class PipelineJobLeaseService {
  claim(jobId: string, leaseOwner: string, now: Date = new Date()) {
    return prisma.generationJob.updateMany({
      where: buildPipelineLeaseClaimWhere({ jobId, now }),
      data: {
        status: "running",
        error: null,
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + PIPELINE_LEASE_TTL_MS),
      },
    });
  }
}
