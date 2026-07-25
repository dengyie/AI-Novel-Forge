/**
 * SynthesisBuilder —— L1 前端层：段级 delivery 编译的**唯一**入口。
 *
 * 设计纪律（对照 docs/plans/audiobook-synthesis-layering-refactor-design.md §4.2 / §7 M3 / M9）：
 *   - delivery 在这里编译**一次**：`compileDeliveryStyleForSegment` 是 style/designPrompt 的 SoT。
 *   - `buildChunkSynthesisRequest` 把段的绑定视图 + 编译后的 style/design 装成 `SynthesisRequest`，
 *     delivery **消融**进 `voiceProfile.baseStyle/baseDesignPrompt`、`delivery` 置 null。
 *   - **M9 clean-base 契约**：annotate / ruleAssembly / channelRepair / reconcile 写路径已 peel，
 *     `baseStyle`/`baseDesignPrompt` 生产侧默认干净。本函数**信任 base**；仅在缺 base 且
 *     style/design 含「本句表演/叙述/指令」时，对脏 style 做兼容 peel（旧 annotations / 脏卡）。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §7 M3/M9
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
 * M9 语义（信任 clean base，兼容旧脏输入）：
 *   1) 有 baseStyle → 直接信任（写路径已 peel）；若 base 本身脏（旧 annotations）仍 peel
 *   2) 无 baseStyle 且 style 脏 → peel style 作 base（旧数据兼容）
 *   3) 否则 base ?? style
 *   design 同理
 *   4) 无 delivery → 返回干净 base
 *   5) 有 delivery + narrator → applyDeliveryToSegment(mode: "all")
 *   6) 有 delivery + character → resolveSynthesizeInput(...)
 *
 * 供 `chunkLayoutFingerprint`（缓存 SoT）与 `buildChunkSynthesisRequest`（合成 SoT）共用。
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

  // 信任 base；仅当 base 自身含脏标记（旧 annotations / 脏卡漏 peel）时再 peel。
  // 无 base 时：脏 style 兼容 peel，否则透传 style。
  const hasBaseStyle = segment.baseStyle != null && String(segment.baseStyle).trim() !== "";
  const hasBaseDesign =
    segment.baseDesignPrompt != null && String(segment.baseDesignPrompt).trim() !== "";
  const baseStyleClean = hasBaseStyle
    ? peelCompiledDeliveryMarks(segment.baseStyle)
    : (dirtyStyle
      ? peelCompiledDeliveryMarks(segment.style)
      : (segment.style ?? null));
  const baseDesignClean = hasBaseDesign
    ? peelCompiledDeliveryMarks(segment.baseDesignPrompt)
    : (dirtyDesign
      ? peelCompiledDeliveryMarks(segment.designPrompt)
      : (segment.designPrompt ?? null));

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
