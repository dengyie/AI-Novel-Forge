import { createHash } from "node:crypto";
import { prisma } from "../../../db/prisma";

export type NovelFactCategory = "completed" | "revealed" | "state_changed";
export type NovelFactSource = "auto" | "manual";

/**
 * completed/revealed 里程碑事实的注入上限：优先保留最近
 * MILESTONE_RECENT_CHAPTERS_WINDOW 章内的全部条目，超出部分按章节序
 * 截取到 MILESTONE_DEFENSIVE_TAKE 防御上限，避免长篇后期事实账本
 * 无界膨胀打爆写章 prompt 预算。
 */
const MILESTONE_RECENT_CHAPTERS_WINDOW = 30;
const MILESTONE_DEFENSIVE_TAKE = 200;

/**
 * 事实文本规范化：压缩空白，供去重比较与落库。
 */
function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface NovelFactWriteItem {
  text: string;
  category: NovelFactCategory;
  source?: NovelFactSource;
}

export interface NovelFactEntry {
  id: string;
  novelId: string;
  chapterOrder: number;
  chapterId: string | null;
  contentRevision: number | null;
  text: string;
  category: NovelFactCategory;
  source: NovelFactSource;
  createdAt: Date;
}

/**
 * 事实账本服务
 *
 * 记录小说中已发生的不可逆事实（过程性目标完成、信息揭示、状态变化），
 * 供写章上下文消费，防止 LLM 重复写出已发生的事件。
 *
 * 写入方：ChapterContentFinalizationService（章节接收后自动写入）
 * 读取方：GenerationContextAssembler（填充 completedMilestones 字段）
 */
