/**
 * 可选后台巡检：默认关闭，VOLUME_READINESS_SCHEDULE=1 才注册。
 * 仅 dry-run assess 日志，不自动改正文。
 */

import {
  VOLUME_READINESS_SCHEDULE_ENABLED,
  VOLUME_READINESS_SCHEDULE_INTERVAL_MS,
} from "../../../config/volumeReadiness";
import { prisma } from "../../../db/prisma";
import { volumeReadinessService } from "./VolumeReadinessService";

export class VolumeReadinessScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (!VOLUME_READINESS_SCHEDULE_ENABLED) {
      return;
    }
    if (this.timer) {
      return;
    }
    void this.runOnce().catch((error) => {
      console.warn("[volume.readiness.scheduler] initial run failed", error);
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.warn("[volume.readiness.scheduler] run failed", error);
      });
    }, VOLUME_READINESS_SCHEDULE_INTERVAL_MS);
    this.timer.unref?.();
    console.info("[volume.readiness.scheduler] started", {
      intervalMs: VOLUME_READINESS_SCHEDULE_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      // 仅巡检最近更新的书，最多 3 本，避免烧 LLM（只 dry assess，不改正文）
      const novels = await prisma.novel.findMany({
        select: { id: true, title: true },
        orderBy: { updatedAt: "desc" },
        take: 3,
      });
      for (const novel of novels) {
        try {
          const report = await volumeReadinessService.assess(novel.id, {
            fromOrder: 1,
            toOrder: 20,
            refresh: false,
          });
          console.info("[volume.readiness.scheduler] dry report", {
            novelId: novel.id,
            title: novel.title,
            summary: report.summary,
          });
        } catch (error) {
          console.warn("[volume.readiness.scheduler] novel assess failed", {
            novelId: novel.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const volumeReadinessScheduler = new VolumeReadinessScheduler();
