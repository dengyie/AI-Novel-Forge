import fs from "node:fs";
import path from "node:path";
import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import {
  MIMO_TTS_VOICE_CATALOG,
  type AudiobookVoicePlanApplyResult,
  type AudiobookVoicePlanSuggestResult,
  type AudiobookVoicePreviewResult,
  type AudiobookVoiceReadinessJob,
  type AudiobookVoiceReadinessJobActiveErrorData,
  type AudiobookVoiceReadinessPrepareResult,
  type AudiobookVoiceReadinessSummary,
  type AudiobookWorkspaceBootstrap,
  type AudiobookWorkspaceOverviewResult,
  type CharacterVoiceAdoptPreviewAsCloneResult,
  type CharacterVoicePreviewAsset,
  type CharacterVoicePreviewGenerateResult,
  type CreateAudiobookTaskInput,
} from "@ai-novel/shared/types/audiobook";
import { z } from "zod";
import { llmProviderSchema } from "../../../../llm/providerSchema";
import { resolveAuthMode, type RequestWithApiAuth } from "../../../../middleware/auth";
import { AppError } from "../../../../middleware/errorHandler";
import { validate } from "../../../../middleware/validate";
import { prisma } from "../../../../db/prisma";
import {
  issueAudiobookMediaAccess,
  issueCharacterVoicePreviewAccess,
  issueVoiceLibraryAssetAccess,
  verifyAudiobookMediaAccess,
  verifyCharacterVoicePreviewAccess,
  verifyVoiceLibraryAssetAccess,
} from "../../../../services/audiobook/audiobookMediaAccess";
import {
  assertVoiceLibraryApproveToken,
  VOICE_LIBRARY_APPROVE_TOKEN_HEADER,
} from "../../../../services/audiobook/voiceLibraryApproveGate";
import { rewriteCharacterVoiceDesign } from "../../../../services/audiobook/voiceDesignRewriteService";
import { audiobookTaskService } from "../../../../services/audiobook/AudiobookTaskService";
import { audiobookVoiceAssetService } from "../../../../services/audiobook/AudiobookVoiceAssetService";
import { audiobookVoiceReadinessService } from "../../../../services/audiobook/AudiobookVoiceReadinessService";
import { buildAudiobookWorkspaceOverview } from "../../../../services/audiobook/audiobookWorkspaceOverview";
import {
  resolveAudiobookTaskDir,
  resolveChapterAudioPath,
  resolveCharacterVoicePreviewPath,
  resolveCharacterVoiceRefDir,
  resolveFullBookAudioPath,
  resolveFullBookM4bPath,
} from "../../../../services/audiobook/audiobookPaths";
import { isPathInside } from "../../../../services/audiobook/voiceRefPath";
import { voiceLibraryService } from "../../../../services/audiobook/voiceLibraryService";

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

const characterParamsSchema = z.object({
  id: z.string().trim().min(1),
  charId: z.string().trim().min(1),
});

const voiceLibraryMatchesQuerySchema = z.object({
  topN: z.coerce.number().int().min(1).max(32).optional(),
});

const characterVoicePreviewGenerateSchema = z.object({
  text: z.string().trim().max(200).optional(),
  candidates: z.number().int().min(1).max(5).optional(),
  autoAdoptWinner: z.boolean().optional(),
});

const characterVoicePreviewAdoptSchema = z.object({
  candidateId: z.string().trim().min(1).max(32),
});

const characterVoiceAdoptPreviewCloneSchema = z.object({
  candidateId: z.string().trim().min(1).max(32).optional(),
  regeneratePreviewUnderClone: z.boolean().optional(),
  contrastText: z.string().trim().max(200).optional(),
});

const characterVoicePreviewCandidateParamsSchema = z.object({
  id: z.string().trim().min(1),
  charId: z.string().trim().min(1),
  candidateId: z.string().trim().min(1).max(32),
});

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

