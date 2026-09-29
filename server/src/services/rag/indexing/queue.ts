import { prisma } from "../../../db/prisma";
import { ragConfig } from "../../../config/rag";
import type { RagJobType, RagOwnerType } from "../types";

export interface IndexJobOptions {
  tenantId?: string;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  maxAttempts?: number;
}

/** Only queued requests may coalesce. A running job owns an immutable input. */
export async function enqueueIndexJob(jobType: RagJobType, ownerType: RagOwnerType, ownerId: string, options?: IndexJobOptions) {
  const tenantId = options?.tenantId ?? ragConfig.defaultTenantId;
  const now = new Date();
  const progress = { stage: "queued", label: "等待执行", detail: "索引任务已进入队列。", percent: 0, updatedAt: now.toISOString() };
  let inputPayload = options?.payload ?? {};
  let staleRequest = false;
  let currentVersion: string | null = null;
  if (ownerType === "knowledge_document") {
    const document = await prisma.knowledgeDocument.findUnique({ where: { id: ownerId }, select: { activeVersionId: true } });
    currentVersion = document?.activeVersionId ?? null;
    staleRequest = Boolean(inputPayload.sourceVersionId && inputPayload.sourceVersionId !== currentVersion);
    // Keep obsolete input bound to its original version so execution can reject it.
    inputPayload = { ...inputPayload, sourceVersionId: inputPayload.sourceVersionId ?? currentVersion };
  }
  let payloadJson = JSON.stringify({ ...inputPayload, progress });
  // CAS protects against both a concurrent producer and the worker claiming the row.
  // On contention persist a separate request; never silently drop the caller's payload.
  const existing = await prisma.ragIndexJob.findFirst({
    where: { tenantId, jobType, ownerType, ownerId, status: "queued" },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.status === "queued") {
    const previous = JSON.parse(existing.payloadJson ?? "{}") as Record<string, unknown>;
    if (staleRequest && previous.sourceVersionId === currentVersion) return existing;
    // Different document versions remain distinct even if this producer read an older active version.
    if (previous.sourceVersionId === inputPayload.sourceVersionId) {
      payloadJson = JSON.stringify({ ...previous, ...inputPayload, progress });
      const updated = await prisma.ragIndexJob.updateMany({
        where: { id: existing.id, status: "queued", payloadJson: existing.payloadJson },
        data: { payloadJson, attempts: 0, lastError: null, runAfter: options?.runAfter ?? now },
      });
      if (updated.count === 1) return { ...existing, payloadJson, attempts: 0, lastError: null, runAfter: options?.runAfter ?? now };
    }
  }

  return prisma.ragIndexJob.create({
    data: { tenantId, jobType, ownerType, ownerId, status: "queued", attempts: 0,
      maxAttempts: options?.maxAttempts ?? ragConfig.workerMaxAttempts,
      runAfter: options?.runAfter ?? now, payloadJson },
  });
}
