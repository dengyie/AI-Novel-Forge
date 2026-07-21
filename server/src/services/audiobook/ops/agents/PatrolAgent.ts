/**
 * PatrolAgent（成书巡检，§3.3）。
 *
 * 检查项（最小可演示集 - P2/P3/P1）：
 *  - P1 任务卡死：status=running 且 heartbeatAt 超过 staleMs → 报告（autoFix=false 默认只报告）
 *  - P2 speakerUnresolved 比例过高：逐章 annotation 报告
 *  - P3 chapter.wav 缺失但 chapterProgress 标 ready → 报告
 *  - P7 VoiceAsset approved 但 primaryFile 路径不可达 → 报告
 *
 * 默认 autoFix=false（只报告）；显式 autoFix:true 才执行安全子集（未来扩展点）。
 * 数据来源 prisma.audiobookTask / AudiobookTaskService.getTask辅警件 + voiceLibraryService.list。
 */
import fs from "node:fs";
import { prisma } from "../../../../db/prisma";
import { voiceLibraryService } from "../../voiceLibraryService";
import { resolveVoiceAssetStoredPath } from "../../voiceLibraryService";
import { resolveAudiobookTaskDir, resolveChapterAudioPath } from "../../audiobookPaths";
import type {
  PatrolCheckId,
  PatrolFinding,
  PatrolReport,
} from "@ai-novel/shared/types/audiobookOps";

const STALE_HEARTBEAT_MS = 30 * 60_000;
const SPEAKER_UNRESOLVED_RATIO_WARN = 0.2;

/** P3 权威章 wav 路径（含 chapters/ 中间层）。导出供路径契约回归测。 */
export function resolvePatrolChapterWav(taskDir: string, chapterId: string): string {
  return resolveChapterAudioPath(taskDir, chapterId);
}

export interface PatrolAgentRunInput {
  novelId?: string | null;
  taskId?: string | null;
  autoFix?: boolean;
  /** dry-run 跳过任何 autoFix 路径（即便 autoFix=true） */
  dryRun?: boolean;
}

