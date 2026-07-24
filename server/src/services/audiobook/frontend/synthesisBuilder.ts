/**
 * SynthesisBuilder —— L1 前端层：段级 delivery 编译的**唯一**入口。
 *
 * 设计纪律（对照 docs/plans/audiobook-synthesis-layering-refactor-design.md §4.2 / §7 M3）：
 *   - delivery 在这里编译**一次**：`compileDeliveryStyleForSegment` 是 style/designPrompt 的 SoT。
 *     废除 `resolveChunkSynthesizeFields` 的「剥已编译标记 + 重编」绕路所服务的多编译点问题
 *     （annotate / reconcile / chunk-synth 各编一次）——本重构后合成侧只有这一处编译。
 *   - `buildChunkSynthesisRequest` 把段的绑定视图 + 编译后的 style/design 装成 `SynthesisRequest`，
 *     delivery **消融**进 `voiceProfile.baseStyle/baseDesignPrompt`、`delivery` 置 null。
 *     M2 adapter 的 `req.delivery?.style ?? vp.baseStyle` 机械选取即得最终注入（零 adapter 改动）。
 *   - **M3 golden**：`compileDeliveryStyleForSegment` 与旧 `resolveChunkSynthesizeFields` 逐字段等价；
 *     `buildChunkSynthesisRequest` 经 M2 adapter 后的 style/designPrompt 与旧 `{ style, designPrompt }` 逐字节相同。
 *
 * 复用（不改）：peelCompiledDeliveryMarks / applyDeliveryToSegment / resolveSynthesizeInput 均在
 * `deliveryStyle.ts`。M5 VoiceResolver 收编 reconcile 后 base 天然干净，peel 分支届时一并删除。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §7 M3
 */

import { randomUUID } from "node:crypto";
import type { AudiobookDialogueSegment } from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  applyDeliveryToSegment,
  peelCompiledDeliveryMarks,
  resolveSynthesizeInput,
} from "../deliveryStyle";
import { resolveVoiceProfileForSegment } from "../voice/voiceResolver";
import type { SynthesisRequest } from "../engine/synthesisRequest";
import type { VoiceProfile } from "../voice/voiceProfile";

/**
 * 段 → TTS 最终注入的 style / designPrompt 唯一编译点。
 *
 * 语义（逐行对齐旧 `resolveChunkSynthesizeFields`，零行为变更）：
 *   1) styleRaw/designRaw 探测是否含「本句表演：/本句叙述：/表演指令：」脏标记
 *   2) baseStyleClean = 优先 peel baseStyle；脏则 peel style；否则 base ?? style ?? null
 *      baseDesignClean = 优先 peel baseDesignPrompt；脏则 peel designPrompt；否则 base ?? design ?? null
 *   3) 无 delivery → 返回干净 base
 *   4) 有 delivery + narrator → applyDeliveryToSegment(mode: "all")，取 rebuilt.{style,designPrompt}
 *   5) 有 delivery + character → resolveSynthesizeInput(...)
 *
 * 供 `chunkLayoutFingerprint`（缓存 SoT）与 `buildChunkSynthesisRequest`（合成 SoT）共用，
 * 消灭「缓存 style 与 peel/recompile 后 TTS 注入漂移导致错误 skip/wipe」（D11）。
 */
export function compileDeliveryStyleForSegment(
  segment: AudiobookDialogueSegment,
): { style: string | null; designPrompt: string | null } {
  const styleRaw = typeof segment.style === "string" ? segment.style : "";
  const designRaw = typeof segment.designPrompt === "string" ? segment.designPrompt : "";
  const dirtyStyle = styleRaw.includes("本句表演：")
    || styleRaw.includes("本句叙述：")
    || styleRaw.includes("表演指令：");
  const dirtyDesign = designRaw.includes("表演指令：");

  const baseStyleClean = peelCompiledDeliveryMarks(segment.baseStyle)
    ?? (dirtyStyle
      ? peelCompiledDeliveryMarks(segment.style)
      : (segment.baseStyle ?? segment.style ?? null));
  const baseDesignClean = peelCompiledDeliveryMarks(segment.baseDesignPrompt)
    ?? (dirtyDesign
      ? peelCompiledDeliveryMarks(segment.designPrompt)
      : (segment.baseDesignPrompt ?? segment.designPrompt ?? null));

  if (!segment.delivery) {
    return {
      style: baseStyleClean,
      designPrompt: baseDesignClean,
    };
  }

  if (segment.speakerKind === "narrator") {
    const rebuilt = applyDeliveryToSegment(
      {
        ...segment,
        style: baseStyleClean,
        designPrompt: baseDesignClean,
      },
      segment.delivery,
      {
        deliveryStyleMode: "all",
        baseStyle: baseStyleClean,
        baseDesignPrompt: baseDesignClean,
      },
    );
    return {
      style: rebuilt.style ?? null,
      designPrompt: rebuilt.designPrompt ?? null,
    };
  }

  const resolved = resolveSynthesizeInput({
    ttsMode: segment.ttsMode,
    baseStyle: baseStyleClean,
    baseDesignPrompt: baseDesignClean,
    style: baseStyleClean,
    designPrompt: baseDesignClean,
    delivery: segment.delivery,
    text: segment.text,
  });
  return {
    style: resolved.style ?? null,
    designPrompt: resolved.designPrompt ?? null,
  };
}

/**
 * 段（reconcile 后绑定视图）+ chunk 文本 → SynthesisRequest。
 *
 * - L2 VoiceResolver 先冻结说话人为 `VoiceProfile`（mode/voice/ref/source…读侧一次解析）；
 * - style / designPrompt 由 `compileDeliveryStyleForSegment` 一次编译，覆盖进
 *   `voiceProfile.baseStyle/baseDesignPrompt`（delivery 消融进 base）；
 * - delivery 置 null（已编译完毕，不再二次触碰）——builder 是唯一编译点。
 */
export function buildChunkSynthesisRequest(input: {
  segment: AudiobookDialogueSegment;
  text: string;
  provider?: LLMProvider | null;
  /** 可选，用于调试关联；缺省生成 uuid */
  requestId?: string;
}): SynthesisRequest {
  const { segment, text } = input;
  const compiled = compileDeliveryStyleForSegment(segment);
  const voiceProfile: VoiceProfile = {
    ...resolveVoiceProfileForSegment(segment),
    // delivery 在此处编译一次进 base 字段（M3 消融），覆盖 resolver 给的干净 base
    baseStyle: compiled.style,
    baseDesignPrompt: compiled.designPrompt,
  };
  const engineParams: SynthesisRequest["engineParams"] = input.provider
    ? { provider: input.provider }
    : undefined;
  return {
    requestId: input.requestId ?? randomUUID(),
    text,
    voiceProfile,
    delivery: null,
    engineParams,
  };
}
