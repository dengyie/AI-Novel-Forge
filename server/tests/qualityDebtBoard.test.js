const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQualityDebtBoardResult,
  buildVolumeReplanQualityDebtGate,
  QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
  shouldPauseVolumeForReplanQualityDebt,
} = require("../dist/services/novel/quality/qualityDebtBoard.js");

function riskFlags(loop) {
  return JSON.stringify({ qualityLoop: loop });
}

test("quality debt board lists non-continue chapters and volume replan gate", () => {
  const chapters = [
    {
      id: "c1",
      order: 1,
      title: "开篇",
      generationState: "approved",
      chapterStatus: "completed",
      riskFlags: riskFlags({
        overallStatus: "valid",
        recommendedAction: "continue",
        rootCauseCode: "none",
      }),
    },
    {
      id: "c2",
      order: 2,
      title: "债1",
      generationState: "reviewed",
      chapterStatus: "pending_review",
      riskFlags: riskFlags({
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
        terminalAction: "defer_and_continue",
        evaluatedAt: "2026-07-11T00:00:00.000Z",
      }),
    },
    {
      id: "c3",
      order: 3,
      title: "债2",
      generationState: "reviewed",
      chapterStatus: "pending_review",
      riskFlags: riskFlags({
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
        terminalAction: "defer_and_continue",
      }),
    },
    {
      id: "c4",
      order: 4,
      title: "债3",
      generationState: "reviewed",
      chapterStatus: "pending_review",
      riskFlags: riskFlags({
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
      }),
    },
    {
      id: "c5",
      order: 5,
      title: "patch债",
      generationState: "reviewed",
      chapterStatus: "pending_review",
      riskFlags: riskFlags({
        overallStatus: "risk",
        recommendedAction: "patch_repair",
        rootCauseCode: "draft_obligation_unmet",
        terminalAction: "defer_and_continue",
      }),
    },
  ];

  const board = buildQualityDebtBoardResult({ novelId: "n1", chapters });
  assert.equal(board.items.length, 4);
  assert.equal(board.summary.blockingReplanCount, 3);
  assert.equal(board.volumeReplanGate.threshold, QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD);
  assert.equal(board.volumeReplanGate.shouldPause, true);
  assert.match(board.volumeReplanGate.reason, /3/);
});

test("volume replan gate does not pause below threshold", () => {
  const chapters = [
    {
      riskFlags: riskFlags({
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
      }),
    },
    {
      riskFlags: riskFlags({
        overallStatus: "invalid",
        recommendedAction: "replan",
        rootCauseCode: "replan_required",
      }),
    },
  ];
  const gate = buildVolumeReplanQualityDebtGate({ chapters });
  assert.equal(gate.blockingReplanCount, 2);
  assert.equal(gate.shouldPause, false);
  assert.equal(shouldPauseVolumeForReplanQualityDebt(2), false);
  assert.equal(shouldPauseVolumeForReplanQualityDebt(3), true);
});

test("deferred patch repair is non-blocking for volume replan count", () => {
  const chapters = Array.from({ length: 5 }, (_, i) => ({
    riskFlags: riskFlags({
      overallStatus: "risk",
      recommendedAction: "patch_repair",
      rootCauseCode: "draft_repair_exhausted",
      terminalAction: "defer_and_continue",
    }),
  }));
  const gate = buildVolumeReplanQualityDebtGate({ chapters });
  assert.equal(gate.blockingReplanCount, 0);
  assert.equal(gate.shouldPause, false);
});
