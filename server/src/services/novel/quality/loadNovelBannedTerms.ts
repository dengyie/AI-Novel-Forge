import { extractSotBannedTermsFromNovel } from "@ai-novel/shared/types/sotBannedTerms";
import { extractBannedTermsFromStyleToneSafe } from "@ai-novel/shared/types/styleToneBannedTerms";
import { prisma } from "../../../db/prisma";

/**
 * 书级禁词统一加载入口（F5，消除漂移）。
 *
 * 「生成 prompt 禁的词」与「评价 penalize 的词」必须是同一来源：都以
 *   SoT（storyWorldSliceJson / storyWorldSliceOverridesJson）∪ styleTone（SOP 常驻 + 显式声明）
 * 的并集为准。本函数是唯一在 novelId → 禁词数组 这一层合并的地方；
 * 生成侧（chapterWriterGraph）与评价侧（detectProseQuality 的 bannedTerms 喂入）
 * 都从这里取，永不漂移。
 *
 * fail (novel)：novel 不存在 / 读取异常 → 空表或纯 SOP 常驻集，绝不 throw、绝不因此阻断写章。
 *
 * 语义契约（与 ChapterQualityProjectionService 原实现逐行一致）：
 *  - novel 行存在 → SoT ∪ StyleToneSafe（并集，去重）。
 *  - novel 行不存在 → extractSotBannedTermsFromNovel(null)=[] ∪
 *    extractBannedTermsFromStyleToneSafe(null)=SOP 常驻集。保持该既有新鲜语义，
 *    不因抽函数引入行为漂移。
 */
export async function loadNovelBannedTerms(novelId: string): Promise<string[]> {
  try {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        storyWorldSliceJson: true,
        storyWorldSliceOverridesJson: true,
        styleTone: true,
      },
    });
    const seen = new Set<string>();
    return [
      ...extractSotBannedTermsFromNovel(novel),
      ...extractBannedTermsFromStyleToneSafe(novel),
    ].filter((term) => {
      if (seen.has(term)) {
        return false;
      }
      seen.add(term);
      return true;
    });
  } catch (error) {
    console.warn("[quality] load novel banned terms failed; treating as empty", {
      novelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
