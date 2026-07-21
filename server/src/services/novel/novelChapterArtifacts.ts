import { prisma } from "../../db/prisma";
import { withSqliteRetry } from "../../db/sqliteRetry";
import { briefSummary, extractCharacterEventLines, extractFacts } from "./novelCoreShared";
import { queueRagUpsert } from "./novelCoreSupport";
import { chapterArtifactBackgroundSyncService } from "./runtime/ChapterArtifactBackgroundSyncService";

export async function syncCharacterTimelineForChapter(novelId: string, chapterId: string, content: string) {
  const [chapter, characters] = await Promise.all([
    prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { order: true, title: true },
    }),
    prisma.character.findMany({
      where: { novelId },
      select: { id: true, name: true },
    }),
  ]);

  if (!chapter || characters.length === 0) {
    return;
  }

  const events: Array<{
    novelId: string;
    characterId: string;
    chapterId: string;
    chapterOrder: number;
    title: string;
    content: string;
    source: string;
  }> = [];

  for (const character of characters) {
    const lines = extractCharacterEventLines(content, character.name, 3);
    for (const line of lines) {
      events.push({
        novelId,
        characterId: character.id,
        chapterId,
        chapterOrder: chapter.order,
        title: `${chapter.order} · ${chapter.title}`,
        content: line,
        source: "chapter_extract",
      });
    }
  }

  await withSqliteRetry(
    () => prisma.$transaction(async (tx) => {
      await tx.characterTimeline.deleteMany({
        where: {
          novelId,
          chapterId,
          source: "chapter_extract",
        },
      });
      if (events.length > 0) {
        await tx.characterTimeline.createMany({ data: events });
      }
    }),
    { label: "novelChapterArtifacts.characterTimeline" },
  );

  const timelines = await prisma.characterTimeline.findMany({
    where: {
      novelId,
      chapterId,
      source: "chapter_extract",
    },
    select: { id: true },
  });

  for (const timeline of timelines) {
    queueRagUpsert("character_timeline", timeline.id);
  }
}

export async function syncChapterArtifacts(novelId: string, chapterId: string, content: string) {
  const facts = extractFacts(content);
  const summary = briefSummary(content, facts);

  await withSqliteRetry(
    () => prisma.$transaction(async (tx) => {
      // regex 摘要仅作 fallback：仅当现有 summary 为空（或无记录）时写入，
      // 避免 CRUD 正文保存把后台/手动生成的 LLM 摘要降级为正则截断版。
      // LLM 摘要路径见 NovelChapterSummaryService.generateChapterSummary。
      const existingSummary = await tx.chapterSummary.findUnique({
        where: { chapterId },
        select: { summary: true },
      });
      const keyEvents = facts.map((item) => item.content).slice(0, 3).join("");
      const characterStates = facts
        .filter((item) => item.category === "character")
        .map((item) => item.content)
        .slice(0, 3)
        .join("");
      if (existingSummary) {
        await tx.chapterSummary.update({
          where: { chapterId },
          data: {
            ...(existingSummary.summary.trim() ? {} : { summary }),
            keyEvents,
            characterStates,
          },
        });
      } else {
        await tx.chapterSummary.create({
          data: {
            novelId,
            chapterId,
            summary,
            keyEvents,
            characterStates,
          },
        });
      }

      await tx.consistencyFact.deleteMany({ where: { novelId, chapterId } });
      if (facts.length > 0) {
        await tx.consistencyFact.createMany({
          data: facts.map((item) => ({
            novelId,
            chapterId,
            category: item.category,
            content: item.content,
            source: "chapter_auto_extract",
          })),
        });
      }
    }),
    { label: "novelChapterArtifacts.summaryAndFacts" },
  );

  await syncCharacterTimelineForChapter(novelId, chapterId, content);
  chapterArtifactBackgroundSyncService.scheduleChapterSync(novelId, chapterId, content);

  // 人工正文保存后，既有非空摘要（多为 LLM 摘要）已与正文脱节，且无自动重生成路径。
  // 写 riskFlags.chapterSummaryStale 让债板/UI 可见，用户可一键重生成（生成时清标）。
  // best-effort：失败只告警，不阻断保存主路径。
  try {
    const existing = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { riskFlags: true },
    });
    let parsed: Record<string, unknown> = {};
    if (existing?.riskFlags?.trim()) {
      try {
        const value = JSON.parse(existing.riskFlags) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        parsed = {};
      }
    }
    await prisma.chapter.update({
      where: { id: chapterId },
      data: {
        riskFlags: JSON.stringify({
          ...parsed,
          chapterSummaryStale: {
            at: new Date().toISOString(),
            reason: "manual_content_saved",
          },
        }),
      },
    });
  } catch (error) {
    console.warn("[novel-artifacts] persist summary-stale riskFlag failed", {
      novelId,
      chapterId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  queueRagUpsert("chapter", chapterId);
  queueRagUpsert("chapter_summary", chapterId);
  queueRagUpsert("novel", novelId);

  const factRows = await prisma.consistencyFact.findMany({
    where: { novelId, chapterId },
    select: { id: true },
  });
  for (const fact of factRows) {
    queueRagUpsert("consistency_fact", fact.id);
  }

}