export class PatrolAgent {
  async run(input: PatrolAgentRunInput): Promise<PatrolReport> {
    const findings: PatrolFinding[] = [];
    const autoFix = input.autoFix === true && input.dryRun !== true;

    let tasks: { id: string; novelId: string | null; status: string; heartbeatAt: Date | null; chapterIdsJson: string | null; progressJson: string | null }[] = [];
    try {
      const where: { id?: string; novelId?: string } = {};
      if (input.taskId) where.id = input.taskId;
      if (input.novelId) where.novelId = input.novelId;
      const rows = await prisma.audiobookTask.findMany({
        where,
        select: {
          id: true,
          novelId: true,
          status: true,
          heartbeatAt: true,
          chapterIdsJson: true,
          progressJson: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      tasks = rows as unknown as typeof tasks;
    } catch {
      // 表缺失或 DB 错：记 P1 但不阻断后续 P7 库扫描 + autoFix 占位
      findings.push({
        id: "P1",
        target: { novelId: input.novelId ?? null, taskId: input.taskId ?? null, chapterId: null },
        severity: "warn",
        message: "无法读取 audiobookTask（表缺失或 DB 错）",
        autoFixed: false,
      });
    }

    const now = Date.now();
    const checkedTasks = tasks.length;
    let checkedChapters = 0;

    for (const task of tasks) {
      // P1: running 超时无心跳
      if (task.status === "running") {
        const heartbeat = task.heartbeatAt ? task.heartbeatAt.getTime() : 0;
        if (now - heartbeat > STALE_HEARTBEAT_MS) {
          findings.push({
            id: "P1",
            target: { novelId: task.novelId ?? null, taskId: task.id, chapterId: null },
            severity: "warn",
            message: `任务 running 但 heartbeat 超过 ${Math.round(STALE_HEARTBEAT_MS / 60000)}min 无更新（疑似卡死）`,
            autoFixed: false,
          });
        }
      }

      const chapterIds = parseChapterIdsJson(task.chapterIdsJson);
      if (!chapterIds.length) continue;

      // P3: chapterProgress=ready 但磁盘缺 chapter.wav
      const progress = parseProgressJson(task.progressJson);
      const chapterProgressArr = Array.isArray(progress.chapterProgress) ? progress.chapterProgress : [];
      const dir = resolveAudiobookTaskDir(task.novelId ?? "_unknown", task.id);
      let unresolvedCount = 0;

      for (const cid of chapterIds) {
        checkedChapters += 1;
        // P2: speakerUnresolved 通过 annotations 文件判断成本较高，此处先简化为：
        //     progressJson.chapterAnnotations[].speakerUnresolved 设为 true
        const ann = findAnnotation(progress, cid);
        if (ann?.speakerUnresolved === true) unresolvedCount += 1;
      }

      const unresolvedRatio = checkedChapters > 0 ? unresolvedCount / checkedChapters : 0;
      if (unresolvedRatio >= SPEAKER_UNRESOLVED_RATIO_WARN) {
        findings.push({
          id: "P2",
          target: { novelId: task.novelId ?? null, taskId: task.id, chapterId: null },
          severity: "warn",
          message: `speakerUnresolved 比例 ${(unresolvedRatio * 100).toFixed(0)}% 偏高（${unresolvedCount}/${chapterIds.length}）`,
          autoFixed: false,
        });
      }

      for (const entry of chapterProgressArr as Array<{ chapterId?: string; status?: string }>) {
        if (!entry || entry.status !== "ready") continue;
        const cid = entry.chapterId;
        if (!cid) continue;
        // 必须走 resolveChapterAudioPath：权威布局是 {taskDir}/chapters/{cid}/chapter.wav
        // （旧 path.join(dir, cid, "chapter.wav") 漏 chapters/ 会 13 假阳性）
        const chapterWav = resolvePatrolChapterWav(dir, cid);
        if (!fs.existsSync(chapterWav)) {
          findings.push({
            id: "P3",
            target: { novelId: task.novelId ?? null, taskId: task.id, chapterId: cid },
            severity: "error",
            message: `章节 chapterProgress=ready 但 chapter.wav 缺失：${chapterWav}`,
            autoFixed: false,
          });
        }
      }
    }

    // P7: approved VoiceAsset 但 primaryFile 路径不可达
    let approvedList: { id: string; primaryFile?: { path?: string } | null }[] = [];
    try {
      approvedList = voiceLibraryService.list({ status: ["approved"] }).items as typeof approvedList;
    } catch {
      findings.push({
        id: "P7",
        target: {},
        severity: "warn",
        message: "无法读取 VoiceAsset 库（registry 损坏或路径问题）",
        autoFixed: false,
      });
    }
    for (const asset of approvedList) {
      const stored = asset.primaryFile?.path?.trim() || "";
      const abs = resolveVoiceAssetStoredPath(stored);
      if (!abs || !fs.existsSync(abs)) {
        findings.push({
          id: "P7",
          target: { chapterId: null, novelId: null, taskId: null },
          severity: "warn",
          message: `approved VoiceAsset「${asset.id}」primaryFile 不可达：${stored}`,
          autoFixed: false,
        });
      }
    }

    // autoFix 安全子集：阶段 1 不执行写操作；记录 P3/P4 自动 fixed=false 占位
    const autoFixRequested = input.autoFix === true;
    if (autoFixRequested) {
      // 阶段 1：autoFix=true 也不修写；记录 info finding（无论 dryRun 是否一致）
      findings.push({
        id: "P3",
        target: {},
        severity: "info",
        message: autoFix
          ? "autoFix 请求：阶段 1 PatrolAgent 不实施写操作（见 §K backlog）"
          : "autoFix 请求（dry-run）：阶段 1 PatrolAgent 不实施写操作（见 §K backlog）",
        autoFixed: false,
      });
    }

    return {
      findings,
      checkedTasks,
      checkedChapters,
      clean: findings.length === 0,
    };
  }
}

function parseChapterIdsJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

function parseProgressJson(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function findAnnotation(progress: Record<string, unknown>, chapterId: string): { speakerUnresolved?: boolean } | null {
  const annotations = progress.chapterAnnotations ?? progress.annotations;
  if (!Array.isArray(annotations)) return null;
  for (const ann of annotations as Array<Record<string, unknown>>) {
    if (typeof ann !== "object" || ann === null) continue;
    if ((ann.chapterId as string) === chapterId || (ann.id as string) === chapterId) {
      return { speakerUnresolved: ann.speakerUnresolved === true };
    }
  }
  return null;
}

export const patrolAgent = new PatrolAgent();
// re-export types for tests
export type { PatrolCheckId, PatrolFinding, PatrolReport };
