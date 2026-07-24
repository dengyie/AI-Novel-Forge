/**
 * legacyRequestBridge —— M2 过渡桥：把旧三处直连的散字段包成 `SynthesisRequest`。
 *
 * **仅用于 M2**：让 pipeline / preview 两处站点能立刻改走 `getEngine("mimo").synthesize(req)`，
 * 同时保持与旧 `mimoChatAudioTTSProvider.synthesize(...)` 请求体逐字节等价（golden）。
 *
 * VoiceProfile 里 speakerKey/speakerLabel/source/speakerKind/characterId 等审计字段是
 * 请求体**外**的元数据（M6 才进指纹）。此桥填 `"legacy"` 占位；M5 VoiceResolver 落地后，
 * 三处站点会改由 VoiceResolver 产出的真正 VoiceProfile 驱动，本文件同 M5 删除。
 *
 * SoT: docs/plans/audiobook-synthesis-layering-refactor-design.md §7 M2
 */

import { randomUUID } from "node:crypto";
import type { AudiobookTtsMode } from "@ai-novel/shared/types/audiobook";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { VoiceProfile } from "../voice/voiceProfile";
import type { SynthesisRequest } from "./synthesisRequest";

/**
 * 组装 SynthesisRequest（M2 过渡形态）。
 *
 * 契约不变量（对齐 provider 请求体构造）：
 *   - style/designPrompt 都进 voiceProfile.baseStyle/baseDesignPrompt；delivery=null。
 *     （M3 SynthesisBuilder 会把「本句表演」抽到 delivery，此处不区分）
 *   - preset：voice 必填；design/clone：voice 可为 null
 *   - clone：refAudioPath 由调用方保证
 *   - provider（LLMProvider）打包进 engineParams.provider，供 adapter 转发
 */
export function buildLegacySynthesisRequest(input: {
  text: string;
  mode: AudiobookTtsMode;
  voice?: string | null;
  style?: string | null;
  designPrompt?: string | null;
  refAudioPath?: string | null;
  provider?: LLMProvider | null;
  /** 可选，用于调试关联；缺省生成 uuid */
  requestId?: string;
}): SynthesisRequest {
  const voiceProfile: VoiceProfile = {
    speakerKey: "legacy",
    mode: input.mode,
    voice: input.voice?.trim() || null,
    refAudioPath: input.refAudioPath?.trim() || null,
    baseStyle: input.style ?? null,
    baseDesignPrompt: input.designPrompt ?? null,
    source: input.mode === "preset" ? "narrator" : "card",
    speakerKind: "character",
    characterId: null,
    speakerLabel: "legacy",
  };
  const engineParams: SynthesisRequest["engineParams"] = input.provider
    ? { provider: input.provider }
    : undefined;
  return {
    requestId: input.requestId ?? randomUUID(),
    text: input.text,
    voiceProfile,
    delivery: null,
    engineParams,
  };
}
