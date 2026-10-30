import type { BaseMessage } from "@langchain/core/messages";

/**
 * 资产显式声明 stable_prefix 且 example/note 均为静态时，把结构化输出骨架
 * 前置到动态材料之前（保持 Human 角色）；其余保持尾部布局。
 */
export function placeStructuredHint(messages: BaseMessage[], hint: BaseMessage, stable: boolean): BaseMessage[] {
  if (!stable) {
    return [...messages, hint];
  }
  // Preserve message roles: stable schema remains user guidance after leading system rules.
  const at = messages.findIndex((message) => message.getType() !== "system");
  const index = at < 0 ? messages.length : at;
  return [...messages.slice(0, index), hint, ...messages.slice(index)];
}
