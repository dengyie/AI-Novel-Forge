import type { Router, Response } from "express";
import { z } from "zod";
import { initSSE, streamToSSE, writeSSEFrame } from "../../../../llm/streaming";
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

/**
 * E2/E3：prepare 阶段（planner/context/state）失败时透传 failurePhase。
 * E3 提前发 SSE 头后，prepare 失败不能再写 JSON body（头已 flush），改写 SSE error frame
 * 含 failurePhase/failureKind，让客户端/运维一眼区分「prepare 失败」vs「writer 超时」。
 * 标记由 prepareRuntimeChapter 注入（chapterGenerationFailurePhase）。
 * 非 prepare 错误不命中，回落 next(error) 保持原行为。
 * 返回 true 表示已处理（已写 SSE error frame + end）。
 */
function respondToPrepareFailureAsSSE(error: unknown, res: Response): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const phase = (error as { chapterGenerationFailurePhase?: unknown }).chapterGenerationFailurePhase;
  if (phase !== "prepare") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  const promptQualityKind = (error as { promptQualityFailureKind?: unknown }).promptQualityFailureKind;
  writeSSEFrame(res, {
    type: "error",
    error: JSON.stringify({
      success: false,
      failurePhase: "prepare",
      message,
      ...(typeof promptQualityKind === "string" ? { failureKind: promptQualityKind } : {}),
      retryable: true,
    }),
  });
  return true;
}

/**
 * E3：planner 阶段耗时长时，CF Tunnel 100s 无首字节 → 524。
 * 在 await runStep（含 prepareRuntimeChapter/planner）之前先 initSSE（flush 头 + 15s heartbeat），
 * planner 期间 heartbeat 持续发 ping，CF 收到字节流不超时。
 * 返回 disposeHeartbeat，调用方须在 finally 清理。
 */
function startEarlySSE(res: Response): () => void {
  return initSSE(res);
}

async function runChapterGenerationRoute(
  req: import("express").Request,
  res: Response,
  next: (err?: unknown) => void,
  forwardBusinessError: (error: unknown, next: (err?: unknown) => void) => boolean,
  stepInput: Record<string, unknown>,
): Promise<void> {
  // E3：提前 initSSE，让 CF 在 planner 期间收到首字节 + heartbeat 不超时。
  const disposeHeartbeat = startEarlySSE(res);
  const controller = new AbortController();
  res.on("close", () => controller.abort(new Error("client disconnected")));
  try {
    const { id, chapterId } = req.params as { id: string; chapterId: string };
    const { stream, onDone } = await stepModuleRunner.runStep<ChapterStreamResult>(
      DIRECTOR_EXECUTION_STEP_IDS.chapter_execution,
      {
        novelId: id,
        mode: "manual",
        targetType: "chapter",
        targetChapterId: chapterId,
        stepInput,
        signal: controller.signal,
      },
    );
    // E3：头已由 startEarlySSE 初始化，streamToSSE 复用，不重复 initSSE。
    await streamToSSE(res, stream, onDone, {
      signal: controller.signal,
      alreadyInitialized: true,
    });
  } catch (error) {
    if (respondToPrepareFailureAsSSE(error, res)) {
      return;
    }
    if (forwardBusinessError(error, next)) {
      return;
    }
    // 非 prepare 错误：头已发，写 SSE error frame 透传（不能再改 JSON body）。
    writeSSEFrame(res, {
      type: "error",
      error: error instanceof Error ? error.message : "章节生成失败。",
    });
    next(error);
  } finally {
    disposeHeartbeat();
    if (!res.writableEnded) {
      res.end();
    }
  }
}

// chapterParamsSchema 在 runChapterGenerationRoute 内被 z.infer 引用，此处声明类型来源。
// （实际 schema 由注册方传入，类型已在 RegisterNovelChapterGenerationRoutesInput 声明。）

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
      await runChapterGenerationRoute(
        req,
        res,
        next,
        forwardBusinessError,
        {
          options: req.body as z.infer<typeof chapterRuntimeRequestSchema>,
          runtimeStream: true,
        },
      );
    },
  );

  router.post(
    "/:id/chapters/:chapterId/generate",
    validate({ params: chapterParamsSchema, body: chapterRuntimeRequestSchema }),
    async (req, res, next) => {
      await runChapterGenerationRoute(
        req,
        res,
        next,
        forwardBusinessError,
        req.body as z.infer<typeof chapterRuntimeRequestSchema>,
      );
    },
  );
}
