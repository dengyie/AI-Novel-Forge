/**
 * RAG 子进程 IPC-RPC 协议（主进程 ↔ rag worker 子进程）。
 *
 * 设计约束：协议文件必须保持零依赖（不 import prisma / rag 服务），
 * 使主进程只为此付出一个类型文件的代价。
 */

/** 主→子 RPC 请求（带 id），或控制消息（idle/shutdown，无 id）。 */
export type RagWorkerRequest =
  | { id: number; type: "buildContextBlock"; payload: { query: string; options: unknown } }
  | { id: number; type: "retrieve"; payload: { query: string; options: unknown } }
  | { id: number; type: "retrieveByFacet"; payload: { input: unknown } }
  | { id: number; type: "healthCheck" }
  | { id: number; type: "ping" }
  | { type: "idle" | "shutdown" };

export interface RagWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const RAG_WORKER_RPC_TIMEOUT_MS = 30_000;
/** 队列空 + 无在途 RPC 后，子进程保活的宽限期（主进程管理 RAG 10min；director 5min 见各自 Manager）。 */
export const RAG_WORKER_IDLE_GRACE_MS = 10 * 60_000;

export function isRagWorkerRequest(value: unknown): value is RagWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; type?: unknown };
  return typeof candidate.id === "number" && typeof candidate.type === "string";
}
