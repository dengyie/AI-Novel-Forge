import type { NovelEvent, NovelEventType, EventHandler } from "./types";

interface HandlerEntry {
  handler: EventHandler;
  priority: number;
}

/**
 * EventBus handler 失败可观测（P2-4）。
 * emit 对单 handler 仍 fail-open（不拖垮发布方）；错误进 console + 进程内计数。
 * 运维扫日志 `[EventBus] handler error` 或读 getEventBusHandlerFailureMetrics()。
 * 范围：进程内存，重启清零；暂无 HTTP 导出。
 */
export interface EventBusHandlerFailureMetrics {
  total: number;
  lastAt: string | null;
  lastEventType: string | null;
  lastError: string | null;
}

const eventBusHandlerFailureMetrics: EventBusHandlerFailureMetrics = {
  total: 0,
  lastAt: null,
  lastEventType: null,
  lastError: null,
};

export function getEventBusHandlerFailureMetrics(): Readonly<EventBusHandlerFailureMetrics> {
  return { ...eventBusHandlerFailureMetrics };
}

/** 单测重置；生产路径勿调用。 */
export function resetEventBusHandlerFailureMetrics(): void {
  eventBusHandlerFailureMetrics.total = 0;
  eventBusHandlerFailureMetrics.lastAt = null;
  eventBusHandlerFailureMetrics.lastEventType = null;
  eventBusHandlerFailureMetrics.lastError = null;
}

function noteEventBusHandlerFailure(input: {
  eventType: string;
  error: unknown;
  at?: Date;
}): EventBusHandlerFailureMetrics {
  const at = input.at ?? new Date();
  const message = input.error instanceof Error
    ? input.error.message
    : String(input.error ?? "unknown");
  eventBusHandlerFailureMetrics.total += 1;
  eventBusHandlerFailureMetrics.lastAt = at.toISOString();
  eventBusHandlerFailureMetrics.lastEventType = input.eventType;
  eventBusHandlerFailureMetrics.lastError = message;
  return getEventBusHandlerFailureMetrics();
}

export class EventBus {
  private handlers = new Map<NovelEventType, HandlerEntry[]>();

  on<T extends NovelEvent>(eventType: T["type"], handler: EventHandler<T>, priority = 0): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push({ handler: handler as EventHandler, priority });
    list.sort((a, b) => a.priority - b.priority);
    this.handlers.set(eventType, list);
  }

  off(eventType: NovelEventType, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    const next = list.filter((e) => e.handler !== handler);
    if (next.length > 0) this.handlers.set(eventType, next);
    else this.handlers.delete(eventType);
  }

  /**
   * 顺序调用订阅者。单 handler 抛错：记数 + console.error，继续下一个；
   * emit 本身不 reject（调用方 `.catch(()=>{})` 为历史防御，非静默丢弃 emit 失败）。
   */
  async emit(event: NovelEvent): Promise<void> {
    const list = this.handlers.get(event.type) ?? [];
    for (const { handler } of list) {
      try {
        await handler(event);
      } catch (err) {
        const metrics = noteEventBusHandlerFailure({
          eventType: event.type,
          error: err,
        });
        console.error(
          `[EventBus] handler error for ${event.type}:`,
          err,
          `(failTotal=${metrics.total})`,
        );
      }
    }
  }
}

export const novelEventBus = new EventBus();
