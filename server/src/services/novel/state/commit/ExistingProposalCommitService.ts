import type {
  StateChangeProposal,
  StateCommitResult,
} from "@ai-novel/shared/types/canonicalState";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";
import { canonicalStateService } from "../CanonicalStateService";
import { stateVersionLog } from "../StateVersionLog";
import {
  attachProposalSourceQuality,
  resolveProposalSourceQuality,
} from "../stateProposalSourceQuality";
import {
  publishWorkflowTaskOwnershipCommitted,
  WorkflowTaskOwnershipLostError,
  type WorkflowTaskOwnershipSnapshot,
} from "../../workflow/ownership/WorkflowTaskOwnership";
import { fenceWorkflowTaskCommandExecution } from "../../workflow/ownership/WorkflowTaskExecutionFence";

export interface CommitExistingProposalsInput {
  novelId: string;
  proposalIds: string[];
  supersededProposalIds?: string[];
  supersededReason?: string;
  chapterId?: string | null;
  chapterOrder?: number | null;
  sourceType?: string;
  sourceStage?: string | null;
  reason: string;
  ownership?: WorkflowTaskOwnershipSnapshot;
}

export interface OwnedStateCommitResult extends StateCommitResult {
  ownership: WorkflowTaskOwnershipSnapshot | null;
}

interface PersistedProposalRow {
  id: string;
  novelId: string;
  chapterId: string | null;
  sourceSnapshotId: string | null;
  sourceType: string;
  sourceStage: string | null;
  proposalType: string;
  riskLevel: string;
  status: string;
  summary: string;
  payloadJson: string;
  evidenceJson: string | null;
  validationNotesJson: string | null;
}

interface ExistingProposalCommitServiceDeps {
  applyCommittedProposal(
    tx: Prisma.TransactionClient,
    proposal: StateChangeProposal,
  ): Promise<void>;
  buildVersionSummary(
    chapterOrder: number | undefined,
    committed: StateChangeProposal[],
  ): string;
}