function streamAudioFile(
  req: import("express").Request,
  res: import("express").Response,
  filePath: string,
  downloadName: string,
  contentType: string,
  disposition: "inline" | "attachment" = "inline",
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

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Disposition", `${disposition}; filename="${downloadName}"`);

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

function wantsAttachmentDownload(req: import("express").Request): boolean {
  const raw = req.query?.download;
  if (Array.isArray(raw)) {
    return raw.some((item) => item === "1" || item === "true");
  }
  return raw === "1" || raw === "true";
}

function streamWavFile(
  req: import("express").Request,
  res: import("express").Response,
  filePath: string,
  downloadName: string,
): void {
  const disposition = wantsAttachmentDownload(req) ? "attachment" : "inline";
  streamAudioFile(req, res, filePath, downloadName, "audio/wav", disposition);
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
  resource: { kind: "full" } | { kind: "full_m4b" } | { kind: "chapter"; chapterId: string };
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
  requireReadyPreview: z.boolean().optional(),
  /** 段级语境表演；默认服务端 off（听测前勿开） */
  deliveryStyleMode: z.enum(["off", "characters", "all"]).optional(),
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

const voicePlanSuggestSchema = z.object({
  onlyMissing: z.boolean().optional(),
  characterIds: z.array(z.string().trim().min(1)).max(200).optional(),
  strategy: z.enum(["auto", "preset_only", "prefer_design", "prefer_library"]).optional(),
  maxImportantPerPreset: z.number().int().min(1).max(8).optional(),
  reservedPresets: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
});

const voicePlanApplySchema = z.object({
  overwrite: z.boolean().optional(),
  items: z
    .array(
      z.object({
        characterId: z.string().trim().min(1),
        ttsMode: z.enum(["preset", "design", "clone"]),
        ttsVoice: z.string().trim().max(64).nullable().optional(),
        ttsStyle: z.string().trim().max(500).nullable().optional(),
        ttsDesignPrompt: z.string().trim().max(2000).nullable().optional(),
        /** clone 时必填；服务端 assert approved 后 bind，禁止客户端 path */
        ttsVoiceAssetId: z.string().trim().min(1).max(64).nullable().optional(),
        speakerAliases: z.array(z.string().trim().min(1).max(64)).max(24).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const voicePreviewSchema = z.object({
  characterId: z.string().trim().min(1).optional(),
  ttsMode: z.enum(["preset", "design", "clone"]).optional(),
  ttsVoice: z.string().trim().max(64).nullable().optional(),
  ttsStyle: z.string().trim().max(500).nullable().optional(),
  ttsDesignPrompt: z.string().trim().max(2000).nullable().optional(),
  text: z.string().trim().max(200).optional(),
});

const voiceReadinessAssessQuerySchema = z.object({
  characterIds: z.union([z.string(), z.array(z.string())]).optional(),
});

function parseCharacterIdsQuery(raw: unknown): string[] | undefined {
  if (raw == null) {
    return undefined;
  }
  const parts = Array.isArray(raw) ? raw : [raw];
  const ids = parts
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (!ids.length) {
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= 200) {
      break;
    }
  }
  return out;
}

const voiceReadinessPrepareSchema = z.object({
  characterIds: z.array(z.string().trim().min(1)).max(200).optional(),
  fillMissingVoice: z.boolean().optional(),
  generatePreview: z.boolean().optional(),
  regenerateStale: z.boolean().optional(),
  planStrategy: z.enum(["auto", "preset_only", "prefer_design", "prefer_library"]).optional(),
  previewText: z.string().trim().max(200).optional(),
  candidatesPerCharacter: z.number().int().min(1).max(5).optional(),
});

const voiceReadinessJobParamsSchema = z.object({
  id: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
});

const workspaceOverviewBodySchema = z.object({
  novelIds: z.array(z.string()).max(200).default([]),
});

export function registerNovelAudiobookRoutes(input: { router: Router }): void {
  const { router } = input;


  // ---------- 全站 VoiceAsset 库（Milestone A）----------
  router.get("/audiobook/voice-library", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const parseEnumList = <T extends string>(
        raw: string | undefined,
        allowed: readonly T[],
        label: string,
      ): T[] | undefined => {
        if (!raw?.trim()) return undefined;
        const parts = raw.includes(",")
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : [raw.trim()];
        const invalid = parts.filter((p) => !(allowed as readonly string[]).includes(p));
        if (invalid.length > 0) {
          throw new AppError(`${label} 非法：${invalid.join(", ")}`, 400);
        }
        return parts as T[];
      };
      const parseFiniteInt = (raw: string | undefined): number | undefined => {
        if (raw == null || !String(raw).trim()) return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.floor(n) : undefined;
      };
      const data = voiceLibraryService.list({
        status: parseEnumList(
          q.status,
          ["draft", "approved", "archived", "deprecated"] as const,
          "status",
        ),
        kind: parseEnumList(
          q.kind,
          ["clone_ref", "design_prompt", "preset_alias"] as const,
          "kind",
        ),
        tag: q.tag,
        q: q.q,
        limit: parseFiniteInt(q.limit),
        offset: parseFiniteInt(q.offset),
      });
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/audiobook/voice-library/import-file",
    validate({
      body: z.object({
        sourcePath: z.string().trim().min(1),
        slug: z.string().trim().min(1).max(80),
        displayName: z.string().trim().min(1).max(120),
        kind: z.enum(["clone_ref", "design_prompt", "preset_alias"]).optional(),
        // 禁止 HTTP 直批 approved；人耳批准走 PATCH status
        status: z.enum(["draft", "archived", "deprecated"]).optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(32).optional(),
        sampleText: z.string().trim().max(500).nullable().optional(),
        designPrompt: z.string().trim().max(2000).nullable().optional(),
        license: z.object({
          source: z.string().trim().min(1).max(200),
          rights: z.string().trim().min(1).max(200),
          notes: z.string().trim().max(1000).nullable().optional(),
          url: z.string().trim().max(500).nullable().optional(),
        }),
        backendTargets: z.array(z.enum(["mimo_chat_audio", "kokoro", "other"])).optional(),
        packId: z.string().trim().max(80).nullable().optional(),
        overwrite: z.boolean().optional(),
      }),
    }),
    async (req, res, next) => {
      try {
        const data = voiceLibraryService.importFromFile(req.body);
        res.status(201).json({ success: true, data } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/audiobook/voice-library/import-seed-pack",
    validate({
      body: z.object({
        packRoot: z.string().trim().min(1).optional(),
        // 禁止 forceStatus=approved（服务层亦拒绝）
        forceStatus: z.enum(["draft", "archived", "deprecated"]).nullable().optional(),
        overwrite: z.boolean().optional(),
      }).optional(),
    }),
    async (req, res, next) => {
      try {
        const data = voiceLibraryService.importYuanworldSeedPack(req.body ?? {});
        res.status(201).json({ success: true, data } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/audiobook/voice-library/:assetId",
    validate({ params: z.object({ assetId: z.string().trim().min(1) }) }),
    async (req, res, next) => {
      try {
        const { assetId } = req.params as { assetId: string };
        const asset = voiceLibraryService.getById(assetId);
        if (!asset) {
          throw new AppError("VoiceAsset 不存在。", 404);
        }
        res.json({ success: true, data: asset } satisfies ApiResponse<typeof asset>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/audiobook/voice-library/:assetId/status",
    validate({
      params: z.object({ assetId: z.string().trim().min(1) }),
      body: z.object({
        status: z.enum(["draft", "approved", "archived", "deprecated"]),
      }),
    }),
    async (req, res, next) => {
      try {
        const { assetId } = req.params as { assetId: string };
        const headerRaw =
          req.header(VOICE_LIBRARY_APPROVE_TOKEN_HEADER)
          ?? req.header("X-Voice-Library-Approve-Token");
        assertVoiceLibraryApproveToken({
          nextStatus: req.body.status,
          headerToken: headerRaw,
        });
        const data = voiceLibraryService.setStatus(assetId, req.body.status);
        res.json({ success: true, data } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  /** 库级试听 media-access：clone_ref 直接播 ref.wav（draft 可听）。 */
  router.post(
    "/audiobook/voice-library/:assetId/media-access",
    validate({ params: z.object({ assetId: z.string().trim().min(1) }) }),
    async (req, res, next) => {
      try {
        const { assetId } = req.params as { assetId: string };
        voiceLibraryService.resolveLibraryPreviewAudioPath(assetId);
        const issued = issueVoiceLibraryAssetAccess({ assetId });
        const pathSuffix = `/novels/audiobook/voice-library/${encodeURIComponent(assetId)}/audio`;
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
          message: "库资产试听媒体访问令牌已签发。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/audiobook/voice-library/:assetId/audio",
    validate({ params: z.object({ assetId: z.string().trim().min(1) }) }),
    async (req, res, next) => {
      try {
        const { assetId } = req.params as { assetId: string };
        const headerAuthorized = Boolean((req as RequestWithApiAuth).apiAuthViaHeader);
        if (!headerAuthorized) {
          const access = typeof req.query?.access === "string" ? req.query.access : null;
          const mode = resolveAuthMode();
          if (mode === "token") {
            if (!verifyVoiceLibraryAssetAccess({ access, assetId })) {
              res.status(401).json({
                success: false,
                error: "未授权：库试听媒体令牌无效或已过期。",
              } satisfies ApiResponse<null>);
              return;
            }
          }
        }
        const { absolutePath } = voiceLibraryService.resolveLibraryPreviewAudioPath(assetId);
        // 实际拉流才记人耳；media-access 签发不算
        try {
          voiceLibraryService.markLibraryPreviewHeard(assetId);
        } catch (markError) {
          // 标记失败不阻断试听；approve 仍会被 heard 门禁拦住
          console.warn(
            "voice_library_mark_heard_failed",
            assetId,
            markError instanceof Error ? markError.message : String(markError),
          );
        }
        streamWavFile(req, res, absolutePath, `voice-library-${assetId}.wav`);
      } catch (error) {
        next(error);
      }
    },
  );

  /** design rewrite：返回候选，不写角色卡。 */
  router.post(
    "/:id/characters/:charId/voice-design/rewrite",
    validate({
      params: characterParamsSchema,
      body: z.object({
        currentDesignPrompt: z.string().trim().max(2000).nullable().optional(),
        notes: z.string().trim().max(400).nullable().optional(),
        provider: z.string().trim().max(80).nullable().optional(),
        model: z.string().trim().max(120).nullable().optional(),
      }).optional(),
    }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const data = await rewriteCharacterVoiceDesign({
          novelId: id,
          characterId: charId,
          body: req.body ?? {},
        });
        res.status(200).json({
          success: true,
          data,
          message: "design 候选已生成（未写入角色卡）。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/characters/:charId/voice-library/bind",
    validate({
      params: characterParamsSchema,
      body: z.object({
        voiceAssetId: z.string().trim().min(1).max(80),
      }),
    }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        // 合成绑库恒 require approved；不接受客户端旁路
        const data = await voiceLibraryService.bindCharacter(id, charId, {
          voiceAssetId: req.body.voiceAssetId,
        });
        res.json({ success: true, data } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/characters/:charId/voice-library/matches",
    validate({
      params: characterParamsSchema,
      query: voiceLibraryMatchesQuerySchema,
    }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        // Express 5 的 req.query 是只读 getter，validate 中间件无法回写 coerce 结果，
        // 故在此重新 parse 取 number 化的 topN（与 novelBaseRoutes 分页同约定）。
        const { topN } = voiceLibraryMatchesQuerySchema.parse(req.query);
        const data = await audiobookVoiceAssetService.listVoiceLibraryMatches(id, charId, {
          topN,
        });
        res.json({ success: true, data } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

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

  /**
   * 选书页 bulk 态势：单次批量读库 + 纯函数摘要 + 每本 latest task。
   * 禁止 N× assess；列表不 probe clone 文件。
   */
  router.post(
    "/audiobook/workspace-overview",
    validate({ body: workspaceOverviewBodySchema }),
    async (req, res, next) => {
      try {
        const body = req.body as z.infer<typeof workspaceOverviewBodySchema>;
        const data = await buildAudiobookWorkspaceOverview(body.novelIds ?? []);
        res.status(200).json({
          success: true,
          data,
          message: data.truncated
            ? "有声书工作台态势（已截断至 50 本）。"
            : "有声书工作台态势。",
        } satisfies ApiResponse<AudiobookWorkspaceOverviewResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  /** 有声书工作台首屏：轻量章节选项 + 角色音色字段（不含正文）。 */
  router.get(
    "/:id/audiobook/workspace",
    validate({ params: novelParamsSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const data = await audiobookVoiceAssetService.getWorkspaceBootstrap(id);
        // 路由层组装 readiness，避免 VoiceAssetService ↔ ReadinessService 循环依赖（D 架构）
        const summary = audiobookVoiceReadinessService.buildSummaryFromRows({
          novelId: data.novelId,
          narratorVoice: data.audiobookNarratorVoice,
          narratorStyle: data.audiobookNarratorStyle,
          characters: data.characters,
        });
        const readiness = audiobookVoiceReadinessService.toBootstrapReadiness(
          summary,
          audiobookVoiceReadinessService.getActiveJobId(id),
        );
        const payload: AudiobookWorkspaceBootstrap = {
          ...data,
          readiness,
        };
        res.status(200).json({
          success: true,
          data: payload,
          message: "有声书工作台数据。",
        } satisfies ApiResponse<AudiobookWorkspaceBootstrap>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/voice-readiness",
    validate({ params: novelParamsSchema, query: voiceReadinessAssessQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const characterIds = parseCharacterIdsQuery(req.query.characterIds);
        const data = await audiobookVoiceReadinessService.assess(id, {
          characterIds,
        });
        res.status(200).json({
          success: true,
          data,
          message: data.readyForWorkbench
            ? "音色与试听均已就绪。"
            : data.voiceOk
              ? "音色已就绪，试听尚有缺口。"
              : "音色尚未就绪。",
        } satisfies ApiResponse<AudiobookVoiceReadinessSummary>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/voice-readiness/prepare",
    validate({ params: novelParamsSchema, body: voiceReadinessPrepareSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof voiceReadinessPrepareSchema>;
        const data = await audiobookVoiceReadinessService.prepare(id, body);
        res.status(202).json({
          success: true,
          data,
          message: data.job.status === "succeeded"
            ? "无需操作，已返回完成任务。"
            : "音色就绪任务已创建。",
        } satisfies ApiResponse<AudiobookVoiceReadinessPrepareResult>);
      } catch (error) {
        // D17：409 使用 data 承载 code/activeJobId，不改全局 ApiResponse
        if (
          error instanceof AppError
          && error.statusCode === 409
          && error.details
          && typeof error.details === "object"
          && (error.details as AudiobookVoiceReadinessJobActiveErrorData).code === "READINESS_JOB_ACTIVE"
        ) {
          const details = error.details as AudiobookVoiceReadinessJobActiveErrorData;
          res.status(409).json({
            success: false,
            error: error.message,
            data: {
              code: details.code,
              activeJobId: details.activeJobId,
            },
          } satisfies ApiResponse<AudiobookVoiceReadinessJobActiveErrorData>);
          return;
        }
        next(error);
      }
    },
  );

  router.get(
    "/:id/audiobook/voice-readiness/jobs/:jobId",
    validate({ params: voiceReadinessJobParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, jobId } = req.params as z.infer<typeof voiceReadinessJobParamsSchema>;
        const job = audiobookVoiceReadinessService.getJob(jobId);
        if (!job || job.novelId !== id) {
          res.status(404).json({
            success: false,
            error: "就绪任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        res.status(200).json({
          success: true,
          data: job,
          message: "音色就绪任务状态。",
        } satisfies ApiResponse<AudiobookVoiceReadinessJob>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/voice-readiness/jobs/:jobId/cancel",
    validate({ params: voiceReadinessJobParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, jobId } = req.params as z.infer<typeof voiceReadinessJobParamsSchema>;
        const data = audiobookVoiceReadinessService.cancelJob(id, jobId);
        res.status(200).json({
          success: true,
          data,
          message: data.status === "cancelled" || data.cancelRequested
            ? "已请求取消就绪任务。"
            : "就绪任务状态已返回。",
        } satisfies ApiResponse<AudiobookVoiceReadinessJob>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/voice-plan/suggest",
    validate({ params: novelParamsSchema, body: voicePlanSuggestSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof voicePlanSuggestSchema>;
        const data = await audiobookVoiceAssetService.suggest(id, body);
        res.status(200).json({
          success: true,
          data,
          message: `音色规划完成：${data.summary.planned} 项（preset ${data.summary.presetCount} / design ${data.summary.designCount} / clone ${data.summary.cloneCount}）。`,
        } satisfies ApiResponse<AudiobookVoicePlanSuggestResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/voice-plan/apply",
    validate({ params: novelParamsSchema, body: voicePlanApplySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof voicePlanApplySchema>;
        const data = await audiobookVoiceAssetService.apply(id, body);
        res.status(200).json({
          success: true,
          data,
          message: `已写入 ${data.applied.length} 个角色音色，跳过 ${data.skipped.length}。`,
        } satisfies ApiResponse<AudiobookVoicePlanApplyResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audiobook/voice-preview",
    validate({ params: novelParamsSchema, body: voicePreviewSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof novelParamsSchema>;
        const body = req.body as z.infer<typeof voicePreviewSchema>;
        const data = await audiobookVoiceAssetService.preview(id, body);
        res.status(200).json({
          success: true,
          data,
          message: body.characterId?.trim()
            ? "试听资产已生成并写入角色卡。"
            : "临时试听音频已生成（未写入角色卡）。",
        } satisfies ApiResponse<AudiobookVoicePreviewResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/characters/:charId/voice-preview/generate",
    validate({ params: characterParamsSchema, body: characterVoicePreviewGenerateSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const body = req.body as z.infer<typeof characterVoicePreviewGenerateSchema>;
        const data = await audiobookVoiceAssetService.generateCharacterPreview(id, charId, body);
        const message = data.adopted
          ? `试听已生成并写入角色卡（${data.candidates.length} 条候选，已自动采用）。`
          : `试听已多抽 ${data.candidates.length} 条，请听后选择采用。`;
        res.status(200).json({
          success: true,
          data,
          message,
        } satisfies ApiResponse<CharacterVoicePreviewGenerateResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/characters/:charId/voice-preview/adopt-candidate",
    validate({ params: characterParamsSchema, body: characterVoicePreviewAdoptSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const body = req.body as z.infer<typeof characterVoicePreviewAdoptSchema>;
        const data = await audiobookVoiceAssetService.adoptPreviewCandidate(id, charId, body);
        res.status(200).json({
          success: true,
          data,
          message: "已采用所选试听候选。",
        } satisfies ApiResponse<CharacterVoicePreviewAsset>);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * Design→Clone：选优 preview 升格为 ref.wav + ttsMode=clone。
   * lead 强烈推荐；禁止无 ready preview 半绑定。
   */
  router.post(
    "/:id/characters/:charId/voice-preview/adopt-preview-clone",
    validate({ params: characterParamsSchema, body: characterVoiceAdoptPreviewCloneSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const body = req.body as z.infer<typeof characterVoiceAdoptPreviewCloneSchema>;
        const data = await audiobookVoiceAssetService.adoptPreviewAsClone(id, charId, body);
        res.status(200).json({
          success: true,
          data,
          message: data.contrastPreview
            ? "已锁定为克隆身份，并生成对照试听。"
            : "已将选优试听锁定为克隆身份（长书防漂）。",
        } satisfies ApiResponse<CharacterVoiceAdoptPreviewAsCloneResult>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/characters/:charId/voice-preview",
    validate({ params: characterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const data = await audiobookVoiceAssetService.getCharacterPreview(id, charId);
        res.status(200).json({
          success: true,
          data,
          message: "角色试听资产状态。",
        } satisfies ApiResponse<CharacterVoicePreviewAsset>);
      } catch (error) {
        next(error);
      }
    },
  );

  /** 签发角色固定试听的短时播放 URL。 */
  router.post(
    "/:id/characters/:charId/voice-preview/media-access",
    validate({ params: characterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const asset = await audiobookVoiceAssetService.getCharacterPreview(id, charId);
        if (asset.status === "missing" || !asset.audioUrl) {
          res.status(404).json({
            success: false,
            error: "试听资产不存在，请先在角色卡生成试听。",
          } satisfies ApiResponse<null>);
          return;
        }
        const issued = issueCharacterVoicePreviewAccess({ novelId: id, characterId: charId });
        const pathSuffix = asset.audioUrl;
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
          message: "试听媒体访问令牌已签发。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/characters/:charId/voice-preview/audio",
    validate({ params: characterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, charId } = req.params as z.infer<typeof characterParamsSchema>;
        const headerAuthorized = Boolean((req as RequestWithApiAuth).apiAuthViaHeader);
        if (!headerAuthorized) {
          const access = typeof req.query?.access === "string" ? req.query.access : null;
          const mode = resolveAuthMode();
          if (mode === "token") {
            if (!verifyCharacterVoicePreviewAccess({ access, novelId: id, characterId: charId })) {
              res.status(401).json({
                success: false,
                error: "未授权：试听媒体令牌无效或已过期。",
              } satisfies ApiResponse<null>);
              return;
            }
          }
        }

        const character = await prisma.character.findFirst({
          where: { id: charId, novelId: id },
          select: { ttsPreviewAudioPath: true },
        });
        if (!character) {
          res.status(404).json({
            success: false,
            error: "角色不存在。",
          } satisfies ApiResponse<null>);
          return;
        }

        const refDir = resolveCharacterVoiceRefDir(id, charId);
        const preferred = character.ttsPreviewAudioPath?.trim()
          || resolveCharacterVoicePreviewPath(id, charId);
        if (!isPathInside(refDir, preferred)) {
          res.status(400).json({
            success: false,
            error: "试听路径非法。",
          } satisfies ApiResponse<null>);
          return;
        }
        streamWavFile(req, res, preferred, `character-${charId}-preview.wav`);
      } catch (error) {
        next(error);
      }
    },
  );

  /** 多抽候选 WAV 播放（path 必须在 voice-refs 角色目录内）。 */
  router.get(
    "/:id/characters/:charId/voice-preview/candidates/:candidateId/audio",
    validate({ params: characterVoicePreviewCandidateParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, charId, candidateId } = req.params as z.infer<
          typeof characterVoicePreviewCandidateParamsSchema
        >;
        const headerAuthorized = Boolean((req as RequestWithApiAuth).apiAuthViaHeader);
        if (!headerAuthorized) {
          const access = typeof req.query?.access === "string" ? req.query.access : null;
          const mode = resolveAuthMode();
          if (mode === "token") {
            if (!verifyCharacterVoicePreviewAccess({ access, novelId: id, characterId: charId })) {
              res.status(401).json({
                success: false,
                error: "未授权：试听媒体令牌无效或已过期。",
              } satisfies ApiResponse<null>);
              return;
            }
          }
        }

        const preferred = audiobookVoiceAssetService.resolvePreviewCandidateFilePath(
          id,
          charId,
          candidateId,
        );
        if (!preferred) {
          res.status(404).json({
            success: false,
            error: "试听候选不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        const refDir = resolveCharacterVoiceRefDir(id, charId);
        if (!isPathInside(refDir, preferred)) {
          res.status(400).json({
            success: false,
            error: "试听候选路径非法。",
          } satisfies ApiResponse<null>);
          return;
        }
        streamWavFile(req, res, preferred, `character-${charId}-preview-${candidateId}.wav`);
      } catch (error) {
        next(error);
      }
    },
  );

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
        resource: z.enum(["full", "full_m4b", "chapter"]),
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
        const body = req.body as { resource: "full" | "full_m4b" | "chapter"; chapterId?: string };
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
          : body.resource === "full_m4b"
            ? { kind: "full_m4b" as const }
            : { kind: "chapter" as const, chapterId: body.chapterId! };

        const issued = issueAudiobookMediaAccess({
          novelId: id,
          taskId,
          resource,
        });

        const pathSuffix = body.resource === "full"
          ? `/novels/${encodeURIComponent(id)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/full`
          : body.resource === "full_m4b"
            ? `/novels/${encodeURIComponent(id)}/audiobook/tasks/${encodeURIComponent(taskId)}/audio/full.m4b`
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

  router.get(
    "/:id/audiobook/tasks/:taskId/audio/full.m4b",
    validate({ params: taskParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, taskId } = req.params as z.infer<typeof taskParamsSchema>;
        if (!assertMediaAccess({
          req,
          res,
          novelId: id,
          taskId,
          resource: { kind: "full_m4b" },
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
        const filePath = resolveFullBookM4bPath(taskDir);
        if (!isPathInside(taskDir, filePath)) {
          res.status(400).json({
            success: false,
            error: "音频路径非法。",
          } satisfies ApiResponse<null>);
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.status(404).json({
            success: false,
            error: "m4b 尚未生成（本机/运行环境可能缺少 ffmpeg，或任务仍在进行）。",
          } satisfies ApiResponse<null>);
          return;
        }
        streamAudioFile(
          req,
          res,
          filePath,
          `audiobook-${taskId}-full.m4b`,
          "audio/mp4",
          // m4b 默认 attachment；显式 download=1 时同样 attachment
          "attachment",
        );
      } catch (error) {
        next(error);
      }
    },
  );
}
