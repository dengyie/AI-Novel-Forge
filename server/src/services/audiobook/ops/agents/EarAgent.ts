/**
 * EarAgent（审听 / 拟人耳）（§3.1, §12-C.3,D）。
 *
 * 流程：
 *  1. 从 voiceLibraryService.list 取 draft 资产（或指定 assetIds）
 *  2. 对每个资产：
 *     a. resolveVoiceAssetStoredPath 解析绝对路径
 *     b. sha256File 比对 primaryFile.sha256；不一致 → 写 reject verdict，跳过 heard/升权
 *     c. 路径 + 启发式 → EarVerdict
 *     d. voiceLibraryService.markLibraryPreviewHeard(assetId, { heardBy: "agent:ear@1" })
 *        （已写 heardAt + heardSha256；与文件 sha 对齐）
 *     e. 若 forceKeepDraft / forceReject 人工 override 生效 → 不升权，仅在 verdict 记 reason
 *     f. 若 decision==="approve" 且 allow approve（§D assertOpsApproveAllowed 通过）→ setStatus("approved")
 *        （setStatus 内复用既有 sha/license/heardAt/heardSha 门禁；不在 Agent 自验）
 *
 * 不变量（§4）：
 *  - import 永 draft（不在本 Agent 关切）
 *  - sha 不对齐拒绝
 *  - 仅 decision==="approve" 经进程内门禁后升权
 *  - 人工 force 标记不可被覆盖
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { voiceLibraryService } from "../../voiceLibraryService";
import { resolveVoiceAssetStoredPath } from "../../voiceLibraryService";
import type { VoiceAsset } from "@ai-novel/shared/types/audiobook";
import {
  runEarHeuristics,
  type EarHeuristicThresholds,
} from "../heuristics/earSignalHeuristics";
import { assertOpsApproveAllowed, auditOpsApproveAllowedPath, EAR_AGENT_VERSION } from "../OpsReport";
import type { OpsEarVerdict } from "@ai-novel/shared/types/audiobookOps";

export interface EarAgentRunInput {
  assetIds?: string[] | null;
  thresholds?: Partial<EarHeuristicThresholds>;
  /** 显式禁升权（dry-run / 未配置 token 但想看 verdict） */
  skipApprove?: boolean;
  /** Agent 读 override 表：forceKeepDraft/forceReject 命中即记 reason 不升权 */
  isForceKeepDraft?: (assetId: string) => boolean;
  isForceReject?: (assetId: string) => boolean;
  /** 模型版本/名称（heuristic 模式无 LLM；model 字段留作 LLM 模式 backlog） */
  model?: string | null;
}

export interface EarAgentRunResult {
  verdicts: OpsEarVerdict[];
  approve: {
    attempted: number;
    approved: number;
    rejected: number;
    skipped: number;
    gateBlocked: number;
  };
}

