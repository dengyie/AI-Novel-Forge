import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { validate } from "../../../middleware/validate";
import { comicCharacterAssetService } from "../../../services/comic/ComicCharacterAssetService";
import { comicSceneService } from "../../../services/comic/ComicSceneService";
import { imageGenerateSchema } from "./imageRequestSchemas";
import { imageUploadBody } from "./imageUploadBody";
const router = Router();
const assetIdParams = z.object({ assetId: z.string().trim().min(1) });
const sceneIdParams = z.object({ sceneId: z.string().trim().min(1) });
const idParams = z.object({ id: z.string().trim().min(1) });
const charIdParams = z.object({ charId: z.string().trim().min(1) });

// ─── Character Assets ─────────────────────────────────────────────────────────

const createAssetSchema = z.object({
  characterId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  assetType: z.enum(["costume", "weapon", "item", "vehicle", "ability", "other"]),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const updateAssetSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(400).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  assetType: z.enum(["costume", "weapon", "item", "vehicle", "ability", "other"]).optional(),
});

// 列出某角色所有资产
router.get("/characters/:charId/assets", validate({ params: charIdParams }), async (req, res, next) => {
  try {
    const { charId } = req.params as z.infer<typeof charIdParams>;
    const data = await comicCharacterAssetService.listAssets(charId);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 列出项目所有资产
router.get("/projects/:id/character-assets", validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParams>;
    const data = await comicCharacterAssetService.listByProject(id);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 创建资产
router.post("/character-assets", validate({ body: createAssetSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createAssetSchema>;
    const data = await comicCharacterAssetService.createAsset(body);
    res.status(201).json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 更新资产元信息
router.patch("/character-assets/:assetId", validate({ params: assetIdParams, body: updateAssetSchema }), async (req, res, next) => {
  try {
    const { assetId } = req.params as z.infer<typeof assetIdParams>;
    const body = req.body as z.infer<typeof updateAssetSchema>;
    const data = await comicCharacterAssetService.updateAsset(assetId, body);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 删除资产
router.delete("/character-assets/:assetId", validate({ params: assetIdParams }), async (req, res, next) => {
  try {
    const { assetId } = req.params as z.infer<typeof assetIdParams>;
    await comicCharacterAssetService.deleteAsset(assetId);
    res.json({ success: true, data: null } satisfies ApiResponse<null>);
  } catch (err) { next(err); }
});

// AI 生成资产图
// 预览即将发送的素材（不消耗 token）
router.post("/character-assets/:assetId/prepare-image", validate({ params: assetIdParams }), async (req, res, next) => {
  try {
    const { assetId } = req.params as z.infer<typeof assetIdParams>;
    const provider = typeof req.body.provider === "string" ? req.body.provider : undefined;
    const data = await comicCharacterAssetService.prepareAssetImage(assetId, provider);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

router.post("/character-assets/:assetId/generate-image", validate({ params: assetIdParams }), async (req, res, next) => {
  try {
    const { assetId } = req.params as z.infer<typeof assetIdParams>;
    const body = req.body as {
      provider?: string;
      promptOverride?: string;
      sizeOverride?: string;
      providerOverride?: string;
      excludedReferenceImageUrls?: string[];
    };
    await comicCharacterAssetService.generateAssetImage(assetId, body.provider, {
      promptOverride: body.promptOverride,
      sizeOverride: body.sizeOverride as never,
      providerOverride: body.providerOverride,
      excludedReferenceImageUrls: body.excludedReferenceImageUrls,
    });
    const data = await comicCharacterAssetService.getAsset(assetId);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 上传资产图（Content-Type: image/* 直传，body 为原始二进制）
router.post(
  "/character-assets/:assetId/upload-image",
  validate({ params: assetIdParams }),
  ...imageUploadBody,
  async (req, res, next) => {
    try {
      const { assetId } = req.params as z.infer<typeof assetIdParams>;
      const mimeType = req.get("content-type")!.split(";")[0].trim().toLowerCase();
      const buffer = req.body as Buffer;
      const data = await comicCharacterAssetService.uploadAssetImage(assetId, buffer, mimeType);
      res.json({ success: true, data } satisfies ApiResponse<typeof data>);
    } catch (err) { next(err); }
  },
);

// 服务资产图文件
router.get("/character-assets/:assetId/image", validate({ params: assetIdParams }), async (req, res, next) => {
  try {
    const { assetId } = req.params as z.infer<typeof assetIdParams>;
    const { filePath, mimeType } = await comicCharacterAssetService.serveAssetImage(assetId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (err) { next(err); }
});

// ─── Scenes ───────────────────────────────────────────────────────────────────

const sceneBibleSchema = z.object({
  palette: z.string().trim().max(120).optional(),
  keyElements: z.string().trim().max(200).optional(),
  materials: z.string().trim().max(120).optional(),
  ambiance: z.string().trim().max(120).optional(),
  layout: z.string().trim().max(160).optional(),
});

const createSceneSchema = z.object({
  projectId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(60),
  sceneType: z.enum(["interior", "exterior", "landscape", "abstract", "other"]).optional(),
  bible: sceneBibleSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const updateSceneSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  sceneType: z.enum(["interior", "exterior", "landscape", "abstract", "other"]).optional(),
  bible: sceneBibleSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

// 列出项目所有场景
router.get("/projects/:id/scenes", validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.params as z.infer<typeof idParams>;
    const data = await comicSceneService.listByProject(id);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 创建场景
router.post("/scenes", validate({ body: createSceneSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSceneSchema>;
    const data = await comicSceneService.createScene(body);
    res.status(201).json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 更新场景（名称/类型/bible）
router.patch("/scenes/:sceneId", validate({ params: sceneIdParams, body: updateSceneSchema }), async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    const body = req.body as z.infer<typeof updateSceneSchema>;
    const data = await comicSceneService.updateScene(sceneId, body);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 删除场景
router.delete("/scenes/:sceneId", validate({ params: sceneIdParams }), async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    await comicSceneService.deleteScene(sceneId);
    res.json({ success: true, data: null } satisfies ApiResponse<null>);
  } catch (err) { next(err); }
});

// AI 生成场景设定图
router.post("/scenes/:sceneId/prepare-image", validate({ params: sceneIdParams, body: imageGenerateSchema }), async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    const body = (req.body ?? {}) as z.infer<typeof imageGenerateSchema>;
    const data = await comicSceneService.prepareSceneSheet(sceneId, body?.provider);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

router.post("/scenes/:sceneId/generate-image", validate({ params: sceneIdParams, body: imageGenerateSchema }), async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    const body = (req.body ?? {}) as z.infer<typeof imageGenerateSchema>;
    await comicSceneService.generateSceneSheet(sceneId, body?.provider, {
      promptOverride: body?.promptOverride,
      providerOverride: body?.providerOverride,
      sizeOverride: body?.sizeOverride as never,
      negativePromptOverride: body?.negativePromptOverride,
      excludedReferenceImageUrls: body?.excludedReferenceImageUrls,
    });
    const data = await comicSceneService.getScene(sceneId);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 上传场景设定图（Content-Type: image/* 直传）
router.post("/scenes/:sceneId/upload-image", validate({ params: sceneIdParams }), ...imageUploadBody, async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    const mimeType = req.get("content-type")!.split(";")[0].trim().toLowerCase();
      const buffer = req.body as Buffer;
    const data = await comicSceneService.uploadSceneImage(sceneId, buffer, mimeType);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (err) { next(err); }
});

// 服务场景图文件
router.get("/scenes/:sceneId/image", validate({ params: sceneIdParams }), async (req, res, next) => {
  try {
    const { sceneId } = req.params as z.infer<typeof sceneIdParams>;
    const { filePath, mimeType } = await comicSceneService.serveSceneImage(sceneId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (err) { next(err); }
});

export default router;
