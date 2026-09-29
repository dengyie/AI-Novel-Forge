import { prisma } from "../../../db/prisma";
import type { RagJobStatus, RagJobType, RagOwnerType } from "../types";
import { enqueueIndexJob } from "./queue";

/** An old execution must never label a newer document version as indexed. */
export async function syncDocumentIndexStatus(ownerType: RagOwnerType, ownerId: string, status: RagJobStatus, jobType: RagJobType, jobId?: string): Promise<void> {
  if (ownerType !== "knowledge_document") return;
  const job = jobId ? await prisma.ragIndexJob.findUnique({ where: { id: jobId } }) : null;
  const payload = JSON.parse(job?.payloadJson ?? "{}") as Record<string, unknown>;
  const document = await prisma.knowledgeDocument.findUnique({ where: { id: ownerId }, select: { activeVersionId: true, status: true, latestIndexStatus: true } });
  if (!document || (document.status === "archived" && jobType !== "delete")) return;
  const indexedVersion = payload.indexedSourceVersionId;
  const sourceVersion = indexedVersion ?? payload.sourceVersionId;
  if (jobType !== "delete" && sourceVersion !== document.activeVersionId) {
    if (status === "succeeded" && document.status !== "archived" && document.latestIndexStatus !== "succeeded") {
      await enqueueIndexJob("rebuild", ownerType, ownerId, { tenantId: job?.tenantId });
    }
    return;
  }
  const pending = await prisma.ragIndexJob.findFirst({
    where: { ownerType, ownerId, id: { not: jobId }, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
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
