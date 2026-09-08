import { volumeReadinessExecutor } from "../../VolumeReadinessExecutor";
import {
  ensureVolumeReadinessRunsHydrated,
  isWallBudgetExhausted,
  listPlannedLiveReadinessRuns,
  type VolumeReadinessRunRecord,
} from "../../volumeReadinessRunStore";

type StartupRecoveryRun = Pick<
  VolumeReadinessRunRecord,
  "runId" | "novelId" | "wallMsUsed" | "budget"
>;

export interface VolumeReadinessStartupRecoveryDependencies {
  hydrate: () => Promise<void>;
  listPlanned: () => StartupRecoveryRun[];
  isWallExhausted: (run: StartupRecoveryRun) => boolean;
  execute: (runId: string) => Promise<unknown>;
}

const defaultDependencies: VolumeReadinessStartupRecoveryDependencies = {
  hydrate: ensureVolumeReadinessRunsHydrated,
  listPlanned: () => listPlannedLiveReadinessRuns({ skipWallExhausted: false }),
  isWallExhausted: (run) => isWallBudgetExhausted(run as VolumeReadinessRunRecord),
  execute: (runId) => volumeReadinessExecutor.execute(runId),
};

/**
 * 进程启动后恢复因上次退出而降回 planned 的整卷 readiness run。
 *
 * 只负责 startup lane：HTTP 手工执行、定时 dry-run 与正常 executor 生命周期不经过这里。
 * 同 novel 去重沿用 run store 的 updatedAt 排序，较新的 run 优先。
 */
export class VolumeReadinessStartupRecoveryRunner {
  constructor(
    private readonly dependencies: VolumeReadinessStartupRecoveryDependencies = defaultDependencies,
  ) {}

  async run(shouldStop: () => boolean = () => false): Promise<void> {
    await this.dependencies.hydrate();
    if (shouldStop()) return;

    const allPlanned = this.dependencies.listPlanned();
    const planned = allPlanned.filter((run) => !this.dependencies.isWallExhausted(run));
    for (const run of allPlanned) {
      if (!this.dependencies.isWallExhausted(run)) continue;
      console.warn("[volume.readiness] skip auto-resume: wall already exhausted", {
        runId: run.runId,
        novelId: run.novelId,
        wallMsUsed: run.wallMsUsed,
        maxWallMinutes: run.budget.maxWallMinutes,
      });
    }

    const seenNovels = new Set<string>();
    const dedupedPlanned = planned.filter((run) => {
      if (seenNovels.has(run.novelId)) {
        console.log("[volume.readiness] skip auto-resume sibling planned (same novel)", {
          runId: run.runId,
          novelId: run.novelId,
        });
        return false;
      }
      seenNovels.add(run.novelId);
      return true;
    });

    // Startup is already the highest memory-pressure window: director recovery,
    // audiobook recovery and cache hydration run beside this lane. Execute one
    // live volume at a time across novels so a restart cannot fan out multiple
    // long review/repair/LLM chains and recreate the OOM trigger.
    for (const run of dedupedPlanned) {
      if (shouldStop()) break;
      console.log("[volume.readiness] auto-resume planned run after hydrate", {
        runId: run.runId,
        novelId: run.novelId,
      });
      try {
        await this.dependencies.execute(run.runId);
      } catch (error) {
        console.error("[volume.readiness] auto-resume execute failed", {
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const volumeReadinessStartupRecoveryRunner = new VolumeReadinessStartupRecoveryRunner();
