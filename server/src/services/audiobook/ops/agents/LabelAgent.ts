/**
 * LabelAgent（规则 tags 重标，v3.1 生产安全）。
 *
 * - 只改 tags（+ updatedAt）；不碰 status/review/文件
 * - **允许**赋 lead，但 **禁止**用 Edge/预设说话人名启发式抬 lead
 * - lead 仅：显式 lead / role-lead_* / 强角色词（主角|男主|女主|protagonist…）
 * - 同 speaker: 广播 cluster：仅 lead-confidence:high 才允许整组升 lead，否则 cast 封顶
 * - 标记 label:ai-v3
 * - 写回走 updateAssetTagsBatch（单锁）
 */
import { voiceLibraryService } from "../../voiceLibraryService";
import type { VoiceAsset } from "@ai-novel/shared/types/audiobook";
import { speakerKeyFromTags } from "../../audiobookVoicePlanner";

export const LABEL_AGENT_VERSION = "3";
export const LABEL_TAG = "label:ai-v3";

const GENDER = new Set(["male", "female", "unknown"]);
const CLUSTERS = new Set(["lead", "cast", "extra", "narrator"]);
const PITCH = new Set(["pitch-high", "pitch-mid", "pitch-low"]);
const TEXTURE = new Set([
  "texture-bright",
  "texture-neutral",
  "texture-dark_raspy",
  "texture-airy",
]);
const ENERGY = new Set(["energy-lively", "energy-even", "energy-heavy"]);

/** 强角色语义；不含 Edge 预设名 / 品牌音色名 */
const LEAD_HINT =
  /(?:^|[^a-z0-9])(?:lead|主角|女主|男主|heroine|protagonist|主视角)(?:[^a-z0-9]|$)|role-lead/i;
const CAST_HINT = /(?:^|[^a-z0-9])(?:cast|配角|团宠|执事|军师)(?:[^a-z0-9]|$)/i;
const NARRATOR_HINT = /(?:^|[^a-z0-9])(?:narrat|旁白|解说|播报)(?:[^a-z0-9]|$)/i;
const MALE_HINT = /(?:^|[^a-z0-9])(?:male|男)(?:[^a-z0-9]|$)|speaker:[^\s,]*yun|speaker:[^\s,]*(?:wanlung|yunjhe)/i;
const FEMALE_HINT = /(?:^|[^a-z0-9])(?:female|女)(?:[^a-z0-9]|$)|speaker:[^\s,]*(?:xiao|hsiao|hiu)/i;
const BRIGHT_HINT = /bright|清亮|甜|脆|少女|youth|lively/i;
const DARK_HINT = /dark|raspy|沙哑|低沉|沉稳|沧桑|thick/i;
const AIRY_HINT = /airy|气声|轻柔|soft|whisper/i;
const HIGH_HINT = /high|尖|高|童|清亮/i;
const LOW_HINT = /low|低|沉|厚|浑/i;
const LIVELY_HINT = /lively|活泼|灵动|快/i;
const HEAVY_HINT = /heavy|沉|稳|肃|重/i;

export interface LabelAgentRunInput {
  assetIds?: string[] | null;
  /** true=只报告 diff 不写 */
  dryRun?: boolean;
  /** 包含 approved+draft；默认 true */
  includeApproved?: boolean;
  includeDraft?: boolean;
}

export interface LabelAgentRunResult {
  changed: number;
  skipped: number;
  leadCount: number;
  diffs: Array<{
    assetId: string;
    beforeCluster: string | null;
    afterCluster: string | null;
    tagsAdded: string[];
  }>;
}

function normalizeTags(tags: string[] | undefined | null): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function pickOne(tags: string[], set: Set<string>): string | null {
  for (const t of tags) {
    if (set.has(t)) return t;
  }
  return null;
}

function blobOf(asset: VoiceAsset): string {
  return [
    asset.slug || "",
    asset.displayName || "",
    ...(asset.tags || []),
    asset.license?.source || "",
  ].join(" ");
}

function inferGender(tags: string[], blob: string): string {
  const existing = pickOne(tags, GENDER);
  if (existing && existing !== "unknown") return existing;
  if (FEMALE_HINT.test(blob) && !MALE_HINT.test(blob)) return "female";
  if (MALE_HINT.test(blob) && !FEMALE_HINT.test(blob)) return "male";
  if (FEMALE_HINT.test(blob)) return "female";
  if (MALE_HINT.test(blob)) return "male";
  return existing || "unknown";
}

