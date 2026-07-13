import { z } from "zod";

const looseObjectSchema = z.record(z.string(), z.unknown());

/** Prefer arrays; accept missing/null as empty (LLM often omits optional collections). */
const looseStringArraySchema = z.preprocess((value) => {
  if (value == null) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return value;
}, z.array(z.string().trim().min(1)).default([]));

/** Optional free text: empty string / null / whitespace → undefined. */
const optionalText = z.preprocess((value) => {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return value;
}, z.string().optional());

const worldProfileSchema = z.object({
  summary: optionalText,
  identity: optionalText,
  tone: optionalText,
  themes: looseStringArraySchema.optional(),
  coreConflict: optionalText,
}).passthrough();

const worldRuleSchema = z.object({
  id: optionalText,
  name: optionalText,
  summary: optionalText,
  cost: optionalText,
  boundary: optionalText,
  enforcement: optionalText,
}).passthrough();

const worldRulesSchema = z.object({
  summary: optionalText,
  axioms: z.preprocess((value) => (value == null ? [] : value), z.array(worldRuleSchema).default([])),
  taboo: looseStringArraySchema.optional(),
  sharedConsequences: looseStringArraySchema.optional(),
}).passthrough();

const worldFactionSchema = z.object({
  id: optionalText,
  name: optionalText,
  position: optionalText,
  doctrine: optionalText,
  goals: looseStringArraySchema.optional(),
  methods: looseStringArraySchema.optional(),
  representativeForceIds: looseStringArraySchema.optional(),
}).passthrough();

const worldForceSchema = z.object({
  id: optionalText,
  name: optionalText,
  type: optionalText,
  factionId: optionalText,
  summary: optionalText,
  baseOfPower: optionalText,
  currentObjective: optionalText,
  pressure: optionalText,
  leader: optionalText,
  narrativeRole: optionalText,
}).passthrough();

const worldLocationSchema = z.object({
  id: optionalText,
  name: optionalText,
  terrain: optionalText,
  summary: optionalText,
  narrativeFunction: optionalText,
  risk: optionalText,
  entryConstraint: optionalText,
  exitCost: optionalText,
  controllingForceIds: looseStringArraySchema.optional(),
}).passthrough();

const worldForceRelationSchema = z.object({
  id: optionalText,
  sourceForceId: optionalText,
  targetForceId: optionalText,
  relation: optionalText,
  tension: optionalText,
  detail: optionalText,
}).passthrough();

const worldLocationControlSchema = z.object({
  id: optionalText,
  forceId: optionalText,
  locationId: optionalText,
  relation: optionalText,
  detail: optionalText,
}).passthrough();

/**
 * Theme-world generation schema: keep structure, but tolerate partial LLM fills.
 * Empty arrays / omitted collections are accepted so flash models can pass validation
 * without multi-round repair (strict narrative quality is enforced downstream / by prompts).
 */
export const worldStructuredDataSchema = z.object({
  profile: worldProfileSchema.default({}),
  rules: worldRulesSchema.default({ axioms: [] }),
  factions: z.preprocess((value) => (value == null ? [] : value), z.array(worldFactionSchema).default([])),
  forces: z.preprocess((value) => (value == null ? [] : value), z.array(worldForceSchema).default([])),
  locations: z.preprocess((value) => (value == null ? [] : value), z.array(worldLocationSchema).default([])),
  relations: z.preprocess((value) => {
    if (value == null || typeof value !== "object") {
      return { forceRelations: [], locationControls: [] };
    }
    return value;
  }, z.object({
    forceRelations: z.preprocess((value) => (value == null ? [] : value), z.array(worldForceRelationSchema).default([])),
    locationControls: z.preprocess((value) => (value == null ? [] : value), z.array(worldLocationControlSchema).default([])),
  }).passthrough().default({ forceRelations: [], locationControls: [] })),
}).passthrough();

export const worldStructureSectionOutputSchema = z.union([
  looseObjectSchema,
  z.array(looseObjectSchema),
]);
