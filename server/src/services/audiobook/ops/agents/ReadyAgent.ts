/**
 * ReadyAgent（角色音色就绪，§3.2）。
 *
 * 流程：
 *  1. audiobookVoiceReadinessService.assess(novelId) 扫 missing/invalid
 *  2. audiobookVoiceAssetService.suggest(novelId, { planStrategy: "prefer_library" })
 *  3. audiobookVoiceAssetService.apply(novelId, { items, overwrite: false })
 *     - 仅 apply ttsMode==="clone" 且 ttsVoiceAssetId 非 null 的项（库绑库）
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
  planStrategy?: "auto" | "preset_only" | "prefer_design" | "prefer_library";
  /** 阶段 1 dry-run 不 apply，只列 planned */
  dryRun?: boolean;
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

    const perCharacter: ReadyReport["perCharacter"] = [];
    let planned = 0;
    let bound = 0;
    let failed = 0;
    let skipped = 0;

    for (const item of suggest.items) {
      planned += 1;
      // 仅 clone + 带 ttsVoiceAssetId 的项才 apply；其他（design/preset）留后续 Ready 阶段或人工
      if (item.ttsMode !== "clone" || !item.ttsVoiceAssetId) {
        perCharacter.push({ characterId: item.characterId, action: "skip", reason: `非 clone 库绑（ttsMode=${item.ttsMode}）` });
        skipped += 1;
        continue;
      }
      if (input.dryRun) {
        perCharacter.push({ characterId: item.characterId, action: "skip", reason: "dry-run：仅 suggest 不 apply" });
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
          perCharacter.push({ characterId: item.characterId, action: "bind", reason: `approved 库 bind (ttsVoiceAssetId=${applied.ttsVoiceAssetId ?? "?"})` });
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
