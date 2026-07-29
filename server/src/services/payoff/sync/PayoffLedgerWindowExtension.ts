import type { PayoffLedgerRiskSignal } from "@ai-novel/shared/types/payoffLedger";
import { prisma } from "../../../db/prisma";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../../novel/runtime/projections";
import {
  applyGraceExtension,
  safeParseJson,
  serializeLedgerJson,
} from "../payoffLedgerShared";

export async function extendStalePendingPayoffWindows(input: {
  novelId: string;
  chapterOrder: number | null;
  projectionOwner?: ChapterProjectionOwner;
}): Promise<void> {
  if (typeof input.chapterOrder !== "number" || !Number.isFinite(input.chapterOrder)) {
    return;
  }
  const chapterOrder = input.chapterOrder;
  const rows = await prisma.payoffLedgerItem.findMany({
    where: { novelId: input.novelId },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (input.projectionOwner) {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.projectionOwner);
    }
    for (const row of rows) {
      if (
        row.currentStatus !== "pending_payoff"
        || typeof row.targetEndChapterOrder !== "number"
        || row.targetEndChapterOrder >= chapterOrder
      ) {
        continue;
      }
      const extended = applyGraceExtension({
        ledgerKey: row.ledgerKey,
        title: row.title,
        scopeType: row.scopeType,
        currentStatus: row.currentStatus,
        targetStartChapterOrder: row.targetStartChapterOrder,
        targetEndChapterOrder: row.targetEndChapterOrder,
        payoffChapterId: row.payoffChapterId,
        riskSignals: safeParseJson<PayoffLedgerRiskSignal[]>(row.riskSignalsJson, []),
        statusReason: row.statusReason,
      }, chapterOrder);
      if (extended.targetEndChapterOrder === row.targetEndChapterOrder) {
        continue;
      }
      await tx.payoffLedgerItem.update({
        where: { id: row.id },
        data: {
          targetStartChapterOrder: extended.targetStartChapterOrder ?? null,
          targetEndChapterOrder: extended.targetEndChapterOrder ?? null,
          riskSignalsJson: serializeLedgerJson(extended.riskSignals),
          updatedAt: now,
        },
      });
    }
  });
}
