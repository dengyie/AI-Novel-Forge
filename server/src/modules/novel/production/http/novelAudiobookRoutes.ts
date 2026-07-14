import fs from "node:fs";
import path from "node:path";
import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import {
  MIMO_TTS_VOICE_CATALOG,
  type CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { z } from "zod";
import { llmProviderSchema } from "../../../../llm/providerSchema";
import { resolveAuthMode, type RequestWithApiAuth } from "../../../../middleware/auth";
import { validate } from "../../../../middleware/validate";
import {
  issueAudiobookMediaAccess,
  verifyAudiobookMediaAccess,
} from "../../../../services/audiobook/audiobookMediaAccess";
import { audiobookTaskService } from "../../../../services/audiobook/AudiobookTaskService";
import {
  resolveAudiobookTaskDir,
  resolveChapterAudioPath,
  resolveFullBookAudioPath,
} from "../../../../services/audiobook/audiobookPaths";

const novelParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const taskParamsSchema = z.object({
  id: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
});

const chapterAudioParamsSchema = z.object({
  id: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  chapterId: z.string().trim().min(1),
});

function isPathInside(parent: string, target: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedParent || resolvedTarget.startsWith(`${resolvedParent}${path.sep}`);
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!rangeHeader) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return "invalid";
  }
  const startRaw = match[1];
  const endRaw = match[2];
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;
  if (!startRaw && !endRaw) {
    return "invalid";
  }
  if (!startRaw) {
    // suffix: bytes=-N
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return "invalid";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) {
      return "invalid";
    }
    end = Number.isFinite(end) ? end : size - 1;
    if (end < start || start >= size) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function streamWavFile(
  req: import("express").Request,
  res: import("express").Response,
  filePath: string,
  downloadName: string,
): void {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({
      success: false,
      error: "音频文件不存在。",
    } satisfies ApiResponse<null>);
    return;
  }
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const range = parseRangeHeader(req.headers.range, size);

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);

  if (range === "invalid") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(chunkSize));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", String(size));
  fs.createReadStream(filePath).pipe(res);
}

function resolvePlayableFullPath(taskDir: string, stored: string | null | undefined): string {
  const fallback = resolveFullBookAudioPath(taskDir);
  const raw = stored?.trim();
  if (!raw || raw === "full-book.wav") {
    return fallback;
  }
  // 兼容历史绝对路径：仅当仍落在 taskDir 内时使用
  if (path.isAbsolute(raw) && isPathInside(taskDir, raw)) {
    return raw;
  }
  const joined = path.resolve(taskDir, raw);
  if (isPathInside(taskDir, joined)) {
    return joined;
  }
  return fallback;
}

