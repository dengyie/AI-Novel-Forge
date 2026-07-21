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
   * 批量写入事实条目。幂等设计：同一 novelId+chapterOrder+text 组合不重复插入。
   */
  async writeFacts(
    novelId: string,
    chapterOrder: number,
    items: NovelFactWriteItem[],
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    // 规范化 + 批次内去重：空白差异/批次内重复不再产生重复行
    const normalizedItems: NovelFactWriteItem[] = [];
    const seenInBatch = new Set<string>();
    for (const item of items) {
      const text = normalizeFactText(item.text);
      if (!text || seenInBatch.has(text)) {
        continue;
      }
      seenInBatch.add(text);
      normalizedItems.push({ ...item, text });
    }
    if (normalizedItems.length === 0) {
      return;
    }
    // 查出已存在的 text，避免重复
    const existing = await prisma.novelFactEntry.findMany({
      where: { novelId, chapterOrder },
      select: { text: true },
    });
    const existingTexts = new Set(existing.map((row) => normalizeFactText(row.text)));
    const toCreate = normalizedItems.filter((item) => !existingTexts.has(item.text));
    if (toCreate.length === 0) {
      return;
    }
    await prisma.novelFactEntry.createMany({
      data: toCreate.map((item) => ({
        novelId,
        chapterOrder,
        text: item.text,
        category: item.category,
        source: item.source ?? "auto",
      })),
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
    return [...olderMilestoneRows, ...recentMilestoneRows, ...recentStateRows].map(mapRow);
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
}

function mapRow(row: {
  id: string;
  novelId: string;
  chapterOrder: number;
  text: string;
  category: string;
  source: string;
  createdAt: Date;
}): NovelFactEntry {
  return {
    id: row.id,
    novelId: row.novelId,
    chapterOrder: row.chapterOrder,
    text: row.text,
    category: row.category as NovelFactCategory,
    source: row.source as NovelFactSource,
    createdAt: row.createdAt,
  };
}

export const novelFactService = new NovelFactService();
