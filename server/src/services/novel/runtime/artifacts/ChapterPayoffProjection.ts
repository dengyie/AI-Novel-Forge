import type { ChapterArtifactDeltaOutput } from "../../../../prompting/prompts/novel/chapterArtifactDelta.prompts";
import { prisma } from "../../../../db/prisma";
import {
  buildReopenedTerminalRiskSignal,
  clearStaleRiskSignal,
  dedupeRiskSignals,
  isTerminalPayoffStatus,
  resolvePayoffLedgerSyncLedgerKey,
  sanitizePayoffLedgerSyncItem,
  serializeLedgerJson,
} from "../../../payoff/payoffLedgerShared";
import { resolveSnapshotChapterReference } from "../../../state/StateService";
import {
  ChapterProjectionRevisionGuard,
  type ChapterProjectionOwner,
} from "../projections";
import {
  normalizeLedgerKey,
  type ChapterReference,
} from "./ChapterArtifactContracts";

export class ChapterPayoffProjection {
  async project(input: {
    owner: ChapterProjectionOwner;
    chapterOrder: number;
    chapterTitle: string;
    chapters: ChapterReference[];
    output: ChapterArtifactDeltaOutput;
    stateSnapshotId: string | null;
  }): Promise<number> {
    if (input.output.payoffDeltas.length === 0) {
      return 0;
    }
    const now = new Date();
    // 在事务外用顶层 prisma 拍快照，与 syncLedger 路径（PayoffLedgerSyncService.loadLedgerRows
    // 在 syncLedger 入口事务外加载）对齐：避免在 $transaction 内做全表 findMany 拖长事务持锁
    // 时间，且本小说全量账本行只读一次供 resolve + previous 查找复用。事务内 update/upsert
    // 不会回灌到 existingRows——这跟原事务内 findMany 的语义一致（existingRows 也是开事务时
    // 一次性拍的，后续 item 的写不更新快照），所以行为不变，只把读移出事务临界区。
    const existingRows = await prisma.payoffLedgerItem.findMany({
      where: { novelId: input.owner.novelId },
      include: { setupChapter: { select: { order: true } } },
    });
    await prisma.$transaction(async (tx) => {
      await new ChapterProjectionRevisionGuard(tx).lockCurrentForWrite(input.owner);
      for (const rawItem of input.output.payoffDeltas) {
        const fallbackKey = normalizeLedgerKey(rawItem.ledgerKey, normalizeLedgerKey(rawItem.title, `chapter_${input.chapterOrder}_payoff`));
        // 与 syncLedger 路径对齐：章节增量同样要过 overdue 误判清洗（审计伪项 / 无窗口 /
        // premature-overdue），否则 LLM 在章节产出里直接标 overdue 会绕过写入层守卫落库
        // （如 tujian_black_screen 窗口60-65 在 ch59 被标 overdue）。
        const item = sanitizePayoffLedgerSyncItem(rawItem, input.chapterOrder);
        // 跨 key 去重：把新 key 变体重映射到同窗口终态行（若有），让终态守卫生效。
        const ledgerKey = resolvePayoffLedgerSyncLedgerKey(
          { ...item, ledgerKey: fallbackKey },
          existingRows,
        );
        const previous = existingRows.find((row) => row.ledgerKey === ledgerKey) ?? null;
        // 终态保护：previous 已是 paid_off/failed 时，LLM 章节增量不得自动重开为 active 状态。
        // 保留终态项既有信号，仅追加 payoff_regressed 让人工可见，跳过 upsert。
        if (previous && isTerminalPayoffStatus(previous.currentStatus) && !isTerminalPayoffStatus(item.currentStatus)) {
          const previousSignals = ((): Array<{ code: string; severity: "low" | "medium" | "high" | "critical"; summary: string; stale?: boolean }> => {
            try {
              const parsed = previous.riskSignalsJson ? JSON.parse(previous.riskSignalsJson) : [];
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })();
          const protectedSignals = dedupeRiskSignals([
            ...previousSignals.filter((signal) => signal.code !== "payoff_regressed"),
            buildReopenedTerminalRiskSignal(previous.currentStatus, item.currentStatus),
          ]);
          await tx.payoffLedgerItem.update({
            where: { id: previous.id },
            data: {
              riskSignalsJson: serializeLedgerJson(protectedSignals),
              lastSnapshotId: input.stateSnapshotId ?? previous.lastSnapshotId ?? null,
              updatedAt: now,
            },
          });
          continue;
        }
        const setupChapterId = this.resolveChapterReference({
          value: item.setupChapterId ?? item.setupChapterOrder ?? item.firstSeenChapterOrder,
          chapters: input.chapters,
          currentChapterId: input.owner.chapterId,
          fallbackToCurrentChapter: item.currentStatus === "setup" || item.currentStatus === "hinted",
        }) ?? previous?.setupChapterId ?? null;
        const payoffChapterId = this.resolveChapterReference({
          value: item.payoffChapterId ?? item.payoffChapterOrder,
          chapters: input.chapters,
          currentChapterId: input.owner.chapterId,
          fallbackToCurrentChapter: item.currentStatus === "paid_off",
        }) ?? previous?.payoffChapterId ?? null;
        const lastTouchedChapterId = this.resolveChapterReference({
          value: item.lastTouchedChapterOrder,
          chapters: input.chapters,
          currentChapterId: input.owner.chapterId,
          fallbackToCurrentChapter: true,
        }) ?? input.owner.chapterId;
        const sourceRefs = item.sourceRefs.length > 0
          ? item.sourceRefs.map((ref) => ({
            ...ref,
            chapterId: ref.chapterId ?? lastTouchedChapterId,
            chapterOrder: ref.chapterOrder ?? input.chapterOrder,
          }))
          : [{
            kind: "chapter_payoff_ref" as const,
            refId: null,
            refLabel: `第${input.chapterOrder}章《${input.chapterTitle}》`,
            chapterId: input.owner.chapterId,
            chapterOrder: input.chapterOrder,
            volumeId: null,
            volumeSortOrder: null,
          }];
        const evidence = item.evidence.length > 0
          ? item.evidence.map((evidenceItem) => ({
            ...evidenceItem,
            chapterId: evidenceItem.chapterId ?? input.owner.chapterId,
            chapterOrder: evidenceItem.chapterOrder ?? input.chapterOrder,
          }))
          : [{
            summary: item.summary,
            chapterId: input.owner.chapterId,
            chapterOrder: input.chapterOrder,
          }];
        const riskSignals = clearStaleRiskSignal(dedupeRiskSignals(item.riskSignals.map((signal) => ({
          code: signal.code,
          severity: signal.severity,
          summary: signal.summary,
        }))));
        await tx.payoffLedgerItem.upsert({
          where: {
            novelId_ledgerKey: {
              novelId: input.owner.novelId,
              ledgerKey,
            },
          },
          create: {
            novelId: input.owner.novelId,
            ledgerKey,
            title: item.title,
            summary: item.summary,
            scopeType: item.scopeType,
            currentStatus: item.currentStatus,
            targetStartChapterOrder: item.targetStartChapterOrder ?? null,
            targetEndChapterOrder: item.targetEndChapterOrder ?? null,
            firstSeenChapterOrder: item.firstSeenChapterOrder ?? input.chapterOrder,
            lastTouchedChapterOrder: item.lastTouchedChapterOrder ?? input.chapterOrder,
            lastTouchedChapterId,
            setupChapterId,
            payoffChapterId,
            lastSnapshotId: input.stateSnapshotId,
            sourceRefsJson: serializeLedgerJson(sourceRefs),
            evidenceJson: serializeLedgerJson(evidence),
            riskSignalsJson: serializeLedgerJson(riskSignals),
            statusReason: item.statusReason?.trim() || null,
            confidence: item.confidence ?? null,
            updatedAt: now,
          },
          update: {
            title: item.title,
            summary: item.summary,
            scopeType: item.scopeType,
            currentStatus: item.currentStatus,
            targetStartChapterOrder: item.targetStartChapterOrder ?? null,
            targetEndChapterOrder: item.targetEndChapterOrder ?? null,
            firstSeenChapterOrder: item.firstSeenChapterOrder ?? previous?.firstSeenChapterOrder ?? input.chapterOrder,
            lastTouchedChapterOrder: item.lastTouchedChapterOrder ?? input.chapterOrder,
            lastTouchedChapterId,
            setupChapterId,
            payoffChapterId,
            lastSnapshotId: input.stateSnapshotId ?? previous?.lastSnapshotId ?? null,
            sourceRefsJson: serializeLedgerJson(sourceRefs),
            evidenceJson: serializeLedgerJson(evidence),
            riskSignalsJson: serializeLedgerJson(riskSignals),
            statusReason: item.statusReason?.trim() || null,
            confidence: item.confidence ?? null,
            updatedAt: now,
          },
        });
      }
    });
    return input.output.payoffDeltas.length;
  }

  private resolveChapterReference(input: {
    value: unknown;
    chapters: ChapterReference[];
    currentChapterId: string;
    fallbackToCurrentChapter: boolean;
  }): string | null {
    return resolveSnapshotChapterReference(input);
  }

}
