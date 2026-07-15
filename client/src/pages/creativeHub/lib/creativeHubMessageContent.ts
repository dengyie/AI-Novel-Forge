import {
  convertLangChainMessages,
  type LangChainMessage,
} from "@assistant-ui/react-langgraph";

/**
 * 归一化 LangChain message.content，避免 convertLangChainMessages
 * 在 null/非 string 非 array 时 .map 崩溃。
 */
export function normalizeLangChainMessageContent(content: unknown): string | unknown[] {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content;
  }
  return "";
}

export function normalizeLangChainMessage(
  message: LangChainMessage,
): LangChainMessage {
  const content = (message as { content?: unknown }).content;
  const normalized = normalizeLangChainMessageContent(content);
  if (content === normalized) {
    return message;
  }
  return {
    ...message,
    content: normalized,
  } as LangChainMessage;
}

export function safeConvertLangChainMessages(
  message: LangChainMessage,
  ...rest: Parameters<typeof convertLangChainMessages> extends [any, ...infer R] ? R : never
) {
  return convertLangChainMessages(normalizeLangChainMessage(message), ...rest);
}

/** 从 assistant-ui 用户消息 / 附件拼出 LangGraph human content。 */
export function getMessageContent(msg: any): string | Array<Record<string, unknown>> {
  const rawContent = msg?.content;
  const contentParts = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  const attachmentParts = Array.isArray(msg?.attachments)
    ? msg.attachments.flatMap((item: any) => (
      Array.isArray(item?.content) ? item.content : []
    ))
    : [];
  const parts = [...contentParts, ...attachmentParts];
  const normalized = parts.map((part: any) => {
    if (part?.type === "text") {
      return { type: "text", text: part.text ?? "" };
    }
    if (part?.type === "image") {
      return { type: "image_url", image_url: { url: part.image } };
    }
    return {
      type: "file",
      data: part?.data,
      mime_type: part?.mimeType,
      metadata: {
        filename: part?.filename ?? "file",
      },
      source_type: "base64",
    };
  });
  if (normalized.length === 0) {
    return "";
  }
  if (normalized.length === 1 && normalized[0]?.type === "text") {
    return normalized[0].text as string;
  }
  return normalized;
}
