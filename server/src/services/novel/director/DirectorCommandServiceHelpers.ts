import crypto from "node:crypto";
import type {
  DirectorCommandAcceptedResponse,
  DirectorRunCommandStatus,
  DirectorRunCommandType,
} from "@ai-novel/shared/types/directorRuntime";
import type {
  DirectorConfirmRequest,
  DirectorContinuationMode,
  DirectorTakeoverRequest,
} from "@ai-novel/shared/types/novelDirector";

export interface DirectorCommandPayload {
  confirmRequest?: DirectorConfirmRequest;
  continuationMode?: DirectorContinuationMode;
  batchAlreadyStartedCount?: number;
  forceResume?: boolean;
  takeoverRequest?: DirectorTakeoverRequest;
  volumeId?: string | null;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return crypto.createHash("sha1").update(stableJson(value)).digest("hex").slice(0, 12);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

export function toAcceptedResponse(command: {
  id: string;
  taskId: string;
  novelId: string | null;
  commandType: string;
  status: string;
  leaseExpiresAt: Date | null;
}, runtime?: {
  id: string;
  status: string;
} | null): DirectorCommandAcceptedResponse {
  return {
    commandId: command.id,
    taskId: command.taskId,
    novelId: command.novelId,
    commandType: command.commandType as DirectorRunCommandType,
    status: command.status as DirectorRunCommandStatus,
    leaseExpiresAt: command.leaseExpiresAt?.toISOString() ?? null,
    runtimeId: runtime?.id ?? null,
    runtimeStatus: runtime?.status ?? null,
    projectionUrl: runtime ? `/api/novels/director/runtime/${command.taskId}/projection` : null,
  };
}

export function parsePayload(payloadJson: string | null): DirectorCommandPayload {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed as DirectorCommandPayload : {};
  } catch {
    return {};
  }
}

export function resolveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function buildAcceptedTaskState(commandType: DirectorRunCommandType): {
  currentStage?: string;
  currentItemKey?: string;
  currentItemLabel?: string;
  progress?: number;
  checkpointType?: null;
  checkpointSummary?: null;
} {
  if (commandType === "confirm_candidate") {
    return {
      currentStage: "AI 自动导演",
      currentItemKey: "candidate_confirm",
      currentItemLabel: "书级方向提交完成，等待 AI 创建小说项目",
      progress: 0.18,
      checkpointType: null,
      checkpointSummary: null,
    };
  }
  return {};
}
