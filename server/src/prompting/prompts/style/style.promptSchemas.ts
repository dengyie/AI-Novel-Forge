import { z } from "zod";

const STYLE_DETECTION_RULE_TYPES = [
  "style",
  "character",
  "forbidden",
  "risk",
  "encourage",
] as const;

// LLM 偶尔按"类别名"而非枚举字面量输出 ruleType（如 antiAi/writing/character_expression），
// 会导致每次检测都触发一次 schema repair（多一次 LLM 调用/延迟）。此处在解析层把常见别名
// 归一到合法枚举，避免无谓 repair。真正的 ruleType 在 StyleDetectionService 里会被 matchedRule.type
// 覆盖，此归一仅作无匹配规则时的兜底，映射到语义最接近的 risk（反 AI 风险类）。
const STYLE_DETECTION_RULE_TYPE_ALIASES: Record<string, (typeof STYLE_DETECTION_RULE_TYPES)[number]> = {
  antiai: "risk",
  "anti-ai": "risk",
  anti_ai: "risk",
  writing: "style",
  writingrule: "style",
  writing_rule: "style",
  character_expression: "character",
  characterexpression: "character",
  role: "character",
  forbid: "forbidden",
  forbidden_rule: "forbidden",
  warn: "risk",
  warning: "risk",
  encouraged: "encourage",
};

export const styleDetectionRuleTypeSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if ((STYLE_DETECTION_RULE_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return STYLE_DETECTION_RULE_TYPE_ALIASES[normalized] ?? "risk";
}, z.enum(STYLE_DETECTION_RULE_TYPES));

export const styleDetectionViolationSchema = z.object({
  ruleId: z.string().trim().optional(),
  ruleName: z.string().trim().min(1),
  ruleType: styleDetectionRuleTypeSchema,
  severity: z.enum(["low", "medium", "high"]),
  issueCategory: z.enum(["style_expression", "story_structure"]).optional(),
  excerpt: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
  canAutoRewrite: z.boolean(),
});

export const styleDetectionPayloadSchema = z.object({
  riskScore: z.coerce.number().min(0).max(100).optional(),
  summary: z.string().trim().optional(),
  violations: z.array(styleDetectionViolationSchema).optional().default([]),
  canAutoRewrite: z.boolean().optional().default(false),
});

export const styleRecommendationSchema = z.object({
  summary: z.string().trim().min(1),
  candidates: z.array(z.object({
    styleProfileId: z.string().trim().min(1),
    fitScore: z.number().int().min(0).max(100),
    recommendationReason: z.string().trim().min(1),
    caution: z.string().trim().optional().nullable(),
  })).min(1).max(3),
});

export const styleRuleObjectSchema = z.object({}).passthrough();

export const styleFeatureSchema = z.object({
  id: z.string().trim().min(1),
  group: z.enum(["narrative", "language", "dialogue", "rhythm", "fingerprint"]),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  importance: z.number(),
  imitationValue: z.number(),
  transferability: z.number(),
  fingerprintRisk: z.number(),
  keepRulePatch: styleRuleObjectSchema,
  weakenRulePatch: styleRuleObjectSchema.optional(),
}).passthrough();

export const stylePresetSchema = z.object({
  key: z.enum(["imitate", "balanced", "transfer"]),
  label: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  decisions: z.array(z.object({
    featureId: z.string().trim().min(1),
    decision: z.enum(["keep", "weaken", "remove"]),
  })),
}).passthrough();

export const styleProfileExtractionSchema = z.object({
  name: z.string().trim().optional(),
  description: z.string().trim().optional().nullable(),
  analysisMarkdown: z.string().trim().optional().nullable(),
  summary: z.string().trim().optional(),
  features: z.array(styleFeatureSchema).optional(),
}).passthrough();

export const styleGeneratedProfileSchema = z.object({
  name: z.string().trim().optional(),
  description: z.string().trim().optional().nullable(),
  analysisMarkdown: z.string().trim().optional().nullable(),
  narrativeRules: styleRuleObjectSchema.optional(),
  characterRules: styleRuleObjectSchema.optional(),
  languageRules: styleRuleObjectSchema.optional(),
  rhythmRules: styleRuleObjectSchema.optional(),
}).passthrough();

export const styleProfileMetadataSchema = z.object({
  category: z.string().trim().optional().nullable(),
  tags: z.array(z.string().trim()).optional().default([]),
  applicableGenres: z.array(z.string().trim()).optional().default([]),
}).passthrough();

export const styleProfileAntiAiSelectionSchema = z.object({
  antiAiRuleKeys: z.array(z.string().trim()).optional().default([]),
}).passthrough();

export const styleProfileSanitizeForGenerationSchema = z.object({
  writingGuidance: z.array(z.string().trim().min(1)).default([]),
  forbiddenEntities: z.array(z.string().trim().min(1)).default([]),
  sourceRiskSummary: z.string().trim().optional().nullable(),
}).passthrough();

export const antiAiRuleDraftFieldsSchema = z.object({
  key: z.string().trim().optional().default(""),
  name: z.string().trim().min(1),
  type: z.enum(["forbidden", "risk", "encourage"]),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string().trim().min(1),
  detectPatterns: z.array(z.string().trim().min(1)).max(12).optional().default([]),
  promptInstruction: z.string().trim().optional().nullable(),
  rewriteSuggestion: z.string().trim().optional().nullable(),
}).passthrough();

export const antiAiRuleAiDraftSchema = z.object({
  draft: antiAiRuleDraftFieldsSchema,
  rationale: z.string().trim().optional().default(""),
  safetyNotes: z.array(z.string().trim().min(1)).max(6).optional().default([]),
}).passthrough();
