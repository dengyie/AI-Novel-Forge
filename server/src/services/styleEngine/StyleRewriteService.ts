import type { StyleProfile } from "@ai-novel/shared/types/styleEngine";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runTextPrompt } from "../../prompting/core/promptRunner";
import { styleRewritePrompt } from "../../prompting/prompts/style/style.prompts";
import { buildWriterStyleContractText } from "./styleContractText";
import { StyleRuntimeResolver } from "./StyleRuntimeResolver";
import { buildAntiAiRuleDirectiveText, listPreviewAntiAiRules } from "./antiAiPreviewRules";

// Voice Calibration（借鉴 humanizer）：从 profile 的 language/rhythm/narrative rules 抽出
// 可读摘要，让 rewrite 不只是"去 AI 味"，而是对齐到目标文风的句式与节奏。
// profile 为空或规则全空时返回 undefined，rewrite 回退到纯去 AI 味行为。
export function buildVoiceProfileText(profile: StyleProfile | null): string | undefined {
  if (!profile) {
    return undefined;
  }
  const lines: string[] = [];
  const language = profile.languageRules;
  const rhythm = profile.rhythmRules;
  const narrative = profile.narrativeRules;

  if (language) {
    if (typeof language.summary === "string" && language.summary.trim()) {
      lines.push(`语言：${language.summary.trim()}`);
    }
    if (typeof language.register === "string" && language.register.trim()) {
      lines.push(`语域：${language.register.trim()}`);
    }
    if (typeof language.sentenceVariation === "string" && language.sentenceVariation.trim()) {
      lines.push(`句式变化：${language.sentenceVariation.trim()}`);
    }
    if (typeof language.roughness === "number") {
      lines.push(`粗粝度：${language.roughness}（0 最光滑，1 最粗糙）`);
    }
  }
  if (rhythm) {
    if (typeof rhythm.summary === "string" && rhythm.summary.trim()) {
      lines.push(`节奏：${rhythm.summary.trim()}`);
    }
    if (typeof rhythm.pace === "string" && rhythm.pace.trim()) {
      lines.push(`推进速度：${rhythm.pace.trim()}`);
    }
    if (typeof rhythm.paragraphDensity === "string" && rhythm.paragraphDensity.trim()) {
      lines.push(`段落密度：${rhythm.paragraphDensity.trim()}`);
    }
  }
  if (narrative) {
    if (typeof narrative.summary === "string" && narrative.summary.trim()) {
      lines.push(`叙事：${narrative.summary.trim()}`);
    }
    if (typeof narrative.endingStyle === "string" && narrative.endingStyle.trim()) {
      lines.push(`收尾方式：${narrative.endingStyle.trim()}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

interface RewriteInput {
  content: string;
  styleProfileId?: string;
  novelId?: string;
  chapterId?: string;
  /** 章节序号；开篇（≤3）时 style_contract 追加固定声线提示。 */
  chapterOrder?: number | null;
  taskStyleProfileId?: string;
  previewAntiAiRuleIds?: string[];
  issues: Array<{
    ruleName: string;
    excerpt: string;
    suggestion: string;
  }>;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

export class StyleRewriteService {
  private readonly resolver = new StyleRuntimeResolver();

  async rewrite(input: RewriteInput): Promise<{ content: string }> {
    const resolved = await this.resolver.resolve({
      styleProfileId: input.styleProfileId,
      novelId: input.novelId,
      chapterId: input.chapterId,
      taskStyleProfileId: input.taskStyleProfileId,
    });
    const previewRules = await listPreviewAntiAiRules(input.previewAntiAiRuleIds);
    const existingRuleIds = new Set(resolved.antiAiRules.map((rule) => rule.id));
    const extraPreviewRules = previewRules.filter((rule) => !existingRuleIds.has(rule.id));

    const issuesBlock = input.issues.map((issue, index) => (
      `${index + 1}. ${issue.ruleName}\n片段：${issue.excerpt}\n修正建议：${issue.suggestion}`
    )).join("\n\n");
    const styleContractText = [
      buildWriterStyleContractText(resolved.context.compiledBlocks?.contract ?? null, {
        chapterOrder: input.chapterOrder,
      }),
      buildAntiAiRuleDirectiveText(extraPreviewRules),
    ].filter(Boolean).join("\n\n");

    const voiceProfileText = buildVoiceProfileText(resolved.primaryProfile);

    const result = await runTextPrompt({
      asset: styleRewritePrompt,
      promptInput: {
        styleContractText,
        content: input.content,
        issuesBlock,
        voiceProfileText,
      },
      options: {
        provider: input.provider ?? "deepseek",
        model: input.model,
        temperature: input.temperature ?? 0.5,
      },
    });

    return {
      content: result.output.trim(),
    };
  }
}
