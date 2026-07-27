import type { BaseMessageChunk } from "@langchain/core/messages";
import { prisma } from "../../../../../db/prisma";
import type { VolumeReadinessChapterOutcome } from "../../volumeReadinessRunStore";
import type { VolumeReadinessVerdict } from "../../volumeReadinessPolicy";

interface RepairStatusFrame {
  type?: string;
  status?: string;
  phase?: string;
  message?: string;
}

export interface RepairStreamHandle {
  stream: AsyncIterable<BaseMessageChunk>;
  onDone: (
    fullContent: string,
    helpers: { writeFrame: (payload: unknown) => void },
  ) => Promise<void>;
}

const RETRYABLE_OUTCOMES = new Set<VolumeReadinessChapterOutcome>([
  "re_review_incomplete",
  "repair_incomplete",
  "polish_incomplete",
  "failed",
  "skipped_locked",
]);

export function isRetryableReadinessOutcome(outcome: VolumeReadinessChapterOutcome): boolean {
  return RETRYABLE_OUTCOMES.has(outcome);
}

export function mapRepairOutcomeFromFrames(
  frames: RepairStatusFrame[],
): { outcome: VolumeReadinessChapterOutcome; message: string | null } {
  const completedFrames = frames.filter((frame) => frame.phase === "completed");
  const completed = completedFrames.at(-1) ?? null;
  if (!completed) {
    const tail = [...frames].reverse().find((frame) => typeof frame.message === "string");
    return {
      outcome: "failed",
      message: tail?.message ?? "repair stream ended without completed frame",
    };
  }
  const message = completed.message ?? null;
  const text = (message ?? "").toLowerCase();
  const frameStatus = typeof completed.status === "string"
    ? completed.status.toLowerCase()
    : "";

  if (text.includes("plateau") || text.includes("平台")) {
    return { outcome: "repair_plateau", message };
  }
  if (
    text.includes("discard")
    || text.includes("未采纳")
    || text.includes("rejected")
    || text.includes("保持 baseline")
  ) {
    return { outcome: "repair_discarded", message };
  }
  if (isChapterLockConflictMessage(text)) {
    return { outcome: "skipped_locked", message };
  }

  const looksAdopted = text.includes("已采纳")
    || text.includes("adopt")
    || (text.includes("采纳") && !text.includes("未采纳"));
  if (looksAdopted) {
    if (frameStatus === "failed") {
      return { outcome: "repair_incomplete", message };
    }
    if (frameStatus === "succeeded" || frameStatus === "") {
      if (
        text.includes("仍有问题")
        || text.includes("待继续")
        || text.includes("同步失败")
        || text.includes("needs_repair")
      ) {
        return { outcome: "repair_incomplete", message };
      }
      return { outcome: "repair_adopted", message };
    }
    return { outcome: "repair_incomplete", message };
  }
  if (frameStatus === "failed") {
    return { outcome: "failed", message: message ?? "repair frame status=failed" };
  }
  if (frameStatus === "succeeded") {
    return { outcome: "repair_adopted", message: message ?? "repair succeeded" };
  }
  return {
    outcome: "failed",
    message: message?.trim() ? message : message ?? "repair finished without status frame",
  };
}

export function isChapterLockConflictMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("chapter repair lock")
    || lower.includes("repair in progress")
    || lower.includes("already in progress")
    || lower.includes("章节修复进行中")
    || lower.includes("并发修复");
}

export function mapRepairOutcome(message: string | null | undefined): VolumeReadinessChapterOutcome {
  return mapRepairOutcomeFromFrames([{
    message: message ?? undefined,
    phase: "completed",
  }]).outcome;
}

export function countIncompleteAttemptsForChapter(
  results: Array<{
    chapterId: string;
    outcome: VolumeReadinessChapterOutcome;
    attemptCount?: number;
  }>,
  chapterId: string,
): number {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (result.chapterId !== chapterId) continue;
    if (isRetryableReadinessOutcome(result.outcome)) {
      return typeof result.attemptCount === "number" && result.attemptCount > 0
        ? result.attemptCount
        : 1;
    }
    return 0;
  }
  return 0;
}

export async function drainRepairStream(input: {
  stream: AsyncIterable<BaseMessageChunk>;
  onDone: RepairStreamHandle["onDone"];
  signal?: AbortSignal;
}): Promise<{ fullContent: string; frames: RepairStatusFrame[] }> {
  let fullContent = "";
  const frames: RepairStatusFrame[] = [];
  for await (const chunk of input.stream) {
    if (input.signal?.aborted) {
      throw new Error("repair drain aborted (signal)");
    }
    const text = typeof chunk.content === "string"
      ? chunk.content
      : Array.isArray(chunk.content)
        ? chunk.content.map((part) => (typeof part === "string" ? part : "")).join("")
        : "";
    fullContent += text;
  }
  await input.onDone(fullContent, {
    writeFrame: (payload: unknown) => {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        frames.push(payload as RepairStatusFrame);
      }
    },
  });
  return { fullContent, frames };
}

export function createChapterTimeoutClock(deadlineMs: number, budgetMs: number): {
  signal: AbortSignal;
  race: <T>(fn: () => Promise<T>, stepLabel?: string) => Promise<T>;
  abort: (reason: string) => void;
  dispose: () => void;
} {
  const timeoutMs = Math.max(60_000, Math.min(deadlineMs, budgetMs));
  const absoluteDeadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const fireAbort = (reason: string): void => {
    try {
      if (!controller.signal.aborted) controller.abort(reason);
    } catch {
      // Cancellation must not terminate the executor process.
    }
  };
  const abortTimer = setTimeout(
    () => fireAbort(`readiness chapter wall ${Math.round(timeoutMs / 1000)}s`),
    timeoutMs,
  );
  abortTimer.unref?.();
  const race = async <T>(fn: () => Promise<T>, stepLabel?: string): Promise<T> => {
    if (controller.signal.aborted) {
      throw new Error(
        `readiness chapter step timeout${stepLabel ? `: ${stepLabel}` : ""} (already aborted)`,
      );
    }
    const remaining = Math.max(1, absoluteDeadline - Date.now());
    let gateTimer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const gate = new Promise<never>((_, reject) => {
      gateTimer = setTimeout(() => {
        const message = `readiness chapter step timeout after ${Math.round(timeoutMs / 1000)}s${stepLabel ? `: ${stepLabel}` : ""}`;
        fireAbort(message);
        reject(new Error(message));
      }, remaining);
      onAbort = () => reject(new Error(
        `readiness chapter step aborted${stepLabel ? `: ${stepLabel}` : ""} (${String(controller.signal.reason ?? "aborted")})`,
      ));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race<T>([fn(), gate]);
    } finally {
      if (gateTimer) clearTimeout(gateTimer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  };
  return {
    signal: controller.signal,
    race,
    abort: fireAbort,
    dispose: () => clearTimeout(abortTimer),
  };
}

export function estimateLlmCallsForAction(verdict: VolumeReadinessVerdict): number {
  if (verdict === "needs_re_review") return 2;
  if (verdict === "needs_patch" || verdict === "needs_heavy") return 6;
  if (verdict === "needs_polish") return 3;
  return 0;
}

export async function loadChapterContent(chapterId: string): Promise<string> {
  try {
    const row = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { content: true },
    });
    return row?.content ?? "";
  } catch {
    return "";
  }
}
