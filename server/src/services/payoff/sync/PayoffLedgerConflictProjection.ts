import type { PayoffLedgerItem } from "@ai-novel/shared/types/payoffLedger";
import { prisma } from "../../../db/prisma";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../../novel/runtime/projections";
import { buildSyntheticPayoffIssues } from "../payoffLedgerShared";

export async function syncPayoffLedgerOpenConflicts(input: {
  novelId: string;
  items: PayoffLedgerItem[];
  chapterOrder?: number | null;
  projectionOwner?: ChapterProjectionOwner;
}): Promise<void> {
  const syntheticIssues = buildSyntheticPayoffIssues(input.items, input.chapterOrder);
  const activeConflictKeys = syntheticIssues.map((issue) => `payoff:${issue.ledgerKey}:${issue.code}`);

  await prisma.$transaction(async (tx) => {
    if (input.projectionOwner) {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.projectionOwner);
    }
    await tx.openConflict.updateMany({
      where: {
        novelId: input.novelId,
        sourceType: "payoff_ledger",
        status: "open",
        conflictKey: { notIn: activeConflictKeys },
      },
      data: { status: "resolved" },
    });

    for (const issue of syntheticIssues) {
      const ledgerItem = input.items.find((item) => item.ledgerKey === issue.ledgerKey);
      const conflictKey = `payoff:${issue.ledgerKey}:${issue.code}`;
      const data = {
        chapterId: ledgerItem?.lastTouchedChapterId ?? ledgerItem?.setupChapterId ?? ledgerItem?.payoffChapterId ?? null,
        sourceSnapshotId: ledgerItem?.lastSnapshotId ?? null,
        sourceIssueId: null,
        conflictType: issue.code,
        title: `payoff/${issue.code}`,
        summary: issue.description,
        severity: issue.severity,
        status: "open",
        evidenceJson: JSON.stringify([issue.evidence]),
        affectedCharacterIdsJson: JSON.stringify([]),
        resolutionHint: issue.fixSuggestion,
        lastSeenChapterOrder: ledgerItem?.lastTouchedChapterOrder ?? ledgerItem?.targetEndChapterOrder ?? null,
      };
      const updated = await tx.openConflict.updateMany({
        where: { novelId: input.novelId, sourceType: "payoff_ledger", conflictKey },
        data,
      });
      if (updated.count === 0) {
        await tx.openConflict.create({
          data: {
            novelId: input.novelId,
            sourceType: "payoff_ledger",
            conflictKey,
            ...data,
          },
        });
      }
    }
  });
}
