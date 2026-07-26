import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { buildNGramSet, hasSufficientSimilarityLength, jaccardSimilarity } from "@ai-novel/shared/utils/textSimilarity";
import { prisma } from "../../../db/prisma";
import { runTextPrompt } from "../../../prompting/core/promptRunner";
import { openingDiversityRewritePrompt } from "../../../prompting/prompts/novel/openingDiversity.prompts";
import {
  getChapterWriterRuntimeSettings,
  type ChapterWriterRuntimeSettings,
} from "../../settings/ChapterWriterRuntimeSettingsService";

/**
 * 章首多样性默认实现：防止连续 N 章开篇雷同（节奏/措辞重复）。
 *
 * 设计口径（与用户产品确认）：
 * - 相似源：本章前 ~300 字 n-gram（复用 continuation 同源 jaccard）。
 * - 参考集：最近 N 章已生成章节的章首 openingChars 字（默认 N=5）。
 * - 命中处置：超阈值则对"整章"做 LLM 重写，仅当重写后章首相对参考集的相似度真正下降才接受；
 *   不达标即回退原文，rewritten=false / 透传 maxSimilarity（同 NovelContinuationService
 *   rewriteIfTooSimilar 三段式：阈值 → 改写 → 防回归）。
 * - 边界：order<=1（序章/第一章，无已生成前置章）直接 passthrough。
 *
 * 复用策略：
 * - n-gram / jaccard / normalizeForSimilarity 抽自 shared/utils/textSimilarity（与
 *   NovelContinuationService 续写 anti-copy 同源），不再本模块本地维护。
 * - 重写提示词为本模块专属 opening rewrite 资产（章首语义，区别于 continuation 的"避开原文桥段"）。
 * - recentWindow / openingChars / similarityThreshold 已迁入 AppSetting（ChapterWriterRuntimeSettings），
 *   每次调用现读库值以支持热调；显式 options 仍优先于库值，便于单测固定参数。
 *
 * 回滚定位：本模块由 ChapterRuntimeCoordinator.createDefaultChapterWritingGraph 作为
 * enforceOpeningDiversity 注入；任意annoymous-deps 消费方仍走 no-op（注入点显式覆写）。
 */

export interface OpeningDiversityGuardOptions {
  /** 参考集窗口大小：最近 N 章已生成前置章节。省略则按调用时 AppSetting 值（出厂默认 5）。 */
  recentWindow?: number;
  /** 章首相似比较的字数窗口。省略则按调用时 AppSetting 值（出厂默认 300）。 */
  openingChars?: number;
  /** 触发改写的相似度阈值。省略则按调用时 AppSetting 值（出厂默认 0.3，同 continuationService）。 */
  similarityThreshold?: number;
  /**
   * 运行时设置加载器（默认读 AppSetting，热调生效）。仅测试注入用；
   * 上面三个显式字段若给出则优先于 settings，便于单测固定参数。
   */
  loadSettings?: () => Promise<ChapterWriterRuntimeSettings>;
}

export interface OpeningDiversityGuardResult {
  content: string;
  rewritten: boolean;
  maxSimilarity: number;
}

interface RewriteOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

const DEFAULT_RECENT_WINDOW = 5;
const DEFAULT_OPENING_CHARS = 300;
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
const MIN_OPENING_CHARS = 32;

function sliceOpening(content: string | null | undefined, openingChars: number): string {
  if (!content) {
    return "";
  }
  const text = content.trim();
  if (text.length <= openingChars) {
    return text;
  }
  // 章首窗口：截前 openingChars 个字符，尽量在句末/空格处收口避免半句。
  const slice = text.slice(0, openingChars);
  const lastSentenceStop = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("\n"),
  );
  if (lastSentenceStop >= Math.floor(openingChars * 0.6)) {
    return slice.slice(0, lastSentenceStop + 1);
  }
  return slice;
}

