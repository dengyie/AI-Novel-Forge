import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { NOVEL_EXPORT_FORMAT_VALUES, NOVEL_EXPORT_SCOPE_VALUES } from "@ai-novel/shared/types/novelExport";
import { authMiddleware } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { novelExportService } from "../novelExport.service";

const router = Router();

const idParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const exportQuerySchema = z.object({
  format: z.enum(NOVEL_EXPORT_FORMAT_VALUES).default("txt"),
  scope: z.enum(NOVEL_EXPORT_SCOPE_VALUES).default("full"),
  requirePublishReady: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((value) => value === true || value === "true" || value === "1"),
  fromOrder: z.coerce.number().int().min(1).optional(),
  toOrder: z.coerce.number().int().min(1).optional(),
  volumeOrder: z.coerce.number().int().min(1).max(200).optional(),
});

router.use(authMiddleware);

router.get(
  "/:id/export",
  validate({ params: idParamsSchema, query: exportQuerySchema }),
  async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const { format, scope, requirePublishReady, fromOrder, toOrder, volumeOrder } = exportQuerySchema.parse(req.query);
      const data = await novelExportService.buildExportContent(id, format, scope, {
        requirePublishReady: requirePublishReady === true,
        fromOrder,
        toOrder,
        volumeOrder,
      });
      res.setHeader("Content-Type", data.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(data.fileName)}"`);
      res.status(200).send(data.content);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/:id/export-as-document",
  validate({ params: idParamsSchema }),
  async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const data = await novelExportService.exportAsKnowledgeDocument(id);
      res.status(201).json({
        success: true,
        data,
        message: "Novel exported as knowledge document.",
      } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
