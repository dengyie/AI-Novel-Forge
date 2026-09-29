import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { validate } from "../../../middleware/validate";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { ComicProjectService } from "../../../services/comic/ComicProjectService";
import { comicCharacterImageService } from "../../../services/comic/ComicCharacterImageService";
import { imageGenerateSchema, excludedReferenceImageUrlsSchema } from "./imageRequestSchemas";
const comicProjectService = new ComicProjectService();
const router = Router();
const charIdParams = z.object({ charId: z.string().trim().min(1) });
const charSheetVersionParams = z.object({ charId: z.string().trim().min(1), version: z.coerce.number().int().min(1) });

// ─── Character sheet images ───────────────────────────────────────────────────

const charSheetGenerateSchema = z
  .object({
    provider: z.string().trim().optional(),
    prompt: z.string().trim().max(4000).optional(),
    useCurrentImageAsReference: z.boolean().optional(),
    lockAppearance: z.boolean().optional(),
    appearanceOverride: z.string().trim().max(1000).optional(),
    promptOverride: z.string().trim().max(4000).optional(),
    providerOverride: z.string().trim().optional(),
    sizeOverride: z.string().trim().max(20).optional(),
    excludedReferenceImageUrls: excludedReferenceImageUrlsSchema,
  })
  .optional();
const charExpressionGenerateSchema = imageGenerateSchema;