function compactText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export class ExistingProposalCommitService {
  constructor(private readonly deps: ExistingProposalCommitServiceDeps) {}

  async commit(input: CommitExistingProposalsInput): Promise<OwnedStateCommitResult> {
    const proposalIds = Array.from(new Set(input.proposalIds.map((id) => compactText(id)).filter(Boolean)));
    const supersededProposalIds = Array.from(new Set(
      (input.supersededProposalIds ?? []).map((id) => compactText(id)).filter(Boolean),
    ));
    if (proposalIds.length === 0 && supersededProposalIds.length === 0) {
      return {
        versionRecord: null,
        committed: [],
        pendingReview: [],
        rejected: [],
        ownership: input.ownership ?? null,
      };
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      let ownership = input.ownership ?? null;
      if (input.ownership) {
        await fenceWorkflowTaskCommandExecution(tx, input.ownership);
        const claimed = await tx.novelWorkflowTask.updateMany({
          where: {
            id: input.ownership.taskId,
            novelId: input.novelId,
            lane: "auto_director",
            status: { in: ["queued", "running", "waiting_approval", "failed"] },
            cancelRequestedAt: null,
            attemptCount: input.ownership.attemptCount,
            ownershipVersion: input.ownership.ownershipVersion,
          },
          data: { ownershipVersion: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          throw new WorkflowTaskOwnershipLostError(input.ownership.taskId);
        }
        const task = await tx.novelWorkflowTask.findUnique({
          where: { id: input.ownership.taskId },
          select: { id: true, attemptCount: true, ownershipVersion: true },
        });
        if (!task) {
          throw new WorkflowTaskOwnershipLostError(input.ownership.taskId);
        }
        ownership = {
          taskId: task.id,
          attemptCount: task.attemptCount,
          ownershipVersion: task.ownershipVersion,
        };
      }

      const rows = proposalIds.length > 0
        ? await tx.stateChangeProposal.findMany({
          where: {
            novelId: input.novelId,
            id: { in: proposalIds },
            status: "pending_review",
          },
        })
        : [];
      const supersededRows = supersededProposalIds.length > 0
        ? await tx.stateChangeProposal.findMany({
          where: {
            novelId: input.novelId,
            id: { in: supersededProposalIds },
            status: "pending_review",
          },
        })
        : [];
      const committed: StateChangeProposal[] = [];
      const rejected: StateChangeProposal[] = [];

      for (const row of supersededRows) {
        const proposal = this.toProposal(row);
        if (!proposal.id) {
          continue;
        }
        const next = {
          ...proposal,
          status: "rejected" as const,
          validationNotes: proposal.validationNotes.concat(
            `pending_review_auto_promotion:superseded:${input.supersededReason ?? "superseded"}`,
          ),
        };
        const claimed = await tx.stateChangeProposal.updateMany({
          where: {
            id: proposal.id,
            novelId: input.novelId,
            status: "pending_review",
          },
          data: {
            status: "rejected",
            validationNotesJson: JSON.stringify(next.validationNotes),
          },
        });
        if (claimed.count === 1) {
          rejected.push(next);
        }
      }

      for (const row of rows) {
        const proposal = this.toProposal(row);
        if (!proposal.id) {
          continue;
        }
        const next = {
          ...proposal,
          status: "committed" as const,
          validationNotes: proposal.validationNotes.concat(`proposal_commit:${input.reason}`),
        };
        const claimed = await tx.stateChangeProposal.updateMany({
          where: {
            id: proposal.id,
            novelId: input.novelId,
            status: "pending_review",
          },
          data: {
            status: "committed",
            validationNotesJson: JSON.stringify(next.validationNotes),
          },
        });
        if (claimed.count !== 1) {
          continue;
        }
        await this.deps.applyCommittedProposal(tx, next);
        committed.push(next);
      }
      return { committed, rejected, ownership };
    });

    const { committed, rejected, ownership } = transactionResult;
    publishWorkflowTaskOwnershipCommitted(input.ownership, ownership);
    if (committed.length === 0) {
      return {
        versionRecord: null,
        committed: [],
        pendingReview: [],
        rejected,
        ownership,
      };
    }

    const snapshot = await canonicalStateService.getSnapshot(input.novelId, {
      chapterId: input.chapterId ?? committed[0]?.chapterId ?? undefined,
      chapterOrder: input.chapterOrder ?? undefined,
      includeCurrentChapterState: true,
    });
    const versionRecord = await stateVersionLog.createVersion({
      novelId: input.novelId,
      chapterId: input.chapterId ?? committed[0]?.chapterId ?? null,
      sourceType: input.sourceType ?? "manual_state_commit",
      sourceStage: input.sourceStage ?? "proposal_confirmation",
      summary: this.deps.buildVersionSummary(input.chapterOrder ?? undefined, committed),
      acceptedProposalIds: committed.map((proposal) => proposal.id).filter((id): id is string => Boolean(id)),
      snapshot,
    });
    await prisma.stateChangeProposal.updateMany({
      where: {
        novelId: input.novelId,
        status: "committed",
        id: {
          in: committed.map((proposal) => proposal.id).filter((id): id is string => Boolean(id)),
        },
      },
      data: {
        committedVersionId: versionRecord.id,
      },
    });

    return {
      versionRecord,
      committed,
      pendingReview: [],
      rejected,
      ownership,
    };
  }

  private toProposal(row: PersistedProposalRow): StateChangeProposal {
    const validationNotes = this.parseStringArray(row.validationNotesJson);
    const proposal: StateChangeProposal = {
      id: row.id,
      novelId: row.novelId,
      chapterId: row.chapterId ?? null,
      sourceSnapshotId: row.sourceSnapshotId ?? null,
      sourceType: row.sourceType,
      sourceStage: row.sourceStage ?? null,
      proposalType: row.proposalType as StateChangeProposal["proposalType"],
      riskLevel: row.riskLevel as StateChangeProposal["riskLevel"],
      status: row.status as StateChangeProposal["status"],
      summary: row.summary,
      payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
      evidence: this.parseStringArray(row.evidenceJson),
      validationNotes,
    };
    return attachProposalSourceQuality(proposal, resolveProposalSourceQuality(proposal));
  }

  private parseStringArray(value: string | null | undefined): string[] {
    if (!value?.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((item) => compactText(String(item ?? ""))).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }
}
