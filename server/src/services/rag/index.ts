import { EmbeddingService } from "./EmbeddingService";
import { VectorStoreService } from "./VectorStoreService";
import { HybridRetrievalService } from "./HybridRetrievalService";
import { RagIndexService } from "./RagIndexService";
import { RagContextualChunkService } from "./RagContextualChunkService";
import { RagRerankerService } from "./RagRerankerService";
import { RagJobCleanupService } from "./RagJobCleanupService";
import { RagRetrievalTraceRetention } from "./RagRetrievalTraceRetention";
import { RagWorker } from "./RagWorker";

/**
 * Lazy singletons: top-level `new X()` re-enters this module mid-load under CJS
 * cycles (e.g. novelCoreCharacterService → rag/index → RagContextualChunkService →
 * promptRunner → … → novel → rag/index) while class exports are still incomplete.
 * Defer construction until first property access.
 */
let embeddingServiceSingleton: EmbeddingService | null = null;
let vectorStoreServiceSingleton: VectorStoreService | null = null;
let ragContextualChunkServiceSingleton: RagContextualChunkService | null = null;
let ragRerankerServiceSingleton: RagRerankerService | null = null;
let ragIndexServiceSingleton: RagIndexService | null = null;
let ragJobCleanupServiceSingleton: RagJobCleanupService | null = null;
let ragRetrievalTraceRetentionSingleton: RagRetrievalTraceRetention | null = null;
let hybridRetrievalServiceSingleton: HybridRetrievalService | null = null;
let ragWorkerSingleton: RagWorker | null = null;

function getEmbeddingService(): EmbeddingService {
  if (!embeddingServiceSingleton) {
    embeddingServiceSingleton = new EmbeddingService();
  }
  return embeddingServiceSingleton;
}

function getVectorStoreService(): VectorStoreService {
  if (!vectorStoreServiceSingleton) {
    vectorStoreServiceSingleton = new VectorStoreService();
  }
  return vectorStoreServiceSingleton;
}

function getRagContextualChunkService(): RagContextualChunkService {
  if (!ragContextualChunkServiceSingleton) {
    ragContextualChunkServiceSingleton = new RagContextualChunkService();
  }
  return ragContextualChunkServiceSingleton;
}

function getRagRerankerService(): RagRerankerService {
  if (!ragRerankerServiceSingleton) {
    ragRerankerServiceSingleton = new RagRerankerService();
  }
  return ragRerankerServiceSingleton;
}

function getRagIndexService(): RagIndexService {
  if (!ragIndexServiceSingleton) {
    ragIndexServiceSingleton = new RagIndexService(
      getEmbeddingService(),
      getVectorStoreService(),
      getRagContextualChunkService(),
    );
  }
  return ragIndexServiceSingleton;
}

function getRagJobCleanupService(): RagJobCleanupService {
  if (!ragJobCleanupServiceSingleton) {
    ragJobCleanupServiceSingleton = new RagJobCleanupService();
  }
  return ragJobCleanupServiceSingleton;
}

function getRagRetrievalTraceRetention(): RagRetrievalTraceRetention {
  if (!ragRetrievalTraceRetentionSingleton) {
    ragRetrievalTraceRetentionSingleton = new RagRetrievalTraceRetention();
  }
  return ragRetrievalTraceRetentionSingleton;
}

function getHybridRetrievalService(): HybridRetrievalService {
  if (!hybridRetrievalServiceSingleton) {
    hybridRetrievalServiceSingleton = new HybridRetrievalService(
      getEmbeddingService(),
      getVectorStoreService(),
      getRagRerankerService(),
    );
  }
  return hybridRetrievalServiceSingleton;
}

function getRagWorker(): RagWorker {
  if (!ragWorkerSingleton) {
    ragWorkerSingleton = new RagWorker(getRagIndexService(), getRagJobCleanupService());
  }
  return ragWorkerSingleton;
}

export const ragServices = {
  get embeddingService() {
    return getEmbeddingService();
  },
  get vectorStoreService() {
    return getVectorStoreService();
  },
  get ragContextualChunkService() {
    return getRagContextualChunkService();
  },
  get ragRerankerService() {
    return getRagRerankerService();
  },
  get ragIndexService() {
    return getRagIndexService();
  },
  get ragJobCleanupService() {
    return getRagJobCleanupService();
  },
  get ragRetrievalTraceRetention() {
    return getRagRetrievalTraceRetention();
  },
  get hybridRetrievalService() {
    return getHybridRetrievalService();
  },
  get ragWorker() {
    return getRagWorker();
  },
};
