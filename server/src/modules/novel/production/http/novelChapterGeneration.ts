import type { Router } from "express";
import { z } from "zod";
import { streamToSSE } from "../../../../llm/streaming";
import { validate } from "../../../../middleware/validate";
import type { ChapterRuntimeCoordinator } from "../../../../services/novel/runtime/ChapterRuntimeCoordinator";
import { chapterRuntimeRequestSchema } from "../../../../services/novel/runtime/chapterRuntimeSchema";
import { stepModuleRunner } from "../../../../services/novel/director/workflowStepRuntime/StepModuleRunner";
import { DIRECTOR_EXECUTION_STEP_IDS } from "../../../../services/novel/director/workflowStepRuntime/directorWorkflowStepIds";

type ChapterStreamResult = Awaited<ReturnType<ChapterRuntimeCoordinator["createChapterStream"]>>;

interface RegisterNovelChapterGenerationRoutesInput {
  router: Router;
  chapterParamsSchema: z.ZodType<{
    id: string;
    chapterId: string;
  }>;
  forwardBusinessError: (error: unknown, next: (err?: unknown) => void) => boolean;
}

export function registerNovelChapterGenerationRoutes(input: RegisterNovelChapterGenerationRoutesInput): void {
  const {
    router,
    chapterParamsSchema,
    forwardBusinessError,
  } = input;

  router.post(
    "/:id/chapters/:chapterId/runtime/run",
    validate({ params: chapterParamsSchema, body: chapterRuntimeRequestSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        // F6：客户端断连时触发 abort，传到 chapter_execution step 的 SSE 中断信号，
        // 让 streamTextPrompt/captureStreamOutput 尽快 settle/reject，释放章节锁。
        const controller = new AbortController();
        res.on("close", () => controller.abort(new Error("client disconnected")));
        const { stream, onDone } = await stepModuleRunner.runStep<ChapterStreamResult>(
          DIRECTOR_EXECUTION_STEP_IDS.chapter_execution,
          {
            novelId: id,
            mode: "manual",
            targetType: "chapter",
            targetChapterId: chapterId,
            stepInput: {
              options: req.body as z.infer<typeof chapterRuntimeRequestSchema>,
              runtimeStream: true,
            },
            signal: controller.signal,
          },
        );
        await streamToSSE(res, stream, onDone, { signal: controller.signal });
      } catch (error) {
        if (forwardBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/generate",
    validate({ params: chapterParamsSchema, body: chapterRuntimeRequestSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const controller = new AbortController();
        res.on("close", () => controller.abort(new Error("client disconnected")));
        const { stream, onDone } = await stepModuleRunner.runStep<ChapterStreamResult>(
          DIRECTOR_EXECUTION_STEP_IDS.chapter_execution,
          {
            novelId: id,
            mode: "manual",
            targetType: "chapter",
            targetChapterId: chapterId,
            stepInput: req.body as z.infer<typeof chapterRuntimeRequestSchema>,
            signal: controller.signal,
          },
        );
        await streamToSSE(res, stream, onDone, { signal: controller.signal });
      } catch (error) {
        if (forwardBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );
}