/**
 * cluster 推断：允许 lead，但不用预设说话人名抬升。
 * - high：显式 lead 标签或强角色词
 * - mid：已有 lead 标签但无强词（保守保留）
 * - 否则 cast/extra/narrator
 */
function inferCluster(
  tags: string[],
  blob: string,
): { cluster: string; leadConfidence: "high" | "mid" | "low" } {
  if (NARRATOR_HINT.test(blob) || tags.includes("narrator")) {
    return { cluster: "narrator", leadConfidence: "low" };
  }

  const hasExplicitLead =
    tags.includes("lead")
    || tags.includes("role-lead_f")
    || tags.includes("role-lead_m")
    || tags.some((t) => t.startsWith("role-lead"));
  const hasStrongLeadWord = LEAD_HINT.test(blob);

  if (hasStrongLeadWord) {
    return { cluster: "lead", leadConfidence: "high" };
  }
  if (hasExplicitLead) {
    // 保留既有 lead，但不因预设名新增
    return { cluster: "lead", leadConfidence: "mid" };
  }

  if (CAST_HINT.test(blob) || tags.includes("cast")) {
    return { cluster: "cast", leadConfidence: "low" };
  }
  // 有明确 scope-zh + 非 demo 源 → cast；其余 extra
  if (tags.includes("scope-zh") && !/demo|e2e|test/i.test(blob)) {
    return { cluster: "cast", leadConfidence: "low" };
  }
  if (tags.includes("extra")) {
    return { cluster: "extra", leadConfidence: "low" };
  }
  return { cluster: "extra", leadConfidence: "low" };
}

function inferPitch(tags: string[], blob: string): string {
  const ex = pickOne(tags, PITCH);
  if (ex) return ex;
  if (HIGH_HINT.test(blob)) return "pitch-high";
  if (LOW_HINT.test(blob)) return "pitch-low";
  return "pitch-mid";
}

function inferTexture(tags: string[], blob: string): string {
  const ex = pickOne(tags, TEXTURE);
  if (ex) return ex;
  if (DARK_HINT.test(blob)) return "texture-dark_raspy";
  if (AIRY_HINT.test(blob)) return "texture-airy";
  if (BRIGHT_HINT.test(blob)) return "texture-bright";
  return "texture-neutral";
}

function inferEnergy(tags: string[], blob: string): string {
  const ex = pickOne(tags, ENERGY);
  if (ex) return ex;
  if (LIVELY_HINT.test(blob)) return "energy-lively";
  if (HEAVY_HINT.test(blob)) return "energy-heavy";
  return "energy-even";
}

function stripManaged(tags: string[]): string[] {
  return tags.filter((t) => {
    if (GENDER.has(t) || CLUSTERS.has(t) || PITCH.has(t) || TEXTURE.has(t) || ENERGY.has(t)) {
      return false;
    }
    if (t === "labeled-v1" || t === "labeled-v2" || t === LABEL_TAG) return false;
    if (t.startsWith("lead-confidence:")) return false;
    if (t.startsWith("cluster-")) return false;
    return true;
  });
}

function proposeTags(asset: VoiceAsset): string[] {
  const tags = normalizeTags(asset.tags);
  if (asset.status === "archived" || asset.status === "deprecated") {
    return tags;
  }
  if (/e2e|fixture/i.test(asset.slug || "") || tags.includes("e2e")) {
    return tags;
  }
  const blob = blobOf(asset);
  const gender = inferGender(tags, blob);
  const { cluster, leadConfidence } = inferCluster(tags, blob);
  const pitch = inferPitch(tags, blob);
  const texture = inferTexture(tags, blob);
  const energy = inferEnergy(tags, blob);
  const base = stripManaged(tags);
  const next = [
    ...base,
    gender,
    cluster,
    pitch,
    texture,
    energy,
    LABEL_TAG,
    `lead-confidence:${leadConfidence}`,
  ];
  if (!next.some((t) => t.startsWith("scope-")) && !/scope-en|english|en-/i.test(blob)) {
    next.push("scope-zh");
  }
  return [...new Set(next)];
}

function clusterOf(tags: string[]): string | null {
  return pickOne(normalizeTags(tags), CLUSTERS);
}

function leadConfidenceOf(tags: string[]): "high" | "mid" | "low" {
  const t = normalizeTags(tags).find((x) => x.startsWith("lead-confidence:"));
  if (t === "lead-confidence:high") return "high";
  if (t === "lead-confidence:mid") return "mid";
  return "low";
}

/**
 * speaker 广播：
 * - 若任一条 lead-confidence:high → 整组 lead
 * - 否则 cluster 封顶 cast（narrator 保留若全员 narrator）
 */
