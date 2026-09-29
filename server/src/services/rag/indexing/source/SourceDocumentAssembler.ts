import { prisma } from "../../../../db/prisma";
import { ragConfig } from "../../../../config/rag";
import type { RagChunkCandidate, RagOwnerType, RagSourceDocument } from "../../types";
import type { RagContextualChunkDocument } from "../../RagContextualChunkService";
import { buildChunkId, computeChunkHash, estimateTokenCount, normalizeRagText, splitRagChunks } from "../../utils";
import { encodeFacetKeys, extractChapterAnchorFromChunk, extractCharacterRolesFromChunk, normalizeRagFacets, type RagChunkAnchor, type RagChunkFacets, type RagPreChunk } from "../../chunkFacets";
interface SourcePiece { chunkText: string; facets?: RagChunkFacets; anchor?: RagChunkAnchor; metadata?: Record<string, unknown>; }
function isCjk(text: string): boolean { return /[\u4E00-\u9FFF]/.test(text); }
function buildJoinedText(...parts: Array<string | null | undefined>): string { return parts.map(part => (part ?? "").trim()).filter(Boolean).join("\n").trim(); }

export class SourceDocumentAssembler {
  normalizePreChunks(raw: unknown): RagPreChunk[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const record = item as Record<string, unknown>;
      const chunkText = typeof record.chunkText === "string" ? normalizeRagText(record.chunkText) : "";
      if (!chunkText) {
        return [];
      }
      const anchor = record.anchor && typeof record.anchor === "object" && !Array.isArray(record.anchor)
        ? record.anchor as RagChunkAnchor
        : undefined;
      const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : undefined;
      return [{
        chunkText,
        facets: normalizeRagFacets(record.facets),
        anchor,
        metadata,
      }];
    }).slice(0, 200);
  }

  async loadSourceDocuments(
    ownerType: RagOwnerType,
    ownerId: string,
    tenantId: string,
    payload?: Record<string, unknown>,
  ): Promise<RagSourceDocument[]> {
    switch (ownerType) {
      case "novel": {
        const novel = await prisma.novel.findUnique({
          where: { id: ownerId },
          include: { world: true },
        });
        if (!novel) {
          return [];
        }
        const content = buildJoinedText(
          novel.title,
          novel.description ?? undefined,
          novel.outline ?? undefined,
          novel.structuredOutline ?? undefined,
          novel.world?.description ?? undefined,
        );
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: novel.id,
            worldId: novel.worldId ?? undefined,
            title: novel.title,
            content,
            metadata: {
              status: novel.status,
              updatedAt: novel.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "chapter": {
        const chapter = await prisma.chapter.findUnique({ where: { id: ownerId } });
        if (!chapter) {
          return [];
        }
        const content = buildJoinedText(chapter.title, chapter.content ?? undefined);
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: chapter.novelId,
            title: chapter.title,
            content,
            metadata: {
              order: chapter.order,
              chapterOrder: chapter.order,
              state: chapter.generationState,
              updatedAt: chapter.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "world": {
        const world = await prisma.world.findUnique({ where: { id: ownerId } });
        if (!world) {
          return [];
        }
        const content = buildJoinedText(
          world.name,
          world.description ?? undefined,
          world.background ?? undefined,
          world.geography ?? undefined,
          world.magicSystem ?? undefined,
          world.politics ?? undefined,
          world.cultures ?? undefined,
          world.races ?? undefined,
          world.religions ?? undefined,
          world.technology ?? undefined,
          world.history ?? undefined,
          world.economy ?? undefined,
          world.factions ?? undefined,
          world.conflicts ?? undefined,
          world.overviewSummary ?? undefined,
        );
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            worldId: world.id,
            title: world.name,
            content,
            metadata: {
              worldType: world.worldType,
              status: world.status,
              version: world.version,
              updatedAt: world.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "character": {
        const character = await prisma.character.findUnique({ where: { id: ownerId } });
        if (!character) {
          return [];
        }
        const content = buildJoinedText(
          character.name,
          character.role,
          character.personality ?? undefined,
          character.background ?? undefined,
          character.development ?? undefined,
          character.currentState ?? undefined,
          character.currentGoal ?? undefined,
        );
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: character.novelId,
            title: character.name,
            content,
            metadata: {
              role: character.role,
              updatedAt: character.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "bible": {
        const bible = await prisma.novelBible.findUnique({ where: { novelId: ownerId } });
        if (!bible) {
          return [];
        }
        const content = buildJoinedText(
          bible.mainPromise ?? undefined,
          bible.coreSetting ?? undefined,
          bible.forbiddenRules ?? undefined,
          bible.characterArcs ?? undefined,
          bible.worldRules ?? undefined,
          bible.rawContent ?? undefined,
        );
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: bible.novelId,
            title: `bible-${bible.novelId}`,
            content,
            metadata: {
              updatedAt: bible.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "chapter_summary": {
        const summary = await prisma.chapterSummary.findUnique({ where: { chapterId: ownerId } });
        if (!summary) {
          return [];
        }
        const content = buildJoinedText(
          summary.summary,
          summary.keyEvents ?? undefined,
          summary.characterStates ?? undefined,
          summary.hook ?? undefined,
        );
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: summary.novelId,
            title: `chapter-summary-${summary.chapterId}`,
            content,
            metadata: {
              chapterId: summary.chapterId,
              updatedAt: summary.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "consistency_fact": {
        const fact = await prisma.consistencyFact.findUnique({ where: { id: ownerId } });
        if (!fact) {
          return [];
        }
        const content = normalizeRagText(fact.content);
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: fact.novelId,
            title: `fact-${fact.category}`,
            content,
            metadata: {
              category: fact.category,
              source: fact.source,
              chapterId: fact.chapterId,
              updatedAt: fact.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "character_timeline": {
        const timeline = await prisma.characterTimeline.findUnique({ where: { id: ownerId } });
        if (!timeline) {
          return [];
        }
        const content = buildJoinedText(timeline.title, timeline.content);
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            novelId: timeline.novelId,
            title: timeline.title,
            content,
            metadata: {
              source: timeline.source,
              characterId: timeline.characterId,
              chapterId: timeline.chapterId,
              chapterOrder: timeline.chapterOrder,
              updatedAt: timeline.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "world_library_item": {
        const item = await prisma.worldPropertyLibrary.findUnique({ where: { id: ownerId } });
        if (!item) {
          return [];
        }
        const content = buildJoinedText(item.name, item.description ?? undefined);
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            worldId: item.sourceWorldId ?? undefined,
            title: item.name,
            content,
            metadata: {
              category: item.category,
              worldType: item.worldType,
              usageCount: item.usageCount,
              updatedAt: item.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "knowledge_document": {
        const document = await prisma.knowledgeDocument.findUnique({
          where: { id: ownerId },
          include: { activeVersion: true },
        });
        if (!document?.activeVersion || document.status === "archived") {
          return [];
        }
        const content = normalizeRagText(document.activeVersion.content);
        return content
          ? [{
            ownerType,
            ownerId,
            tenantId,
            title: document.title,
            content,
            preChunks: payload?.sourceVersionId === document.activeVersionId ? this.normalizePreChunks(payload?.preChunks) : undefined,
            metadata: {
              fileName: document.fileName,
              kind: document.kind,
              sourceAnalysisId: document.sourceAnalysisId,
              status: document.status,
              activeVersionId: document.activeVersionId,
              activeVersionNumber: document.activeVersionNumber,
              updatedAt: document.updatedAt.toISOString(),
            },
          }]
          : [];
      }
      case "chat_message":
      default:
        return [];
    }
  }

  buildChunkCandidates(
    documents: RagSourceDocument[],
    embedProvider: string,
    embedModel: string,
    options?: { maxTokens?: number | null; knownCharacterNames?: string[] },
  ): RagChunkCandidate[] {
    const candidateNames = options?.knownCharacterNames ?? [];
    const candidates: RagChunkCandidate[] = [];
    for (const document of documents) {
      const isKnowledgeDoc = document.ownerType === "knowledge_document";
      const sourcePieces: SourcePiece[] = document.preChunks?.length
        ? document.preChunks.flatMap((preChunk) => {
          const pieces = splitRagChunks(preChunk.chunkText, ragConfig.chunkSize, ragConfig.chunkOverlap, {
            maxTokens: options?.maxTokens ?? null,
          });
          return pieces.map((chunkText) => ({
            chunkText,
            facets: preChunk.facets,
            anchor: preChunk.anchor,
            metadata: preChunk.metadata,
          }));
        })
        : splitRagChunks(document.content, ragConfig.chunkSize, ragConfig.chunkOverlap, {
          maxTokens: options?.maxTokens ?? null,
        }).map((chunkText): SourcePiece => {
          if (!isKnowledgeDoc) {
            return { chunkText };
          }
          // 知识库文档：自动从 chunk 正文抽取章节锚点和角色名，填充 facets
          const chapterAnchors = extractChapterAnchorFromChunk(chunkText);
          const characterRoles = candidateNames.length > 0
            ? extractCharacterRolesFromChunk(chunkText, candidateNames)
            : [];
          const facets: RagChunkFacets = {};
          if (chapterAnchors.length > 0) {
            facets.chapterAnchor = chapterAnchors;
          }
          if (characterRoles.length > 0) {
            facets.characterRole = characterRoles;
          }
          return {
            chunkText,
            facets: Object.keys(facets).length > 0 ? facets : undefined,
          };
        });
      for (const piece of sourcePieces) {
        const chunkText = piece.chunkText;
        const chunkOrder = candidates.filter((item) =>
          item.ownerType === document.ownerType && item.ownerId === document.ownerId).length;
        const metadata = {
          ...(document.metadata ?? {}),
          ...(piece.metadata ?? {}),
          ...(piece.facets && Object.keys(piece.facets).length > 0 ? { facets: piece.facets } : {}),
          ...(piece.anchor ? { anchor: piece.anchor } : {}),
        };
        const facetKeys = encodeFacetKeys(piece.facets);
        const chapterAnchor = piece.anchor?.chapterIndex !== undefined
          ? String(piece.anchor.chapterIndex)
          : piece.facets?.chapterAnchor?.[0] ?? null;
        const chunkHash = computeChunkHash(
          `${document.tenantId}|${document.ownerType}|${document.ownerId}|${chunkOrder}|${chunkText}`,
        );
        candidates.push({
          id: buildChunkId(),
          ownerType: document.ownerType,
          ownerId: document.ownerId,
          tenantId: document.tenantId,
          title: document.title,
          chunkText,
          chunkHash,
          chunkOrder,
          tokenEstimate: estimateTokenCount(chunkText),
          language: isCjk(chunkText) ? "zh" : "en",
          metadataJson: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
          facets: piece.facets,
          facetKeys,
          chapterAnchor,
          embedProvider,
          embedModel,
          embedVersion: ragConfig.embeddingVersion,
          novelId: document.novelId,
          worldId: document.worldId,
        });
      }
    }
    return candidates;
  }

  buildContextualDocumentMap(documents: RagSourceDocument[]): Map<string, RagContextualChunkDocument> {
    return new Map(documents.map((document) => [
      `${document.ownerType}:${document.ownerId}`,
      {
        ownerType: document.ownerType,
        ownerId: document.ownerId,
        title: document.title,
        novelId: document.novelId,
        worldId: document.worldId,
        metadata: document.metadata,
      },
    ]));
  }

}
