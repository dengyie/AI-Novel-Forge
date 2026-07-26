import { createHash } from "node:crypto";
import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import { directorAutomationLedgerEventService } from "../../director/runtime/DirectorAutomationLedgerEventService";
import { filterAcceptedFactItems, type FactLedgerExcludedItem } from "../../fact/factLedgerFilter";
import { novelFactService } from "../../fact/NovelFactService";

export class ChapterFactProjectionService {
  async writeAcceptedFacts(input: {
    novelId: string;
    chapterId: string;
    runId: string | null;
    contextPackage: GenerationContextPackage;
    runtimePackage: ChapterRuntimePackage;
  }): Promise<void> {
    const chapterOrder = input.contextPackage.chapter.order;
    const writeCtx = input.contextPackage.chapterWriteContext;
    if (!writeCtx) return;
    const obligationCoverage = input.runtimePackage.obligationCoverage ?? {
      status: "satisfied" as const,
      missing: [],
      summary: "旧运行记录未包含章节义务覆盖信息。",
    };
    const filtered = filterAcceptedFactItems({
      chapterOrder,
      mustHitNow: writeCtx.obligationContract?.mustHitNow ?? [],
      obligationCoverage,
      acceptanceRiskTags: input.runtimePackage.meta?.riskTags ?? [],
    });
    if (filtered.excluded.length > 0) {
      await this.recordExcludedFactItems({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder,
        runId: input.runId,
        obligationCoverageStatus: obligationCoverage.status,
        excluded: filtered.excluded,
      });
    }
    if (filtered.accepted.length > 0) {
      await novelFactService.writeFacts(input.novelId, chapterOrder, filtered.accepted);
    }
  }

  private async recordExcludedFactItems(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    runId: string | null;
    obligationCoverageStatus: ChapterRuntimePackage["obligationCoverage"]["status"];
    excluded: FactLedgerExcludedItem[];
  }): Promise<void> {
    for (const item of input.excluded) {
      console.warn("[fact-ledger] skipped unverified chapter obligation", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        reason: item.reason,
        matchedMissingKind: item.matchedMissingKind ?? null,
        matchedMissingSummary: item.matchedMissingSummary ?? null,
        matchScore: item.matchScore ?? null,
        text: item.text,
      });
    }
    const fingerprint = createHash("sha1")
      .update(JSON.stringify(input.excluded.map((item) => ({
        text: item.text,
        reason: item.reason,
        matchedMissingKind: item.matchedMissingKind ?? null,
        matchedMissingSummary: item.matchedMissingSummary ?? null,
      }))))
      .digest("hex")
      .slice(0, 16);
    await directorAutomationLedgerEventService.recordEvent({
      type: "continue_with_risk",
      idempotencyKey: [
        input.novelId,
        input.chapterId,
        input.chapterOrder,
        "fact-ledger-obligation-filter",
        fingerprint,
      ].join(":"),
      runId: input.runId,
      novelId: input.novelId,
      nodeKey: "chapter_execution_node",
      summary: `本章 ${input.excluded.length} 条义务未由验收确认，未写入事实账本。`,
      affectedScope: `chapter:${input.chapterId}`,
      severity: "medium",
      metadata: {
        decision: "exclude_unverified_fact_items",
        chapterOrder: input.chapterOrder,
        obligationCoverageStatus: input.obligationCoverageStatus,
        excludedObligations: input.excluded,
      },
    }).catch((error) => {
      console.warn("[fact-ledger] skipped obligation exclusion event failed", {
        novelId: input.novelId,
        chapterId: input.chapterId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
