import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Max requests per window per key. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Skip limiter for this request. */
  skip?: (req: Request) => boolean;
  keyGenerator?: (req: Request) => string;
}

/**
 * Lightweight in-process fixed-window rate limiter (no external deps).
 * Sufficient for single-node deployments; not a distributed limiter.
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const limit = Math.max(1, options.limit);
  const windowMs = Math.max(1000, options.windowMs);
  const keyGenerator = options.keyGenerator
    ?? ((req: Request) => {
      const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
      return forwarded || req.ip || req.socket.remoteAddress || "unknown";
    });

  // Opportunistic GC so long-lived process does not retain every IP forever.
  const gcEvery = 200;
  // 同步 GC 阈值：buckets 超过该规模时立刻清扫，避免低流量期过期桶驻留
  const maxBucketsBeforeGc = 10000;
  let hits = 0;

  const sweepExpiredBuckets = () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  };

  // 周期清扫兜底：低流量期 hits%gcEvery 可能很久不触发，过期 bucket 不能一直驻留
  const gcTimer = setInterval(sweepExpiredBuckets, Math.max(windowMs, 60_000));
  gcTimer.unref?.();

  function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (options.skip?.(req)) {
      next();
      return;
    }

    hits += 1;
    if (hits % gcEvery === 0 || buckets.size > maxBucketsBeforeGc) {
      sweepExpiredBuckets();
    }

    const key = keyGenerator(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
      const response: ApiResponse<null> = {
        success: false,
        error: "请求过于频繁，请稍后再试。",
      };
      res.status(429).json(response);
      return;
    }

    next();
  }

  // 测试白盒观测口：让测试能区分「周期/阈值 GC 真删了 key」与「惰性过期只重置被访问 key」
  rateLimitMiddleware.__bucketsForTest = buckets;
  rateLimitMiddleware.__sweepForTest = sweepExpiredBuckets;
  return rateLimitMiddleware;
}