export class EarAgent {
  run(input: EarAgentRunInput): EarAgentRunResult {
    const verdicts: OpsEarVerdict[] = [];
    const approve = { attempted: 0, approved: 0, rejected: 0, skipped: 0, gateBlocked: 0 };

    let assets: { id: string; status: string; kind: string }[];
    if (input.assetIds && input.assetIds.length > 0) {
      const filtered: VoiceAsset[] = [];
      for (const id of input.assetIds) {
        const a = voiceLibraryService.list({}).items.find((x: VoiceAsset) => x.id === id);
        if (a) filtered.push(a);
      }
      assets = filtered.map((a) => ({ id: a.id, status: a.status, kind: a.kind }));
    } else {
      // 只审 draft；非 draft（archived/deprecated/approved）不重审
      const list = voiceLibraryService.list({ status: ["draft"] });
      assets = list.items.map((a: VoiceAsset) => ({ id: a.id, status: a.status, kind: a.kind }));
    }

    for (const meta of assets) {
      const asset = voiceLibraryService.list({}).items.find((x: VoiceAsset) => x.id === meta.id);
      if (!asset) {
        approve.skipped += 1;
        continue;
      }
      if (asset.status !== "draft") {
        // 非 draft（如人工已升 approved、或 archived）跳过
        approve.skipped += 1;
        continue;
      }
      const stored = asset.primaryFile?.path?.trim() || "";
      const filePath = resolveVoiceAssetStoredPath(stored);
      if (!filePath || !fs.existsSync(filePath)) {
        verdicts.push(makeReject(asset.id, asset.primaryFile?.sha256 ?? "", `primaryFile 路径不可达：${stored}`));
        approve.rejected += 1;
        continue;
      }
      const fileSha = sha256File(filePath);
      const expectedSha = asset.primaryFile?.sha256?.trim() || "";
      if (expectedSha && fileSha !== expectedSha) {
        verdicts.push(
          makeReject(asset.id, expectedSha, `sha 不一致（文件已覆盖或损坏）：期望=${expectedSha.slice(0, 8)} 实测=${fileSha.slice(0, 8)}`),
        );
        approve.rejected += 1;
        continue;
      }

      const verdict = runEarHeuristics({
        filePath,
        expectedSha256: expectedSha || fileSha,
        assetId: asset.id,
        thresholds: input.thresholds,
        agentVersion: EAR_AGENT_VERSION,
        model: input.model ?? null,
      });

      // 人工 override 优先于启发式结论
      const forceKeep = input.isForceKeepDraft?.(asset.id) ?? false;
      const forceReject = input.isForceReject?.(asset.id) ?? false;
      if (forceKeep) {
        verdict.reasons = [...verdict.reasons, "人工 forceKeepDraft：不升权，保留 draft"];
        if (verdict.decision === "approve") verdict.decision = "needs_human";
      }
      if (forceReject) {
        verdict.decision = "reject";
        verdict.reasons = [...verdict.reasons, "人工 forceReject：强制 reject"];
      }

      // 写 heard（markLibraryPreviewHeard 已内建 sha 对齐跳过）
      try {
        voiceLibraryService.markLibraryPreviewHeard(asset.id, { heardBy: `agent:ear@${EAR_AGENT_VERSION}` });
      } catch (err) {
        verdict.reasons = [
          ...verdict.reasons,
          `markLibraryPreviewHeard 失败：${err instanceof Error ? err.message : String(err)}`,
        ];
      }

      approve.attempted += 1;

      // 升权：仅 decision==='approve' 且未 skipApprove 且 force 未阻断
      if (verdict.decision !== "approve") {
        if (verdict.decision === "reject") approve.rejected += 1;
        else approve.skipped += 1;
        verdicts.push(verdict);
        continue;
      }
      if (input.skipApprove) {
        approve.skipped += 1;
        verdict.reasons = [...verdict.reasons, "skipApprove=true：不升权"];
        verdicts.push(verdict);
        continue;
      }
      try {
        assertOpsApproveAllowed();
      } catch (err) {
        approve.gateBlocked += 1;
        verdict.decision = "needs_human";
        verdict.reasons = [
          ...verdict.reasons,
          `门禁阻断：${err instanceof Error ? err.message : String(err)}`,
        ];
        verdicts.push(verdict);
        continue;
      }
      const gate = auditOpsApproveAllowedPath();
      try {
        voiceLibraryService.setStatus(asset.id, "approved");
        approve.approved += 1;
        verdict.reasons = [...verdict.reasons, `升 approved（via ${gate.via}）`];
      } catch (err) {
        approve.rejected += 1;
        verdict.decision = "needs_human";
        verdict.reasons = [
          ...verdict.reasons,
          `setStatus 失败（sha/license/heardAt 等门禁）：${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      verdicts.push(verdict);
    }

    return { verdicts, approve };
  }
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function makeReject(assetId: string, sha: string, reason: string): OpsEarVerdict {
  return {
    assetId,
    primarySha256: sha,
    decision: "reject",
    scores: { clarity: 0, cleanliness: 1, speechLikely: 0, durationOk: false, clipOk: true },
    reasons: [reason],
    agent: { name: "ear", version: EAR_AGENT_VERSION, model: null },
    heardAt: new Date().toISOString(),
  };
}

export const earAgent = new EarAgent();