function broadcastClusters(proposed: Map<string, string[]>, pool: VoiceAsset[]): void {
  const bySpeaker = new Map<string, string[]>();
  for (const asset of pool) {
    const tags = proposed.get(asset.id) || normalizeTags(asset.tags);
    const sp = speakerKeyFromTags(tags, asset.id);
    if (!sp) continue;
    const list = bySpeaker.get(sp) || [];
    list.push(asset.id);
    bySpeaker.set(sp, list);
  }

  for (const ids of bySpeaker.values()) {
    if (ids.length < 2) continue;

    let anyHighLead = false;
    let allNarrator = true;
    for (const id of ids) {
      const tags = proposed.get(id) || [];
      const c = clusterOf(tags) || "extra";
      if (c !== "narrator") allNarrator = false;
      if (c === "lead" && leadConfidenceOf(tags) === "high") anyHighLead = true;
    }

    let best: string;
    if (anyHighLead) {
      best = "lead";
    } else if (allNarrator) {
      best = "narrator";
    } else {
      // 封顶 cast：防止 mid/假 lead 整 speaker 污染
      const rank: Record<string, number> = { cast: 3, narrator: 2, extra: 1, lead: 0 };
      best = "extra";
      let bestRank = 0;
      for (const id of ids) {
        let c = clusterOf(proposed.get(id) || []) || "extra";
        if (c === "lead") c = "cast"; // 降级
        if ((rank[c] || 0) > bestRank) {
          bestRank = rank[c] || 0;
          best = c;
        }
      }
    }

    for (const id of ids) {
      const tags = proposed.get(id) || [];
      const without = tags.filter((t) => !CLUSTERS.has(t) && !t.startsWith("lead-confidence:"));
      const conf =
        best === "lead"
          ? "high"
          : leadConfidenceOf(tags) === "high"
            ? "mid"
            : leadConfidenceOf(tags);
      proposed.set(id, [...without, best, `lead-confidence:${best === "lead" ? "high" : conf === "high" ? "mid" : conf}`]);
    }
  }
}

export class LabelAgent {
  run(input: LabelAgentRunInput = {}): LabelAgentRunResult {
    const includeApproved = input.includeApproved !== false;
    const includeDraft = input.includeDraft !== false;
    const dryRun = input.dryRun === true;

    let pool: VoiceAsset[] = [];
    if (input.assetIds?.length) {
      for (const id of input.assetIds) {
        const a = voiceLibraryService.getById(id);
        if (a) pool.push(a);
      }
    } else {
      const statuses: Array<"draft" | "approved"> = [];
      if (includeDraft) statuses.push("draft");
      if (includeApproved) statuses.push("approved");
      if (!statuses.length) {
        return { changed: 0, skipped: 0, leadCount: 0, diffs: [] };
      }
      let offset = 0;
      const limit = 200;
      for (;;) {
        const page = voiceLibraryService.list({ status: statuses, limit, offset });
        pool.push(...(page.items as VoiceAsset[]));
        if (page.items.length < limit) break;
        offset += limit;
        if (offset > 20_000) break;
      }
    }

    const proposed = new Map<string, string[]>();
    for (const asset of pool) {
      proposed.set(asset.id, proposeTags(asset));
    }
    broadcastClusters(proposed, pool);

    let changed = 0;
    let skipped = 0;
    let leadCount = 0;
    const diffs: LabelAgentRunResult["diffs"] = [];
    const batchUpdates: Array<{ assetId: string; tags: string[] }> = [];

    for (const asset of pool) {
      const next = proposed.get(asset.id);
      if (!next) {
        skipped += 1;
        continue;
      }
      if (clusterOf(next) === "lead") leadCount += 1;
      const before = normalizeTags(asset.tags).slice().sort().join("|");
      const after = next.slice().sort().join("|");
      if (before === after) {
        skipped += 1;
        continue;
      }
      const beforeSet = new Set(normalizeTags(asset.tags));
      const tagsAdded = next.filter((t) => !beforeSet.has(t));
      diffs.push({
        assetId: asset.id,
        beforeCluster: clusterOf(asset.tags || []),
        afterCluster: clusterOf(next),
        tagsAdded,
      });
      batchUpdates.push({ assetId: asset.id, tags: next });
      changed += 1;
    }

    if (!dryRun && batchUpdates.length) {
      voiceLibraryService.updateAssetTagsBatch(batchUpdates);
    }

    return { changed, skipped, leadCount, diffs };
  }
}

export const labelAgent = new LabelAgent();
