import type {
  RagWorkerRequest,
  RagWorkerResponse,
} from "./ragWorkerProtocol";
import {
  RAG_WORKER_ACQUIRE_TIMEOUT_MS,
  RAG_WORKER_RPC_TIMEOUT_MS,
} from "./ragWorkerProtocol";

/**
 * 主进程侧 RAG RPC 客户端。
 *
 * RAG 全家（embedding/langchain/qdrant 客户端等，实测 +85MB heap）已移入
 * rag worker 子进程；主进程只持有一个本客户端，检索请求经 IPC 转发。
 * 子进程未起 / RPC 超时 / 出错时降级返回空结果——与 RAG-disabled 语义一致，
 * 生成链路绝不因 RAG 子进程问题而失败。
 *
 * 子进程的 spawn/生命周期由 RagWorkerManager 负责；本客户端通过
 * `ensureWorker` 回调按需唤起子进程（如在途检索），避免两条管理线打架。
 */

type Pending = {
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
};

/** RagClient 只需要 ChildProcess 的 IPC 面（不引 node:child_process 类型进来）。 */
export type WorkerLike = {
  send: (message: unknown, callback?: (error?: Error | null) => void) => boolean;
  on: (event: "message", listener: (message: unknown) => void) => unknown;
  off: (event: "message", listener: (message: unknown) => void) => unknown;
};

export interface RagClientDeps {
  /** 返回当前 rag worker 子进程（可能为 null——未 fork）。 */
  getWorker: () => WorkerLike | null;
  /** 无子进程时请求 fork（Manager 决定是否真的 fork，异步）。 */
  ensureWorker: () => void | Promise<void>;
}

export class RagClient {
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private readonly deps: RagClientDeps;
  private wiredWorker: WorkerLike | null = null;
  private messageHandler: ((message: unknown) => void) | null = null;
  /** 连续失败计数：熔断窗口内直接降级，不再拖 30s 超时。 */
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  static readonly CIRCUIT_THRESHOLD = 3;
  static readonly CIRCUIT_COOLDOWN_MS = 60_000;

  constructor(deps: RagClientDeps) {
    this.deps = deps;
  }

  /**
   * 把 RPC 响应路由接到（当前）子进程上。RagWorkerManager 在 fork 新子进程后
   * 与子进程 exit 时调用——重复调用是幂等的（wire 目标变化才重新挂监听）。
   */
  wire(): void {
    const worker = this.deps.getWorker();
    if (worker === this.wiredWorker) {
      return;
    }
    if (this.wiredWorker && this.messageHandler) {
      this.wiredWorker.off("message", this.messageHandler);
    }
    this.wiredWorker = worker;
    if (!worker) {
      this.messageHandler = null;
      return;
    }
    this.messageHandler = (message: unknown) => this.handleMessage(message);
    worker.on("message", this.messageHandler);
  }

  /** 子进程退出时清空在途请求（Manager 在 exit 回调中调用）。 */
  handleWorkerExit(): void {
    this.rejectAll(new Error("RAG worker exited during RPC"));
    this.wire();
  }

  private handleMessage(message: unknown): void {
    const response = message as RagWorkerResponse | undefined;
    if (
      !response
      || typeof response !== "object"
      || typeof response.id !== "number"
    ) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      this.consecutiveFailures = 0;
      pending.resolve(response.result);
    } else {
      this.noteFailure();
      pending.resolve(null);
    }
  }

  private noteFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= RagClient.CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + RagClient.CIRCUIT_COOLDOWN_MS;
      this.consecutiveFailures = 0;
      console.warn(
        `[RAG][Client] circuit open ${RagClient.CIRCUIT_COOLDOWN_MS}ms after repeated RPC failures; degrade-to-empty active.`,
      );
    }
  }

  private rejectAll(_error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pending.clear();
  }

  private circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private async request<T>(
    message:
      | { type: "buildContextBlock"; payload: { query: string; options: unknown } }
      | { type: "retrieve"; payload: { query: string; options: unknown } }
      | { type: "retrieveByFacet"; payload: { input: unknown } }
      | { type: "healthCheck" }
      | { type: "ping" },
  ): Promise<T | null> {
    if (this.circuitOpen()) {
      return null;
    }
    let worker = this.deps.getWorker();
    if (!worker) {
      let acquireTimer: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.deps.ensureWorker()),
          new Promise<void>((resolve) => {
            acquireTimer = setTimeout(resolve, RAG_WORKER_ACQUIRE_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        this.noteFailure();
        console.warn("[RAG][Client] worker acquisition failed; degrade to empty.", error);
        return null;
      } finally {
        if (acquireTimer) {
          clearTimeout(acquireTimer);
        }
      }
      worker = this.deps.getWorker();
      if (!worker) {
        return null;
      }
    }
    this.wire();
    const id = this.nextRequestId++;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.noteFailure();
        console.warn(`[RAG][Client] RPC timeout type=${message.type} id=${id}; degrade to empty.`);
        resolve(null);
      }, RAG_WORKER_RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        timer,
      });
      try {
        worker.send({ ...message, id }, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          this.noteFailure();
          console.warn("[RAG][Client] IPC send failed; degrade to empty.", error);
          pending.resolve(null);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.noteFailure();
        console.warn("[RAG][Client] IPC send failed; degrade to empty.", error);
        resolve(null);
      }
    });
  }

  /**
   * 生成链路检索入口（chat / novelReadTools / director 等消费方）。
   * 任何失败路径都返回空串：与 RAG-disabled 相同语义，不阻塞正文生成。
   */
  async buildContextBlock(query: string, options: unknown): Promise<string> {
    const result = await this.request<string>({ type: "buildContextBlock", payload: { query, options } });
    return typeof result === "string" ? result : "";
  }

  async retrieve(query: string, options: unknown): Promise<unknown[] | null> {
    const result = await this.request<unknown[]>({ type: "retrieve", payload: { query, options } });
    return Array.isArray(result) ? result : null;
  }

  async retrieveByFacet(input: unknown): Promise<unknown[] | null> {
    const result = await this.request<unknown[]>({ type: "retrieveByFacet", payload: { input } });
    return Array.isArray(result) ? result : null;
  }

  /** /api/rag/health 用：探活子进程。null = 子进程不可用（前端显示 RAG 降级）。 */
  async healthCheck(): Promise<{
    ok: boolean;
    embedding: { ok: boolean; detail?: string };
    qdrant: { ok: boolean; detail?: string };
  } | null> {
    return this.request<{ ok: boolean; embedding: { ok: boolean; detail?: string }; qdrant: { ok: boolean; detail?: string } }>({ type: "healthCheck" });
  }

  get inflightCount(): number {
    return this.pending.size;
  }
}
