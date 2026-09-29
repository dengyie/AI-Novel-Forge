import { prisma } from "../../../db/prisma";
import type { RagJobStatus, RagJobType, RagOwnerType } from "../types";
import { enqueueIndexJob } from "./queue";

/** An old execution must never label a newer document version as indexed. */
export async function syncDocumentIndexStatus(ownerType: RagOwnerType, ownerId: string, status: RagJobStatus, jobType: RagJobType, jobId?: string): Promise<void> {
  if (ownerType !== "knowledge_document") return;
  const job = jobId ? await prisma.ragIndexJob.findUnique({ where: { id: jobId } }) : null;
  const payload = JSON.parse(job?.payloadJson ?? "{}") as Record<string, unknown>;
  const document = await prisma.knowledgeDocument.findUnique({ where: { id: ownerId }, select: { activeVersionId: true, status: true } });
  if (!document || (document.status === "archived" && jobType !== "delete")) return;
  const indexedVersion = payload.indexedSourceVersionId;
  const sourceVersion = indexedVersion ?? payload.sourceVersionId;
  if (jobType !== "delete" && sourceVersion !== document.activeVersionId) {
    if (status === "succeeded") {
      // Publication is transactional after all vector writes; a UI status is not proof.
      const published = await prisma.knowledgeChunk.findFirst({
        where: { tenantId: job?.tenantId, ownerType, ownerId, indexedAt: { not: null } },
        orderBy: { indexedAt: "desc" },
        select: { metadataJson: true },
      });
      let publishedVersion: unknown;
      try {
        publishedVersion = JSON.parse(published?.metadataJson ?? "{}").activeVersionId;
      } catch { /* Unverifiable publication must be rebuilt. */ }
      if (publishedVersion !== document.activeVersionId) {
        const pending = await prisma.ragIndexJob.findMany({
          where: { tenantId: job?.tenantId, ownerType, ownerId, id: { not: jobId }, status: { in: ["queued", "running"] } },
          select: { payloadJson: true },
        });
        // Current-version work already owns its custom input and retry lifecycle.
        // A generic catch-up would replace those chunks after that work succeeds.
        if (pending.some(candidate => JSON.parse(candidate.payloadJson ?? "{}").sourceVersionId === document.activeVersionId)) return;
        await enqueueIndexJob("rebuild", ownerType, ownerId, { tenantId: job?.tenantId });
      }
    }
    return;
  }
  const activeJobs = await prisma.ragIndexJob.findMany({
    where: { tenantId: job?.tenantId, ownerType, ownerId, id: { not: jobId }, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
    select: { status: true, payloadJson: true },
  });
  const pending = activeJobs.find(activeJob => {
    const activePayload = JSON.parse(activeJob.payloadJson ?? "{}") as Record<string, unknown>;
    const requestedVersion = activePayload.sourceVersionId ?? activePayload.indexedSourceVersionId;
    return requestedVersion === undefined || requestedVersion === document.activeVersionId;
  });
  const nextStatus = pending ? (pending.status === "running" ? "running" : "queued")
    : jobType === "delete" && (status === "succeeded" || status === "cancelled") ? "idle"
    : status === "cancelled" ? "idle" : status;
  await prisma.knowledgeDocument.updateMany({
    where: { id: ownerId, activeVersionId: document.activeVersionId, status: document.status },
    data: { latestIndexStatus: nextStatus,
      ...(nextStatus === "succeeded" && jobType !== "delete" ? { lastIndexedAt: new Date() } : {}) },
  });
}
