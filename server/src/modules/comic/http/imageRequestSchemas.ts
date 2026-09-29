import { z } from "zod";

export const excludedReferenceImageUrlsSchema = z.array(z.string().trim().min(1).max(1000)).max(24).optional();

export const imageGenerateSchema = z
  .object({
    provider: z.string().trim().optional(),
    promptOverride: z.string().trim().max(4000).optional(),
    providerOverride: z.string().trim().optional(),
    sizeOverride: z.string().trim().max(20).optional(),
    negativePromptOverride: z.string().trim().max(2000).optional(),
    excludedReferenceImageUrls: excludedReferenceImageUrlsSchema,
  })
  .optional();
