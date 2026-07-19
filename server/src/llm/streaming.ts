import type { Response } from "express";
import type { BaseMessageChunk } from "@langchain/core/messages";
import type { SSEFrame } from "@ai-novel/shared/types/api";

export type WritableSSEFrame = Extract<
  SSEFrame,
  {
    type:
    | "chunk"
    | "done"
    | "error"
    | "ping"
    | "reasoning"
    | "runtime_package"
    | "tool_call"
    | "tool_result"
    | "approval_required"
    | "approval_resolved"
    | "run_status";
  }
>;

export interface StreamDonePayload {
  fullContent?: string;
  frames?: WritableSSEFrame[];
}

export interface StreamDoneHelpers {
  writeFrame: (payload: WritableSSEFrame) => void;
}

export function writeSSEFrame(res: Response, payload: WritableSSEFrame): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeChunkContent(content: BaseMessageChunk["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "object" && part && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

export function initSSE(res: Response): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    writeSSEFrame(res, { type: "ping" });
  }, 15000);

  return () => clearInterval(heartbeat);
}

export async function streamToSSE(
  res: Response,
  stream: AsyncIterable<BaseMessageChunk>,
  onDone?: (
    fullContent: string,
    helpers: StreamDoneHelpers,
  ) => void | StreamDonePayload | Promise<void | StreamDonePayload>,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const disposeHeartbeat = initSSE(res);
  let fullContent = "";

  try {
    for await (const chunk of stream) {
      // F6：客户端断连 → 调用方 signal 已 abort，或 res 已关闭，停止从上游拉取，
      // 让 onDone 内部的 `await streamed.complete` 因同 signal 尽快 reject 释放锁。
      if (res.writableEnded || options?.signal?.aborted) {
        break;
      }
      const text = normalizeChunkContent(chunk.content);
      if (!text) {
        continue;
      }
      fullContent += text;
      writeSSEFrame(res, { type: "chunk", content: text });
    }

    const donePayload = await onDone?.(fullContent, {
      writeFrame: (payload) => writeSSEFrame(res, payload),
    });
    if (options?.signal?.aborted) {
      // F6：已 abort 时不再写任何后续 frame（客户端已走）。onDone 内部已据 signal
      // settle/reject 并释放锁（finally），跳过 done/error 帧写回，避免向已关闭 res 再写。
      return;
    }
    if (donePayload?.frames?.length) {
      for (const frame of donePayload.frames) {
        writeSSEFrame(res, frame);
      }
    }
    if (donePayload?.fullContent) {
      fullContent = donePayload.fullContent;
    }
    writeSSEFrame(res, { type: "done", fullContent });
  } catch (error) {
    // F6：onDone 因 abort reject 抛到这里时若客户端已断连，不再向死写 error 帧。
    if (options?.signal?.aborted) {
      return;
    }
    writeSSEFrame(res, {
      type: "error",
      error: error instanceof Error ? error.message : "流式输出失败。",
    });
  } finally {
    disposeHeartbeat();
    if (!res.writableEnded) {
      res.end();
    }
  }
}
