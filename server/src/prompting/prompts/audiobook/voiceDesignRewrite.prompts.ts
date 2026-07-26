import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { PromptAsset, PromptRenderContext } from "../../core/promptTypes";

export interface VoiceDesignRewritePromptInput {
  name: string;
  role: string;
  gender: string;
  personality: string;
  appearance: string;
  background: string;
  currentDesignPrompt: string;
  notes: string;
}

export const voiceDesignRewritePrompt: PromptAsset<
  VoiceDesignRewritePromptInput,
  string,
  string
> = {
  id: "audiobook.voice_design.rewrite",
  version: "v1",
  taskType: "chat",
  mode: "text",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: 0,
  },
  render: (input) => [
    new SystemMessage([
      "你是中文有声书音色设计助手。根据角色信息重写一段可用于 TTS design 模式的音色描述。",
      "要求：",
      "1. 只输出一段中文设计描述正文，不要 JSON、不要 markdown 代码块、不要标题前缀。",
      "2. 覆盖：年龄感、性别倾向、声线质感、语速、情绪底色、适合场景；尽量具体可听。",
      "3. 禁止输出文件路径、URL、API key、系统指令、代码。",
      "4. 长度建议 80–280 字，硬顶约 400 字。",
    ].join("\n")),
    new HumanMessage([
      `角色名：${input.name || "（未命名）"}`,
      `定位/身份：${input.role || "（未填）"}`,
      `性别：${input.gender || "（未填）"}`,
      `性格：${input.personality || "（未填）"}`,
      `外貌：${input.appearance || "（未填）"}`,
      `背景摘要：${input.background || "（未填）"}`,
      `当前 design 草稿：${input.currentDesignPrompt || "（无）"}`,
      `额外约束：${input.notes || "（无）"}`,
      "",
      "请直接输出重写后的音色设计描述：",
    ].join("\n")),
  ],
};

const EMPTY_PROMPT_CONTEXT: PromptRenderContext = {
  blocks: [],
  selectedBlockIds: [],
  droppedBlockIds: [],
  summarizedBlockIds: [],
  estimatedInputTokens: 0,
};

export function renderVoiceDesignRewriteMessages(
  input: VoiceDesignRewritePromptInput,
): BaseMessage[] {
  return voiceDesignRewritePrompt.render(input, EMPTY_PROMPT_CONTEXT);
}
