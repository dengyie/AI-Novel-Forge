import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { z } from "zod";
import { validate } from "../../../../middleware/validate";
import { volumeReadinessExecutor } from "../../../../services/novel/volume/VolumeReadinessExecutor";
import { volumeReadinessService } from "../../../../services/novel/volume/VolumeReadinessService";
import { requestVolumeReadinessRunCancel } from "../../../../services/novel/volume/volumeReadinessRunStore";
import { AppError } from "../../../../middleware/errorHandler";

interface RegisterNovelVolumeReadinessRoutesInput {
  router: Router;
  idParamsSchema: z.ZodType<{ id: string }>;
  volumeReadinessQuerySchema: z.ZodTypeAny;
  volumeReadinessRunSchema: z.ZodTypeAny;
  volumeReadinessRunParamsSchema: z.ZodType<{ id: string; runId: string }>;
}

export function registerNovelVolumeReadinessRoutes(
  input: RegisterNovelVolumeReadinessRoutesInput,
): void {
  const {
    router,
    idParamsSchema,
    volumeReadinessQuerySchema,
    volumeReadinessRunSchema,
    volumeReadinessRunParamsSchema,
  } = input;

  router.get(
    "/:id/readiness",
    validate({ params: idParamsSchema, query: volumeReadinessQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const query = volumeReadinessQuerySchema.parse(req.query) as {
          volumeOrder?: number;
          fromOrder?: number;
          toOrder?: number;
          refresh?: boolean;
        };
        const data = await volumeReadinessService.assess(id, {
          volumeOrder: query.volumeOrder,
          fromOrder: query.fromOrder,
          toOrder: query.toOrder,
          refresh: query.refresh === true,
        });
        res.status(200).json({
          success: true,
          data,
          message: "Volume readiness report.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/readiness/runs",
    validate({ params: idParamsSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await volumeReadinessService.listRuns(id);
        res.status(200).json({
          success: true,
          data,
          message: "Volume readiness runs listed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/readiness/runs",
    validate({ params: idParamsSchema, body: volumeReadinessRunSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const body = req.body as {
          volumeOrder?: number;
          fromOrder?: number;
          toOrder?: number;
          dryRun?: boolean;
          actionFilter?: Array<"needs_re_review" | "needs_patch" | "needs_polish" | "needs_heavy" | "needs_manual">;
          budget?: {
            maxChapters?: number;
            maxHeavyRewrites?: number;
            maxLlmCalls?: number;
            maxWallMinutes?: number;
          };
          refresh?: boolean;
          resumeFromRunId?: string | null;
        };
        const run = await volumeReadinessService.createRun(id, body);
        // dryRun 同步执行；非 dryRun 异步 fire-and-forget（HTTP 先返回 planned/running）
        if (run.dryRun) {
          const completed = await volumeReadinessExecutor.execute(run.runId);
          res.status(200).json({
            success: true,
            data: completed,
            message: "Volume readiness dry-run completed.",
          } satisfies ApiResponse<typeof completed>);
          return;
        }
        if (run.status === "planned") {
          void volumeReadinessExecutor.execute(run.runId).catch((error) => {
            console.error("[volume.readiness] execute failed", {
              runId: run.runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        res.status(202).json({
          success: true,
          data: run,
          message: "Volume readiness run accepted.",
        } satisfies ApiResponse<typeof run>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/readiness/runs/:runId",
    validate({ params: volumeReadinessRunParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, runId } = req.params as z.infer<typeof volumeReadinessRunParamsSchema>;
        const data = await volumeReadinessService.getRun(id, runId);
        res.status(200).json({
          success: true,
          data,
          message: "Volume readiness run loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/readiness/runs/:runId/cancel",
    validate({ params: volumeReadinessRunParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, runId } = req.params as z.infer<typeof volumeReadinessRunParamsSchema>;
        // 校验归属（hydrate 后）
        await volumeReadinessService.getRun(id, runId);
        const cancelled = requestVolumeReadinessRunCancel(runId);
        if (!cancelled) {
          throw new AppError("readiness run 不存在。", 404);
        }
        res.status(200).json({
          success: true,
          data: cancelled,
          message: "Volume readiness run cancel requested.",
        } satisfies ApiResponse<typeof cancelled>);
      } catch (error) {
        next(error);
      }
    },
  );
}
