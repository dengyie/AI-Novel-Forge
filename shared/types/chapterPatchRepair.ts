import { z } from "zod";

export const CHAPTER_PATCH_REPAIR_STRATEGIES = [
  "patch_first",
  "full_rewrite",
] as const;

export type ChapterPatchRepairStrategy = typeof CHAPTER_PATCH_REPAIR_STRATEGIES[number];

export const chapterPatchOperationSchema = z.object({
  id: z.string().trim().min(1),
  targetExcerpt: z.string().trim().min(6),
  replacement: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  issueIds: z.array(z.string().trim().min(1)).max(8).default([]),
});

export const chapterPatchRepairPlanSchema = z.object({
  strategy: z.enum(CHAPTER_PATCH_REPAIR_STRATEGIES).default("patch_first"),
  summary: z.string().trim().min(1),
  patches: z.array(chapterPatchOperationSchema).max(8).default([]),
  requiresFullRewrite: z.boolean().default(false),
  escalationReason: z.string().trim().nullable().optional(),
});

export type ChapterPatchOperation = z.infer<typeof chapterPatchOperationSchema>;
export type ChapterPatchRepairPlan = z.infer<typeof chapterPatchRepairPlanSchema>;

export interface ChapterPatchApplyFailure {
  patchId: string;
  reason: string;
}

export interface ChapterPatchApplyResult {
  success: boolean;
  content: string;
  appliedPatchIds: string[];
  failures: ChapterPatchApplyFailure[];
}

function countOccurrences(content: string, target: string): number {
  if (target.length === 0) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const index = content.indexOf(target, cursor);
    if (index < 0) {
      break;
    }
    count += 1;
    cursor = index + target.length;
  }
  return count;
}

export function applyChapterPatchRepairPlan(
  content: string,
  plan: ChapterPatchRepairPlan,
): ChapterPatchApplyResult {
  const normalizedPlan = chapterPatchRepairPlanSchema.parse(plan);
  let nextContent = content;
  const appliedPatchIds: string[] = [];
  const failures: ChapterPatchApplyFailure[] = [];

  if (normalizedPlan.strategy !== "patch_first" || normalizedPlan.requiresFullRewrite) {
    return {
      success: false,
      content,
      appliedPatchIds,
      failures: [{
        patchId: "plan",
        reason: normalizedPlan.escalationReason?.trim() || "补丁计划要求整章重写。",
      }],
    };
  }

  for (const patch of normalizedPlan.patches) {
    const target = patch.targetExcerpt.trim();
    const occurrenceCount = countOccurrences(nextContent, target);
    if (occurrenceCount !== 1) {
      failures.push({
        patchId: patch.id,
        reason: occurrenceCount === 0
          ? "目标片段不存在，不能安全应用局部补丁。"
          : "目标片段出现多次，不能确定局部补丁位置。",
      });
      continue;
    }
    nextContent = nextContent.replace(target, patch.replacement.trim());
    appliedPatchIds.push(patch.id);
  }

  const changed = nextContent.trim() !== content.trim();
  return {
    success: failures.length === 0 && appliedPatchIds.length > 0 && changed,
    content: nextContent,
    appliedPatchIds,
    failures,
  };
}