router.post(
  "/characters/:charId/sheet/prepare",
  validate({ params: charIdParams, body: charSheetGenerateSchema }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const body = (req.body ?? {}) as z.infer<typeof charSheetGenerateSchema>;
      const data = await comicCharacterImageService.prepareCharacterSheet(
        charId,
        body?.provider as Parameters<typeof comicCharacterImageService.prepareCharacterSheet>[1] | undefined,
        {
          prompt: body?.prompt,
          useCurrentImageAsReference: body?.useCurrentImageAsReference,
          lockAppearance: body?.lockAppearance,
          appearanceOverride: body?.appearanceOverride,
        },
      );
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

router.post(
  "/characters/:charId/sheet/generate",
  validate({ params: charIdParams, body: charSheetGenerateSchema }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const body = (req.body ?? {}) as z.infer<typeof charSheetGenerateSchema>;
      const data = await comicCharacterImageService.generateCharacterSheet(
        charId,
        body?.provider as Parameters<typeof comicCharacterImageService.generateCharacterSheet>[1] | undefined,
        {
          prompt: body?.prompt,
          useCurrentImageAsReference: body?.useCurrentImageAsReference,
          lockAppearance: body?.lockAppearance,
          appearanceOverride: body?.appearanceOverride,
        },
        {
          promptOverride: body?.promptOverride,
          providerOverride: body?.providerOverride,
          sizeOverride: body?.sizeOverride as never,
          excludedReferenceImageUrls: body?.excludedReferenceImageUrls,
        },
      );
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

router.get("/characters/:charId/sheet", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const data = await comicCharacterImageService.getSheetData(charId);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// AI 协助重写"外貌锚点"——返回建议给前端审阅，不直接保存
router.post(
  "/characters/:charId/visual-anchor/rewrite",
  validate({
    params: charIdParams,
    body: z.object({
      userInstruction: z.string().trim().max(500).optional(),
      provider: z.string().trim().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const body = req.body as { userInstruction?: string; provider?: string };
      const data = await comicProjectService.rewriteCharacterVisualAnchor(charId, {
        userInstruction: body.userInstruction,
        provider: body.provider as LLMProvider | undefined,
      });
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

// 更新角色性别（生图链路的 GENDER LOCK 来源）
router.patch(
  "/characters/:charId/gender",
  validate({
    params: charIdParams,
    body: z.object({ gender: z.enum(["male", "female", "other", "unknown"]) }),
  }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const { gender } = req.body as { gender: "male" | "female" | "other" | "unknown" };
      const data = await comicProjectService.updateCharacterGender(charId, gender);
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

// 更新角色"外貌锚点"—— 所有生图链路的源头
// appearance：主外貌；faceShapeOverride：脸型强覆盖（与 appearance 冲突时高优先级）
router.patch(
  "/characters/:charId/visual-anchor",
  validate({
    params: charIdParams,
    body: z.object({
      appearance: z.string().trim().min(1).max(2000).optional(),
      faceShapeOverride: z.string().trim().max(500).optional(),
    }).refine((b) => b.appearance !== undefined || b.faceShapeOverride !== undefined, {
      message: "至少需要提供 appearance 或 faceShapeOverride 之一",
    }),
  }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const data = await comicProjectService.updateCharacterVisualAnchor(charId, req.body);
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

router.post(
  "/characters/:charId/expressions/prepare",
  validate({ params: charIdParams, body: charExpressionGenerateSchema }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const body = (req.body ?? {}) as z.infer<typeof charExpressionGenerateSchema>;
      const data = await comicCharacterImageService.prepareExpressionSheet(
        charId,
        body?.provider as Parameters<typeof comicCharacterImageService.prepareExpressionSheet>[1] | undefined,
      );
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

router.post(
  "/characters/:charId/expressions/generate",
  validate({ params: charIdParams, body: charExpressionGenerateSchema }),
  async (req, res, next) => {
    try {
      const { charId } = req.params as z.infer<typeof charIdParams>;
      const body = (req.body ?? {}) as z.infer<typeof charExpressionGenerateSchema>;
      const data = await comicCharacterImageService.generateExpressionSheet(
        charId,
        body?.provider as Parameters<typeof comicCharacterImageService.generateExpressionSheet>[1] | undefined,
        {
          promptOverride: body?.promptOverride,
          providerOverride: body?.providerOverride,
          sizeOverride: body?.sizeOverride as never,
          negativePromptOverride: body?.negativePromptOverride,
          excludedReferenceImageUrls: body?.excludedReferenceImageUrls,
        },
      );
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

router.get("/characters/:charId/expressions", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const data = await comicCharacterImageService.getExpressionData(charId);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 设计稿图片文件（供 <img src> 直接访问）
router.get("/character-images/:charId/sheet", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const file = await comicCharacterImageService.resolveSheetFile(charId);
    if (!file) {
      res.status(404).json({ success: false, error: "设计稿尚未生成。" } satisfies ApiResponse<null>);
      return;
    }
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(await import("fs/promises").then((fs) => fs.readFile(file.filePath)));
  } catch (err) { next(err); }
});

router.get("/character-images/:charId/expressions", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const file = await comicCharacterImageService.resolveExpressionFile(charId);
    if (!file) {
      res.status(404).json({ success: false, error: "表情设计稿尚未生成。" } satisfies ApiResponse<null>);
      return;
    }
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(await import("fs/promises").then((fs) => fs.readFile(file.filePath)));
  } catch (err) { next(err); }
});

router.get("/character-images/:charId/face", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const file = await comicCharacterImageService.resolveFaceRegionFile(charId);
    if (!file) {
      res.status(404).json({ success: false, error: "角色面部参考图尚未生成。" } satisfies ApiResponse<null>);
      return;
    }
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(await import("fs/promises").then((fs) => fs.readFile(file.filePath)));
  } catch (err) { next(err); }
});

router.get("/character-images/:charId/sheet/v:version", validate({ params: charSheetVersionParams }), async (req, res, next) => {
  try {
    const parsed = charSheetVersionParams.parse(req.params);
    const { charId, version } = parsed;
    const file = await comicCharacterImageService.resolveArchivedSheetFile(charId, version);
    if (!file) {
      res.status(404).json({ success: false, error: "历史设计稿不存在。" } satisfies ApiResponse<null>);
      return;
    }
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(await import("fs/promises").then((fs) => fs.readFile(file.filePath)));
  } catch (err) { next(err); }
});

export default router;