export class NovelFactService {
  /**
   * 写入某一正文 revision 的自动事实。
   *
   * 更高 revision 只清理更低 revision 与迁移前无 ownership 的自动事实；不会清理未来
   * revision，也不会触碰 manual。这样即使旧异步任务晚到，也不能删除新正文的事实。
   * idempotencyKey 的数据库唯一索引负责并发/重试去重。
   */
  async writeChapterFacts(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    contentRevision: number;
    items: NovelFactWriteItem[];
  }): Promise<void> {
    // 规范化 + 批次内去重：空白差异/批次内重复不再产生重复行
    const normalizedItems: NovelFactWriteItem[] = [];
    const seenInBatch = new Set<string>();
    for (const item of input.items) {
      const text = normalizeFactText(item.text);
      if (!text || seenInBatch.has(text)) {
        continue;
      }
      seenInBatch.add(text);
      normalizedItems.push({ ...item, text });
    }
    await prisma.$transaction(async (tx) => {
      await tx.novelFactEntry.deleteMany({
        where: {
          novelId: input.novelId,
          source: "auto",
          OR: [
            {
              chapterId: input.chapterId,
              contentRevision: { lt: input.contentRevision },
            },
            {
              chapterId: null,
              chapterOrder: input.chapterOrder,
            },
          ],
        },
      });
      if (normalizedItems.length === 0) return;
      for (const item of normalizedItems) {
        const data = {
          novelId: input.novelId,
          chapterId: input.chapterId,
          chapterOrder: input.chapterOrder,
          contentRevision: input.contentRevision,
          text: item.text,
          category: item.category,
          source: "auto",
          idempotencyKey: createHash("sha256")
            .update([
              input.novelId,
              input.chapterId,
              String(input.contentRevision),
              item.text,
            ].join("\u0000"))
            .digest("hex"),
        };
        await tx.novelFactEntry.upsert({
          where: { idempotencyKey: data.idempotencyKey },
          update: {},
          create: data,
        });
      }
    });
  }

  /**
   * 读取当前章节之前的事实，用于填充写章上下文。
   *
   * - completed/revealed：里程碑性事实。最近 milestoneRecentWindow 章内全量保留；
   *   更早的按章节序截取到 milestoneMaxTake 防御上限，防止长篇后期无界注入。
   * - state_changed：只返回最近 recentChaptersWindow 章内的条目
   */
  async listForChapter(input: {
    novelId: string;
    beforeChapterOrder: number;
    recentChaptersWindow?: number;
    milestoneRecentWindow?: number;
    milestoneMaxTake?: number;
  }): Promise<NovelFactEntry[]> {
    const {
      novelId,
      beforeChapterOrder,
      recentChaptersWindow = 15,
      milestoneRecentWindow = MILESTONE_RECENT_CHAPTERS_WINDOW,
      milestoneMaxTake = MILESTONE_DEFENSIVE_TAKE,
    } = input;
    // 里程碑事实分两路：最近窗口内全量保留；更早的按章节从新到旧取防御上限。
    const recentMilestoneRows = await prisma.novelFactEntry.findMany({
      where: {
        novelId,
        chapterOrder: {
          lt: beforeChapterOrder,
          gte: beforeChapterOrder - milestoneRecentWindow,
        },
        category: { in: ["completed", "revealed"] },
      },
      orderBy: { chapterOrder: "asc" },
    });
    const olderMilestoneRows = await prisma.novelFactEntry.findMany({
      where: {
        novelId,
        chapterOrder: { lt: beforeChapterOrder - milestoneRecentWindow },
        category: { in: ["completed", "revealed"] },
      },
      orderBy: [{ chapterOrder: "desc" }, { createdAt: "desc" }],
      take: Math.max(milestoneMaxTake - recentMilestoneRows.length, 0),
    });
    // 早期事实按章节从新到旧截取后，恢复章节升序供 prompt 消费
    olderMilestoneRows.sort((left, right) => left.chapterOrder - right.chapterOrder);
    const recentStateRows = await prisma.novelFactEntry.findMany({
      where: {
        novelId,
        chapterOrder: {
          lt: beforeChapterOrder,
          gte: beforeChapterOrder - recentChaptersWindow,
        },
        category: "state_changed",
      },
      orderBy: { chapterOrder: "asc" },
    });
    const canonicalRows = await this.filterCanonicalAutomaticFacts([
      ...olderMilestoneRows,
      ...recentMilestoneRows,
      ...recentStateRows,
    ]);
    return canonicalRows.map(mapRow);
  }

  /**
   * 手动写入单条事实（供 Agent 工具调用）
   */
  async addManualFact(input: {
    novelId: string;
    chapterOrder: number;
    text: string;
    category: NovelFactCategory;
  }): Promise<NovelFactEntry> {
    const row = await prisma.novelFactEntry.create({
      data: {
        novelId: input.novelId,
        chapterOrder: input.chapterOrder,
        text: input.text.trim(),
        category: input.category,
        source: "manual",
      },
    });
    return mapRow(row);
  }

  private async filterCanonicalAutomaticFacts<T extends {
    source: string;
    chapterId: string | null;
    contentRevision: number | null;
  }>(rows: T[]): Promise<T[]> {
    const ownedChapterIds = Array.from(new Set(rows
      .filter((row) => row.source === "auto" && row.chapterId && row.contentRevision != null)
      .map((row) => row.chapterId as string)));
    if (ownedChapterIds.length === 0) return rows;
    const chapters = await prisma.chapter.findMany({
      where: { id: { in: ownedChapterIds } },
      select: { id: true, contentRevision: true },
    });
    const currentRevisionByChapterId = new Map(
      chapters.map((chapter) => [chapter.id, chapter.contentRevision]),
    );
    return rows.filter((row) => (
      row.source !== "auto"
      || row.chapterId == null
      || row.contentRevision == null
      || currentRevisionByChapterId.get(row.chapterId) === row.contentRevision
    ));
  }
}

function mapRow(row: {
  id: string;
  novelId: string;
  chapterOrder: number;
  chapterId: string | null;
  contentRevision: number | null;
  text: string;
  category: string;
  source: string;
  createdAt: Date;
}): NovelFactEntry {
  return {
    id: row.id,
    novelId: row.novelId,
    chapterOrder: row.chapterOrder,
    chapterId: row.chapterId,
    contentRevision: row.contentRevision,
    text: row.text,
    category: row.category as NovelFactCategory,
    source: row.source as NovelFactSource,
    createdAt: row.createdAt,
  };
}

export const novelFactService = new NovelFactService();
