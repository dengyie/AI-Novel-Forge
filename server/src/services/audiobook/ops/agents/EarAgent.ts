/**
 * EarAgent v2（AI 耳 / 拟人耳升权）。
 *
 * 流程：
 *  1. list draft（或指定 assetIds）
 *  2. sha 对齐 → 启发式 → 非 reject 写 heard → 门禁后 setStatus
 *
 * 升权策略（生产安全默认）：
 *  - hard `approve` 可自动升权
 *  - `approve_with_low_confidence` **默认不升权**（requireHardApprove=true）
 *  - 显式 `requireHardApprove: false` 或 env `EAR_AUTO_SOFT_APPROVE=1` 才软升权
 *
 * 不变量：import 永 draft；heardSha 经 mark 后才能 approved；不直批。
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
  /** 显式禁升权（dry-run / 只看 verdict） */
  skipApprove?: boolean;
  /**
   * true（默认）：仅 hard approve 升权。
   * false：approve + approve_with_low_confidence 都升权。
   * 未传时：env EAR_AUTO_SOFT_APPROVE=1 → false，否则 true。
   */
  requireHardApprove?: boolean;
  isForceKeepDraft?: (assetId: string) => boolean;
  isForceReject?: (assetId: string) => boolean;
  model?: string | null;
}

export interface EarAgentRunResult {
  verdicts: OpsEarVerdict[];
  approve: {
    attempted: number;
    approved: number;
    approvedHard: number;
    approvedSoft: number;
    rejected: number;
    skipped: number;
    gateBlocked: number;
  };
}

export function resolveRequireHardApprove(input?: boolean): boolean {
  if (typeof input === "boolean") return input;
  // 生产安全默认：仅 hard 升权；显式 EAR_AUTO_SOFT_APPROVE=1 才软升
  return process.env.EAR_AUTO_SOFT_APPROVE?.trim() !== "1";
}

function isAutoApproveDecision(
  decision: OpsEarVerdict["decision"],
  requireHard: boolean,
): boolean {
  if (decision === "approve") return true;
  if (decision === "approve_with_low_confidence") return !requireHard;
  return false;
}

export class EarAgent {
  run(input: EarAgentRunInput): EarAgentRunResult {
    const verdicts: OpsEarVerdict[] = [];
    const approve = {
      attempted: 0,
      approved: 0,
      approvedHard: 0,
      approvedSoft: 0,
      rejected: 0,
      skipped: 0,
      gateBlocked: 0,
    };
    const requireHard = resolveRequireHardApprove(input.requireHardApprove);

    let assets: { id: string; status: string; kind: string }[];
    if (input.assetIds && input.assetIds.length > 0) {
      const filtered: VoiceAsset[] = [];
      for (const id of input.assetIds) {
        const a = voiceLibraryService.getById?.(id)
          ?? voiceLibraryService.list({}).items.find((x: VoiceAsset) => x.id === id);
        if (a) filtered.push(a as VoiceAsset);
      }
      assets = filtered.map((a) => ({ id: a.id, status: a.status, kind: a.kind }));
    } else {
      const list = voiceLibraryService.list({ status: ["draft"] });
      assets = list.items.map((a: VoiceAsset) => ({ id: a.id, status: a.status, kind: a.kind }));
    }

    for (const meta of assets) {
      const asset =
        (typeof voiceLibraryService.getById === "function"
          ? voiceLibraryService.getById(meta.id)
          : null)
        ?? voiceLibraryService.list({}).items.find((x: VoiceAsset) => x.id === meta.id);
      if (!asset) {
        approve.skipped += 1;
        continue;
      }
      if (asset.status !== "draft") {
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
          makeReject(
            asset.id,
            expectedSha,
            `sha 不一致（文件已覆盖或损坏）：期望=${expectedSha.slice(0, 8)} 实测=${fileSha.slice(0, 8)}`,
          ),
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

      const forceKeep = input.isForceKeepDraft?.(asset.id) ?? false;
      const forceReject = input.isForceReject?.(asset.id) ?? false;
      if (forceKeep) {
        verdict.reasons = [...verdict.reasons, "forceKeepDraft：不升权，保留 draft"];
        if (isAutoApproveDecision(verdict.decision, requireHard) || verdict.decision === "approve_with_low_confidence") {
          verdict.decision = "needs_human";
        }
      }
      if (forceReject) {
        verdict.decision = "reject";
        verdict.reasons = [...verdict.reasons, "forceReject：强制 reject"];
      }

      // 仅非 reject 写 heard（reject 不假装听过）
      let heardOk = verdict.decision === "reject";
      if (verdict.decision !== "reject") {
        try {
          voiceLibraryService.markLibraryPreviewHeard(asset.id, {
            heardBy: `agent:ear@${EAR_AGENT_VERSION}`,
          });
          heardOk = true;
        } catch (err) {
          heardOk = false;
          verdict.reasons = [
            ...verdict.reasons,
            `markLibraryPreviewHeard 失败：${err instanceof Error ? err.message : String(err)}`,
          ];
        }
      }

      approve.attempted += 1;

      // soft 保留 draft：计 skipped，不升权
      if (verdict.decision === "approve_with_low_confidence" && requireHard) {
        approve.skipped += 1;
        verdict.reasons = [
          ...verdict.reasons,
          "requireHardApprove：soft 不升权（设 EAR_AUTO_SOFT_APPROVE=1 或 requireHardApprove:false）",
        ];
        verdicts.push(verdict);
        continue;
      }

      if (!isAutoApproveDecision(verdict.decision, requireHard)) {
        if (verdict.decision === "reject") approve.rejected += 1;
        else approve.skipped += 1;
        verdicts.push(verdict);
        continue;
      }

      if (!heardOk) {
        approve.rejected += 1;
        verdict.decision = "needs_human";
        verdict.reasons = [...verdict.reasons, "heard 未写入，跳过升权"];
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
      const decisionBefore = verdict.decision;
      try {
        voiceLibraryService.setStatus(asset.id, "approved");
        approve.approved += 1;
        if (decisionBefore === "approve") approve.approvedHard += 1;
        else if (decisionBefore === "approve_with_low_confidence") approve.approvedSoft += 1;
        verdict.reasons = [
          ...verdict.reasons,
          `升 approved（AI 耳 via ${gate.via}；decision=${decisionBefore}）`,
        ];
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
    decisionReasonCodes: ["soft_fail"],
    reasons: [reason],
    agent: { name: "ear", version: EAR_AGENT_VERSION, model: null },
    heardAt: new Date().toISOString(),
  };
}

export const earAgent = new EarAgent();
