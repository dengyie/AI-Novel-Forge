import { prisma } from "../../../../db/prisma";
import type { RagChunkCandidate } from "../../types";
import type { VectorStoreService } from "../../VectorStoreService";

/** indexedAt is the publication marker; null rows retain IDs for crash-safe cleanup. */
export async function replaceIndexedChunks(vectorStore: Pick<VectorStoreService, "upsertPoints" | "deletePoints">, candidates: RagChunkCandidate[], vectors: number[][], oldIds: string[]): Promise<void> {
  const newPoints = candidates.map((item, index) => ({
    id: item.id,
    vector: vectors[index],
    payload: {
      tenantId: item.tenantId,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      novelId: item.novelId,
      worldId: item.worldId,
      title: item.title,
      chunkText: item.chunkText,
      contextPrefix: item.contextPrefix,
      contextVersion: item.contextVersion,
      contextSourceHash: item.contextSourceHash,
      searchText: item.searchText,
      chunkHash: item.chunkHash,
      chunkOrder: item.chunkOrder,
      metadataJson: item.metadataJson,
      facetKeys: item.facetKeys,
      chapterAnchor: item.chapterAnchor,
      ...(item.facets ?? {}),
    },
  }));

  // Persist IDs before any external write. Failed/partial upserts remain discoverable on retry.
  await prisma.knowledgeChunk.createMany({
    data: candidates.map((item) => ({
      id: item.id,
      tenantId: item.tenantId,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      novelId: item.novelId ?? null,
      worldId: item.worldId ?? null,
      title: item.title ?? null,
      chunkText: item.chunkText,
      chunkHash: item.chunkHash,
      chunkOrder: item.chunkOrder,
      tokenEstimate: item.tokenEstimate,
      language: item.language,
      metadataJson: item.metadataJson ?? null,
      facetKeys: item.facetKeys ?? null,
      chapterAnchor: item.chapterAnchor ?? null,
      embedProvider: item.embedProvider,
      embedModel: item.embedModel,
      embedVersion: item.embedVersion,
      indexedAt: null,
    })),
  });
  await vectorStore.upsertPoints(newPoints);

  // Publish new IDs and retire old IDs atomically in the local source of truth.
  await prisma.$transaction([
    prisma.knowledgeChunk.updateMany({ where: { id: { in: candidates.map(item => item.id) } }, data: { indexedAt: new Date() } }),
    prisma.knowledgeChunk.updateMany({ where: { id: { in: oldIds } }, data: { indexedAt: null } }),
  ]);
  if (oldIds.length > 0) {
    await vectorStore.deletePoints(oldIds);
    await prisma.knowledgeChunk.deleteMany({ where: { id: { in: oldIds } } });
  }
}
