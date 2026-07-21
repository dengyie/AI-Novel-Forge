/**
 * 音色库矩阵覆盖报告：gender × cluster × texture 空洞，供补洞 import。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../../../runtime/appPaths";
import { voiceLibraryService } from "../voiceLibraryService";
import type { VoiceAsset } from "@ai-novel/shared/types/audiobook";
import { speakerKeyFromTags } from "../audiobookVoicePlanner";

const GENDERS = ["male", "female", "unknown"] as const;
const CLUSTERS = ["lead", "cast", "extra", "narrator"] as const;
const TEXTURES = [
  "texture-bright",
  "texture-neutral",
  "texture-dark_raspy",
  "texture-airy",
] as const;

export interface VoiceLibraryMatrixCell {
  gender: string;
  cluster: string;
  texture: string;
  assetCount: number;
  speakerCount: number;
}

export interface VoiceLibraryMatrixReport {
  totalAssets: number;
  speakerCount: number;
  clusterCounts: Record<string, number>;
  genderCounts: Record<string, number>;
  cells: VoiceLibraryMatrixCell[];
  /** 优先补洞：speakerCount=0 的 lead/cast 格 */
  gaps: VoiceLibraryMatrixCell[];
  generatedAt: string;
}

function tagOf(tags: string[], set: readonly string[]): string {
  for (const t of tags) {
    if ((set as readonly string[]).includes(t)) return t;
  }
  return (set as readonly string[]).includes("unknown") ? "unknown" : set[0] || "unknown";
}

export function resolveMatrixReportDir(outDir?: string): string {
  const env = process.env.VOICE_MATRIX_REPORT_DIR?.trim();
  if (outDir?.trim()) return path.resolve(outDir.trim());
  if (env) return path.resolve(env);
  // 优先 data 根下可写目录，避免 cwd 不是 monorepo 时写丢
  return path.join(resolveDataRoot(), "storage", "voice-matrix-reports");
}

export function buildVoiceLibraryMatrixReport(): VoiceLibraryMatrixReport {
  const items: VoiceAsset[] = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const page = voiceLibraryService.list({ status: ["approved"], kind: "clone_ref", limit, offset });
    items.push(...(page.items as VoiceAsset[]));
    if (page.items.length < limit) break;
    offset += limit;
    if (offset > 20_000) break;
  }

  const clusterCounts: Record<string, number> = { lead: 0, cast: 0, extra: 0, narrator: 0 };
  const genderCounts: Record<string, number> = { male: 0, female: 0, unknown: 0 };
  const cellMap = new Map<string, { assets: number; speakers: Set<string> }>();
  const allSpeakers = new Set<string>();

  for (const g of GENDERS) {
    for (const c of CLUSTERS) {
      for (const tx of TEXTURES) {
        cellMap.set(`${g}|${c}|${tx}`, { assets: 0, speakers: new Set() });
      }
    }
  }

  for (const asset of items) {
    const tags = (asset.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const gender = tagOf(tags, GENDERS as unknown as string[]);
    const cluster = tagOf(tags, CLUSTERS as unknown as string[]);
    const texture = tagOf(tags, TEXTURES as unknown as string[]);
    clusterCounts[cluster] = (clusterCounts[cluster] || 0) + 1;
    genderCounts[gender] = (genderCounts[gender] || 0) + 1;
    const sp = speakerKeyFromTags(tags, asset.id) || `asset:${asset.id}`;
    allSpeakers.add(sp);
    const key = `${gender}|${cluster}|${texture}`;
    const cell = cellMap.get(key);
    if (cell) {
      cell.assets += 1;
      cell.speakers.add(sp);
    }
  }

  const cells: VoiceLibraryMatrixCell[] = [];
  const gaps: VoiceLibraryMatrixCell[] = [];
  for (const [key, val] of cellMap) {
    const [gender, cluster, texture] = key.split("|");
    const row: VoiceLibraryMatrixCell = {
      gender: gender!,
      cluster: cluster!,
      texture: texture!,
      assetCount: val.assets,
      speakerCount: val.speakers.size,
    };
    cells.push(row);
    if (
      val.speakers.size === 0
      && (cluster === "lead" || cluster === "cast")
      && gender !== "unknown"
    ) {
      gaps.push(row);
    }
  }

  gaps.sort((a, b) => {
    const rank = (c: string) => (c === "lead" ? 0 : 1);
    return rank(a.cluster) - rank(b.cluster) || a.gender.localeCompare(b.gender);
  });

  return {
    totalAssets: items.length,
    speakerCount: allSpeakers.size,
    clusterCounts,
    genderCounts,
    cells,
    gaps,
    generatedAt: new Date().toISOString(),
  };
}

/** 写 gap 报告（不上传外网）；默认 data/storage/voice-matrix-reports。 */
export function writeVoiceLibraryMatrixGapReport(outDir?: string): {
  report: VoiceLibraryMatrixReport;
  path: string;
} {
  const report = buildVoiceLibraryMatrixReport();
  const dir = resolveMatrixReportDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `gap-report-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return { report, path: filePath };
}
