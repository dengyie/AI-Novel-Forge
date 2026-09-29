import { prisma } from "../../../db/prisma";
import type { RetrievedChunk } from "../types";

/** Cleanup may be retried; outdated external payloads must never become current context. */
export async function filterPublishedChunks(rows: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (rows.length === 0) return rows;
  const published = await prisma.knowledgeChunk.findMany({
    where: { id: { in: rows.map(row => row.id) }, indexedAt: { not: null } },
    select: { id: true },
  });
  const publishedIds = new Set(published.map(row => row.id));
  rows = rows.filter(row => publishedIds.has(row.id));
  const documentIds = [...new Set(rows.filter(row => row.ownerType === "knowledge_document").map(row => row.ownerId))];
  if (documentIds.length === 0) return rows;
  const documents = await prisma.knowledgeDocument.findMany({
    where: { id: { in: documentIds }, status: { not: "archived" } },
    select: { id: true, activeVersionId: true },
  });
  const versions = new Map(documents.map(document => [document.id, document.activeVersionId]));
  return rows.filter(row => {
    if (row.ownerType !== "knowledge_document") return true;
    const currentVersion = versions.get(row.ownerId);
    if (!currentVersion) return false;
    try {
      const metadata = JSON.parse(row.metadataJson ?? "{}");
      return metadata.activeVersionId === currentVersion;
    } catch { return false; }
  });
}
