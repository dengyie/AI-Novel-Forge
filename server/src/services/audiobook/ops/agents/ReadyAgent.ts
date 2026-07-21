/**
 * ReadyAgent（角色音色就绪，§3.2）。
 *
 * 流程：
 *  1. audiobookVoiceReadinessService.assess(novelId) 扫 missing/invalid
 *  2. audiobookVoiceAssetService.suggest(novelId, { planStrategy: "prefer_library" })
 *  3. audiobookVoiceAssetService.apply(novelId, { items, overwrite: false })
 *     - 优先 apply clone；无 clone 时默认 apply design/preset（全自动配齐）
 *     - 拒绝 apply draft 资产：suggest 仅给 approved，apply 内部已断（voiceLibraryService.assertBindableCloneRef）
 *
 * 输出 ReadyReport（planned/bound/failed/skipped + 各角色 reason）
 *
 * P3「批量 preview 生成」与 P5「design preview 再跑轻量 Ear」留 backlog（§K），
 * 本 Agent 先做不可逆性最小的「规划 + bind approved」一环。
 */
import { audiobookVoiceReadinessService } from "../../AudiobookVoiceReadinessService";
import { audiobookVoiceAssetService } from "../../AudiobookVoiceAssetService";
import type {
  AudiobookVoicePlanApplyResult,
  AudiobookVoicePlanSuggestInput,
  AudiobookVoicePlanSuggestResult,
  AudiobookVoiceReadinessSummary,
} from "@ai-novel/shared/types/audiobook";

export interface ReadyAgentRunInput {
  novelId: string;
  planStrategy?: "auto" | "preset_only" | "prefer_design" | "prefer_library" | "prefer_library_ai";
  /** 阶段 1 dry-run 不 apply，只列 planned */
  dryRun?: boolean;
  /** true=无 clone 时也 apply design/preset（全自动配齐，默认 true） */
  applyDesignFallback?: boolean;
}

export interface ReadyReport {
  novelId: string;
  readiness: AudiobookVoiceReadinessSummary | null;
  planned: number;
  bound: number;
  failed: number;
  skipped: number;
  perCharacter: Array<{
    characterId: string;
    action: "bind" | "skip" | "fail";
    reason: string;
  }>;
}

export class ReadyAgent {
  async run(input: ReadyAgentRunInput): Promise<ReadyReport> {
    const novelId = input.novelId;
    let readiness: AudiobookVoiceReadinessSummary | null = null;
    try {
      readiness = await audiobookVoiceReadinessService.assess(novelId, {});
    } catch (err) {
      // assess 失败不阻断 suggest/apply；记 reason
      readiness = null;
    }

    const suggest = await audiobookVoiceAssetService.suggest(novelId, {
      strategy: input.planStrategy ?? "prefer_library",
    } satisfies AudiobookVoicePlanSuggestInput);

    const applyDesignFallback = input.applyDesignFallback !== false;
    const perCharacter: ReadyReport["perCharacter"] = [];
    let planned = 0;
    let bound = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of suggest.items) {
      planned += 1;
      const isClone = item.ttsMode === "clone" && Boolean(item.ttsVoiceAssetId?.trim());
      const isDesign = item.ttsMode === "design" && Boolean(item.ttsDesignPrompt?.trim());
      const isPreset = item.ttsMode === "preset" && Boolean(item.ttsVoice?.trim());
      if (!isClone && !(applyDesignFallback && (isDesign || isPreset))) {
        perCharacter.push({
          characterId: item.characterId,
          action: "skip",
          reason: `无可 apply 负载（ttsMode=${item.ttsMode}）`,
        });
        skipped += 1;
        continue;
      }
      if (input.dryRun) {
        perCharacter.push({
          characterId: item.characterId,
          action: "skip",
          reason: isClone
            ? "dry-run：仅 suggest 不 apply（clone）"
            : `dry-run：仅 suggest 不 apply（${item.ttsMode} fallback）`,
        });
        skipped += 1;
        continue;
      }
      try {
        const apply = await audiobookVoiceAssetService.apply(novelId, {
          items: [
            {
              characterId: item.characterId,
              ttsMode: item.ttsMode,
              ttsVoiceAssetId: item.ttsVoiceAssetId,
              ttsVoice: item.ttsVoice ?? null,
              ttsStyle: item.ttsStyle ?? null,
              ttsDesignPrompt: item.ttsDesignPrompt ?? null,
              speakerAliases: item.speakerAliases ?? null,
            },
          ],
          overwrite: false,
        });
        const applied = apply.applied.find((a: AudiobookVoicePlanApplyResult["applied"][number]) => a.characterId === item.characterId);
        if (applied) {
          const reason = isClone
            ? `approved 库 bind (ttsVoiceAssetId=${applied.ttsVoiceAssetId ?? "?"})`
            : `auto apply ${item.ttsMode}（全自动配齐 fallback）`;
          perCharacter.push({ characterId: item.characterId, action: "bind", reason });
          bound += 1;
        } else {
          const skippedEntry = apply.skipped.find((s) => s.characterId === item.characterId);
          perCharacter.push({ characterId: item.characterId, action: "skip", reason: skippedEntry?.reason ?? "apply 跳过" });
          skipped += 1;
        }
      } catch (err) {
        perCharacter.push({
          characterId: item.characterId,
          action: "fail",
          reason: err instanceof Error ? err.message : String(err),
        });
        failed += 1;
      }
    }

    return {
      novelId,
      readiness,
      planned,
      bound,
      failed,
      skipped,
      perCharacter,
    };
  }
}

export const readyAgent = new ReadyAgent();