/**
 * 构造默认 enforceOpeningDiversity 实现：读最近 N 章前置章节开篇做 n-gram jaccard，
 * 超阈值则整章重写（防回归：仅当重写后相似度真正下降才接受）。
 */
export function createDefaultOpeningDiversityGuard(
  options: OpeningDiversityGuardOptions = {},
): (
  novelId: string,
  chapterOrder: number,
  chapterTitle: string,
  content: string,
  llmOptions: RewriteOptions,
) => Promise<OpeningDiversityGuardResult> {
  const loadSettings = options.loadSettings ?? getChapterWriterRuntimeSettings;

  return async (_novelId, chapterOrder, chapterTitle, content, llmOptions) => {
    const targetText = content.trim();
    if (!targetText || chapterOrder <= 1) {
      // 无正文或序章/第一章：无前置已生成参考集，不参与开篇多样性判定。
      // 在这里短路，避免对 passthrough 章节多做一次 AppSetting 读取。
      return { content, rewritten: false, maxSimilarity: 0 };
    }

    // 按调用读 AppSetting：显式 options 优先（测试固定），否则取运行时设置，最后兜底 DEFAULT。
    const settings = await loadSettings();
    const recentWindow = Math.max(1, options.recentWindow ?? settings.openingDiversityRecentWindow ?? DEFAULT_RECENT_WINDOW);
    const openingChars = Math.max(MIN_OPENING_CHARS, options.openingChars ?? settings.openingDiversityOpeningChars ?? DEFAULT_OPENING_CHARS);
    const similarityThreshold = options.similarityThreshold ?? settings.openingDiversitySimilarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

    const recentChapters = await prisma.chapter.findMany({
      where: {
        novelId: _novelId,
        order: { lt: chapterOrder },
        content: { not: null },
      },
      select: { content: true, order: true },
      orderBy: { order: "desc" },
      take: recentWindow,
    });

    const corpus = recentChapters
      .map((row) => sliceOpening(row.content, openingChars))
      .filter((snippet) => hasSufficientSimilarityLength(snippet));

    if (corpus.length === 0) {
      return { content, rewritten: false, maxSimilarity: 0 };
    }

    const targetOpening = sliceOpening(targetText, openingChars);
    const targetNgrams = buildNGramSet(targetOpening);
    let maxSimilarity = 0;
    let mostSimilarOpening = "";
    for (const snippet of corpus) {
      const similarity = jaccardSimilarity(targetNgrams, buildNGramSet(snippet));
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarOpening = snippet;
      }
    }

    if (maxSimilarity < similarityThreshold) {
      return { content, rewritten: false, maxSimilarity };
    }

    try {
      const rewritten = await runTextPrompt({
        asset: openingDiversityRewritePrompt,
        promptInput: {
          chapterTitle,
          mostSimilarOpening,
          targetText,
        },
        options: {
          provider: llmOptions.provider ?? "deepseek",
          model: llmOptions.model,
          temperature: llmOptions.temperature ?? 0.7,
          signal: llmOptions.signal,
        },
      });
      const rewrittenText = rewritten.output.trim();
      if (!rewrittenText) {
        return { content, rewritten: false, maxSimilarity };
      }
      const rewrittenOpening = sliceOpening(rewrittenText, openingChars);
      const rewrittenNgrams = buildNGramSet(rewrittenOpening);
      const rewrittenSimilarity = corpus.reduce((max, snippet) => {
        const similarity = jaccardSimilarity(rewrittenNgrams, buildNGramSet(snippet));
        return Math.max(max, similarity);
      }, 0);
      // 防回归：重写后相似度未真正下降 → 回退原文，不无效扰动、不退化文本。
      if (rewrittenSimilarity >= maxSimilarity) {
        return { content, rewritten: false, maxSimilarity };
      }
      return { content: rewrittenText, rewritten: true, maxSimilarity: rewrittenSimilarity };
    } catch {
      return { content, rewritten: false, maxSimilarity };
    }
  };
}