function assertMediaAccess(input: {
  req: import("express").Request;
  res: import("express").Response;
  novelId: string;
  taskId: string;
  resource: { kind: "full" } | { kind: "chapter"; chapterId: string };
}): boolean {
  const headerAuthorized = Boolean((input.req as RequestWithApiAuth).apiAuthViaHeader);
  if (headerAuthorized) {
    return true;
  }
  // open 模式 middleware 已放行
  const access = typeof input.req.query?.access === "string" ? input.req.query.access : null;
  if (!access) {
    // open 且无 access：允许；token 模式无 access 应在 middleware 已拦，双保险
    if (resolveAuthMode() === "open") {
      return true;
    }
    input.res.status(401).json({
      success: false,
      error: "未授权：缺少有效的媒体访问令牌。",
    } satisfies ApiResponse<null>);
    return false;
  }
  const ok = verifyAudiobookMediaAccess({
    access,
    novelId: input.novelId,
    taskId: input.taskId,
    resource: input.resource,
  });
  if (!ok) {
    input.res.status(401).json({
      success: false,
      error: "未授权：媒体访问令牌无效或已过期。",
    } satisfies ApiResponse<null>);
    return false;
  }
  return true;
}

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

  router.get(
    "/:id/audiobook/tasks/:taskId/annotations",
    validate({ params: taskParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        const data = await audiobookTaskService.getAnnotations(taskId);
        if (data.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        res.status(200).json({
          success: true,
          data,
          message: "有声书标注结果。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/tasks/:taskId/chapters/:chapterId/reprocess",
    validate({
      params: chapterAudioParamsSchema,
      body: z.object({
        mode: z.enum(["reannotate", "resynthesize"]),
      }),
    }),
    async (req, res, next) => {
      try {
        const { id, taskId, chapterId } = req.params as z.infer<typeof chapterAudioParamsSchema>;
        const body = req.body as { mode: "reannotate" | "resynthesize" };
        const existing = await audiobookTaskService.getTask(taskId);
        if (!existing || existing.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        const data = await audiobookTaskService.reprocessChapter({
          taskId,
          chapterId,
          mode: body.mode,
        });
        res.status(200).json({
          success: true,
          data,
          message: body.mode === "reannotate"
            ? "已排队：重标并重合成该章。"
            : "已排队：按现有标注重合成该章。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  /** 签发短时媒体 URL（供 SPA 在 token 模式下给 <audio>/<a> 使用） */
  router.post(
    "/:id/audiobook/tasks/:taskId/media-access",
    validate({
      params: taskParamsSchema,
      body: z.object({
        resource: z.enum(["full", "chapter"]),
        chapterId: z.string().trim().min(1).optional(),
      }).superRefine((value, ctx) => {
        if (value.resource === "chapter" && !value.chapterId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "resource=chapter 时必须提供 chapterId。",
            path: ["chapterId"],
          });
        }
      }),
    }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        const body = req.body as { resource: "full" | "chapter"; chapterId?: string };
        const task = await audiobookTaskService.getTask(taskId);
        if (!task || task.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        if (body.resource === "chapter" && body.chapterId && !task.chapterIds.includes(body.chapterId)) {
          res.status(404).json({
            success: false,
            error: "章节不在该有声书任务范围内。",
          } satisfies ApiResponse<null>);
          return;
        }

        const resource = body.resource === "full"
          ? { kind: "full" as const }
          : { kind: "chapter" as const, chapterId: body.chapterId! };

        const issued = issueAudiobookMediaAccess({
          novelId: id,
          taskId,
          resource,
        });

        const pathSuffix = body.resource === "full"
          ? `/novels/${encodeURIComponent(id)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/full`
          : `/novels/${encodeURIComponent(id)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/chapters/${encodeURIComponent(body.chapterId!)}`;

        const data = issued
          ? {
              urlPath: `${pathSuffix}?access=${encodeURIComponent(issued.access)}`,
              access: issued.access,
              expiresAt: issued.expiresAt,
            }
          : {
              urlPath: pathSuffix,
              access: null as string | null,
              expiresAt: null as number | null,
            };

        res.status(200).json({
          success: true,
          data,
          message: "媒体访问令牌已签发。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/tasks/:taskId/audio/full",
    validate({ params: taskParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        if (!assertMediaAccess({
          req,
          res,
          novelId: id,
          taskId,
          resource: { kind: "full" },
        })) {
          return;
        }

        const task = await audiobookTaskService.getTask(taskId);
        if (!task || task.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }

        const taskDir = resolveAudiobookTaskDir(id, taskId);
        const preferred = resolvePlayableFullPath(taskDir, task.fullAudioPath);
        if (!isPathInside(taskDir, preferred)) {
          res.status(400).json({
            success: false,
            error: "音频路径非法。",
          } satisfies ApiResponse<null>);
          return;
        }
        streamWavFile(req, res, preferred, `audiobook-${taskId}-full.wav`);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/tasks/:taskId/audio/chapters/:chapterId",
    validate({ params: chapterAudioParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId, chapterId } = req.params as z.infer<typeof chapterAudioParamsSchema>;
        if (!assertMediaAccess({
          req,
          res,
          novelId: id,
          taskId,
          resource: { kind: "chapter", chapterId },
        })) {
          return;
        }

        const task = await audiobookTaskService.getTask(taskId);
        if (!task || task.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "有声书任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        if (!task.chapterIds.includes(chapterId)) {
          res.status(404).json({
            success: false,
            error: "章节不在该有声书任务范围内。",
          } satisfies ApiResponse<null>);
          return;
        }

        const taskDir = resolveAudiobookTaskDir(id, taskId);
        const filePath = resolveChapterAudioPath(taskDir, chapterId);
        if (!isPathInside(taskDir, filePath)) {
          res.status(400).json({
            success: false,
            error: "音频路径非法。",
          } satisfies ApiResponse<null>);
          return;
        }
        streamWavFile(req, res, filePath, `audiobook-${taskId}-${chapterId}.wav`);
      } catch (error) {
        next(error);
      }
    },
  );
}
