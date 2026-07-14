import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import {
  MIMO_TTS_VOICE_CATALOG,
  type CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { z } from "zod";
import { llmProviderSchema } from "../../../../llm/providerSchema";
import { validate } from "../../../../middleware/validate";
import { audiobookTaskService } from "../../../../services/audiobook/AudiobookTaskService";

const novelParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const taskParamsSchema = z.object({
  id: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
});

const createAudiobookTaskSchema = z.object({
  scopeMode: z.enum(["chapter", "range", "full"]),
  chapterId: z.string().trim().min(1).optional(),
  startChapterOrder: z.number().int().min(1).optional(),
  endChapterOrder: z.number().int().min(1).optional(),
  narratorVoice: z.string().trim().max(64).optional(),
  narratorStyle: z.string().trim().max(500).optional(),
  provider: llmProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
}).superRefine((value, ctx) => {
  if (value.scopeMode === "chapter" && !value.chapterId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scopeMode=chapter 时必须提供 chapterId。",
      path: ["chapterId"],
    });
  }
  if (value.scopeMode === "range") {
    if (value.startChapterOrder == null || value.endChapterOrder == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeMode=range 时必须提供 startChapterOrder 与 endChapterOrder。",
        path: ["startChapterOrder"],
      });
    } else if (value.endChapterOrder < value.startChapterOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endChapterOrder 不能小于 startChapterOrder。",
        path: ["endChapterOrder"],
      });
    }
  }
});

export function registerNovelAudiobookRoutes(input: { router: Router }): void {
  const { router } = input;

  router.get("/audiobook/voices", async (_req, res, next) => {
    try {
      res.status(200).json({
        success: true,
        data: MIMO_TTS_VOICE_CATALOG,
        message: "MiMo TTS 预置音色表。",
      } satisfies ApiResponse<typeof MIMO_TTS_VOICE_CATALOG>);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:id/audiobook/precheck",
    validate({ params: novelParamsSchema, body: createAudiobookTaskSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof createAudiobookTaskSchema>;
        const payload: CreateAudiobookTaskInput = {
          novelId: id,
          ...body,
        };
        const data = await audiobookTaskService.precheck(payload);
        const message = data.ok
          ? "有声书预检通过。"
          : data.missingVoices.length > 0
            ? "有声书预检未通过，请补齐角色音色。"
            : "有声书预检未通过，请使用 MiMo 预置音色。";
        res.status(200).json({
          success: true,
          data,
          message,
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/tasks",
    validate({ params: novelParamsSchema, body: createAudiobookTaskSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof createAudiobookTaskSchema>;
        const data = await audiobookTaskService.createTask({
          novelId: id,
          ...body,
        });
        res.status(201).json({
          success: true,
          data,
          message: "有声书任务已创建。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/tasks",
    validate({ params: novelParamsSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const data = await audiobookTaskService.listByNovel(id);
        res.status(200).json({
          success: true,
          data,
          message: "有声书任务列表。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/tasks/:taskId",
    validate({ params: taskParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        const data = await audiobookTaskService.getTask(taskId);
        if (!data || data.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        res.status(200).json({
          success: true,
          data,
          message: "有声书任务详情。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/tasks/:taskId/cancel",
    validate({ params: taskParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        const existing = await audiobookTaskService.getTask(taskId);
        if (!existing || existing.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        const data = await audiobookTaskService.cancelTask(taskId);
        res.status(200).json({
          success: true,
          data,
          message: "有声书任务取消请求已提交。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );
}
