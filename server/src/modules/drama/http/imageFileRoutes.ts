import { Router } from "express";
import { z } from "zod";
import { validate } from "../../../middleware/validate";
import { dramaCharacterImageService } from "../../../services/drama/DramaCharacterImageService";
import { dramaShotKeyframeService } from "../../../services/drama/visual/DramaShotKeyframeService";
const router = Router();
const shotImageParamsSchema = z.object({ shotId: z.string().trim().min(1) });
const shotImageVersionParamsSchema = z.object({
  shotId: z.string().trim().min(1),
  version: z.string().trim().regex(/^v?\d+$/),
});
const charImageParamsSchema = z.object({
  characterId: z.string().trim().min(1),
});
const charImageVersionParamsSchema = z.object({
  characterId: z.string().trim().min(1),
  version: z.string().trim().regex(/^v?\d+$/),
});
// ─────────────────────────────────────────────────────────────────────────────
// 角色图片文件服务（本地存储直出）
// ─────────────────────────────────────────────────────────────────────────────

const threeViewParamsSchema = z.object({
  characterId: z.string().trim().min(1),
  view: z.enum(["front", "side", "back"]),
});

/** GET /api/drama/shot-images/:shotId/keyframe */
router.get("/shot-images/:shotId/keyframe", validate({ params: shotImageParamsSchema }), async (req, res, next) => {
  try {
    const { shotId } = req.params as z.infer<typeof shotImageParamsSchema>;
    const resolved = await dramaShotKeyframeService.resolveExistingKeyframePath(shotId);
    if (!resolved) {
      res.status(404).json({ success: false, message: "镜头首帧图尚未生成。" });
      return;
    }
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/drama/shot-images/:shotId/keyframe/v1 */
router.get("/shot-images/:shotId/keyframe/:version", validate({ params: shotImageVersionParamsSchema }), async (req, res, next) => {
  try {
    const { shotId, version } = req.params as z.infer<typeof shotImageVersionParamsSchema>;
    const numericVersion = Number(version.replace(/^v/i, ""));
    const resolved = await dramaShotKeyframeService.resolveArchivedKeyframePath(shotId, numericVersion);
    if (!resolved) {
      res.status(404).json({ success: false, message: "镜头首帧历史版本尚未生成。" });
      return;
    }
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/drama/character-images/:characterId/character-sheet */
router.get("/character-images/:characterId/character-sheet", async (req, res, next) => {
  try {
    const { characterId } = req.params as z.infer<typeof charImageParamsSchema>;
    const resolved = await dramaCharacterImageService.resolveExistingImagePath(
      characterId,
      "character-sheet",
    );
    if (!resolved) {
      res.status(404).json({ success: false, message: "角色设计稿尚未生成。" });
      return;
    }
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/drama/character-images/:characterId/character-sheet/v1 */
router.get("/character-images/:characterId/character-sheet/:version", validate({ params: charImageVersionParamsSchema }), async (req, res, next) => {
  try {
    const { characterId, version } = req.params as z.infer<typeof charImageVersionParamsSchema>;
    const numericVersion = Number(version.replace(/^v/i, ""));
    const resolved = await dramaCharacterImageService.resolveArchivedImagePath(
      characterId,
      "character-sheet",
      numericVersion,
    );
    if (!resolved) {
      res.status(404).json({ success: false, message: "角色设计稿历史版本尚未生成。" });
      return;
    }
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/drama/character-images/:characterId/portrait （兼容旧 URL，指向同一文件） */
router.get("/character-images/:characterId/portrait", async (req, res, next) => {
  try {
    const { characterId } = req.params as z.infer<typeof charImageParamsSchema>;
    const resolved = await dramaCharacterImageService.resolveExistingImagePath(
      characterId,
      "portrait",
    );
    if (!resolved) {
      res.status(404).json({ success: false, message: "角色设计稿尚未生成。" });
      return;
    }
    res.setHeader("Content-Type", resolved.mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/drama/character-images/:characterId/three-view/:view */
router.get(
  "/character-images/:characterId/three-view/:view",
  validate({ params: threeViewParamsSchema }),
  async (req, res, next) => {
    try {
      const { characterId, view } = req.params as z.infer<typeof threeViewParamsSchema>;
      const resolved = await dramaCharacterImageService.resolveExistingImagePath(
        characterId,
        `three-view-${view}`,
      );
      if (!resolved) {
        res.status(404).json({ success: false, message: `${view} 三视图尚未生成。` });
        return;
      }
      res.setHeader("Content-Type", resolved.mimeType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(resolved.filePath, (error) => {
      if (!error || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else next(error);
    });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
