import { raw, type RequestHandler } from "express";
import { AppError } from "../../../middleware/errorHandler";

/** Binary HTTP boundary; neither JSON limits nor service validation bound request reads. */
export const imageUploadBody: RequestHandler[] = [
  (req, _res, next) => {
    const mime = req.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
      next(new AppError("请上传 PNG、JPEG 或 WebP 图片。", 415));
      return;
    }
    next();
  },
  raw({ type: () => true, limit: "10mb", inflate: false }),
  (req, _res, next) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      next(new AppError("未收到图片数据。", 400));
      return;
    }
    next();
  },
];
