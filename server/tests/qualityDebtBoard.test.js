const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGenreBeatBoardSnapshot,
  buildQualityDebtBoardResult,
  buildVolumeReplanQualityDebtGate,
  getQualityLoopPersistFailOpenMetrics,
  isBlockingReplanQualityDebt,
  noteQualityLoopPersistFailOpen,
  QUALITY_DEBT_VOLUME_REPLAN_GATE_THRESHOLD,
  resetQualityLoopPersistFailOpenMetrics,
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


test("range-scoped replan gate ignores debts outside startOrder-endOrder", () => {
  const replan = (order) => ({
    order,
    riskFlags: riskFlags({
      overallStatus: "invalid",
      recommendedAction: "replan",
      rootCauseCode: "replan_required",
    }),
  });
  const chapters = [
    replan(1),
    replan(2),
    replan(3),
    replan(10),
    replan(11),
    replan(12),
  ];
  // job range 1-3 only has 3 replans → pause
  const inRange = buildVolumeReplanQualityDebtGate({
    chapters,
    startOrder: 1,
    endOrder: 3,
  });
  assert.equal(inRange.scope, "range");
  assert.equal(inRange.startOrder, 1);
  assert.equal(inRange.endOrder, 3);
  assert.equal(inRange.blockingReplanCount, 3);
  assert.equal(inRange.shouldPause, true);
  assert.match(inRange.reason, /第 1-3 章运行范围/);

  // job range 4-9 has 0 → no pause even if book has many
  const emptyRange = buildVolumeReplanQualityDebtGate({
    chapters,
    startOrder: 4,
    endOrder: 9,
  });
  assert.equal(emptyRange.blockingReplanCount, 0);
  assert.equal(emptyRange.shouldPause, false);
  assert.equal(emptyRange.reason, null);

  // board mode (no range) counts all 6
  const board = buildVolumeReplanQualityDebtGate({ chapters });
  assert.equal(board.scope, "board");
  assert.equal(board.blockingReplanCount, 6);
  assert.equal(board.shouldPause, true);
  assert.match(board.reason, /当前债板章节范围/);
});

test("genreBeat snapshot reports shortfalls without forcing director fuse", () => {
  const combatHeavy = Array.from({ length: 12 }, (_, index) => ({
    order: index + 1,
    title: `巷口伏击${index + 1}`,
    taskSheet: "开场交手，中段追击，结尾突围。",
    summary: "主角突围并反杀追兵。",
  }));
  const snapshot = buildGenreBeatBoardSnapshot({
    framing: {
      sellingPoint: "轻松养成与资源收集",
      competingFeel: "日常成长 + 打宝",
      first30ChapterPromise: "前三十章稳定养成与收集反馈",
    },
    chapters: combatHeavy,
    windowSize: 30,
  });
  assert.equal(snapshot.status, "observed");
  assert.equal(snapshot.labeledChapterCount, 12);
  assert.equal(snapshot.coverage.windowProgress, "in_progress");
  assert.ok(snapshot.coverage.shortfalls.some((item) => item.kind === "nurture" || item.kind === "collect"));
  assert.equal(snapshot.coverage.meetsPrimaryQuota, false);
  assert.match(snapshot.summaryLine, /主配额进度落后|养成|收集/);
  assert.equal(snapshot.sceneDiversity.advisory, true);
  assert.equal(typeof snapshot.sceneDiversity.recommendForce, "boolean");
  assert.equal("shouldForce" in snapshot.sceneDiversity, false);

  const board = buildQualityDebtBoardResult({
    novelId: "n-genre",
    chapters: [{
      id: "c1",
      order: 1,
      title: "开篇",
      riskFlags: riskFlags({
        overallStatus: "valid",
        recommendedAction: "continue",
        rootCauseCode: "none",
      }),
    }],
    genreBeat: {
      framing: {
        sellingPoint: "轻松养成",
        first30ChapterPromise: "养成与收集",
      },
      chapters: combatHeavy,
      windowSize: 30,
    },
  });
  assert.ok(board.genreBeatSnapshot);
  assert.equal(board.genreBeatSnapshot.status, "observed");
  assert.equal(board.genreBeatSnapshot.coverage.meetsPrimaryQuota, false);
  assert.equal(board.genreBeatSnapshot.sceneDiversity.advisory, true);
});

test("genreBeat snapshot null when genreBeat input omitted", () => {
  const board = buildQualityDebtBoardResult({
    novelId: "n-legacy",
    chapters: [{
      id: "c1",
      order: 1,
      title: "开篇",
      riskFlags: riskFlags({
        overallStatus: "valid",
        recommendedAction: "continue",
        rootCauseCode: "none",
      }),
    }],
  });
  assert.equal(board.genreBeatSnapshot, null);
});

test("genreBeat snapshot empty chapters is advisory with no labels", () => {
  const snapshot = buildGenreBeatBoardSnapshot({
    framing: { sellingPoint: "轻松养成" },
    chapters: [],
    windowSize: 30,
  });
  assert.equal(snapshot.labeledChapterCount, 0);
  assert.equal(snapshot.coverage.windowProgress, "in_progress");
  assert.match(snapshot.summaryLine, /尚无章可标注/);
  assert.equal(snapshot.sceneDiversity.advisory, true);
  assert.equal(snapshot.sceneDiversity.recommendForce, false);
});

test("shouldPauseForGenreBeatShortfall only when complete window fails primary quota", () => {
  const {
    shouldPauseForGenreBeatShortfall,
    formatGenreBeatShortfallPauseReason,
    isGenreBeatPipelinePauseEnabled,
  } = require("../dist/services/novel/quality/qualityDebtBoard.js");

  const previous = process.env.GENRE_BEAT_PIPELINE_PAUSE;
  try {
    delete process.env.GENRE_BEAT_PIPELINE_PAUSE;
    assert.equal(isGenreBeatPipelinePauseEnabled(), true);

    const framing = {
      sellingPoint: "轻松养成与资源收集",
      first30ChapterPromise: "前三十章稳定养成与收集反馈",
    };
    const combatHeavyComplete = Array.from({ length: 30 }, (_, index) => ({
      order: index + 1,
      title: `巷口伏击${index + 1}`,
      taskSheet: "开场交手，中段追击，结尾突围。",
      summary: "主角突围并反杀追兵。",
    }));
    const failSnapshot = buildGenreBeatBoardSnapshot({
      framing,
      chapters: combatHeavyComplete,
      windowSize: 30,
    });
    assert.equal(failSnapshot.coverage.windowProgress, "complete");
    assert.equal(failSnapshot.coverage.meetsPrimaryQuota, false);
    assert.equal(shouldPauseForGenreBeatShortfall(failSnapshot), true);
    assert.match(formatGenreBeatShortfallPauseReason(failSnapshot), /品类主配额未达标/);

    const partial = buildGenreBeatBoardSnapshot({
      framing,
      chapters: combatHeavyComplete.slice(0, 8),
      windowSize: 30,
    });
    assert.equal(partial.coverage.windowProgress, "in_progress");
    assert.equal(shouldPauseForGenreBeatShortfall(partial), false, "in-progress shortfall must not pause");

    // diversity recommendForce must not alone pause: combat framing + combat texts
    // → primary quota ok, but near-duplicate texts force recommendForce.
    const diversityOnly = buildGenreBeatBoardSnapshot({
      framing: {
        sellingPoint: "战斗热血对决杀伐高压",
        competingFeel: "升级打怪爽点战斗",
        first30ChapterPromise: "前三十章持续战斗对决与热血交手",
      },
      chapters: Array.from({ length: 30 }, (_, index) => ({
        order: index + 1,
        title: `巷口伏击${index + 1}`,
        taskSheet: "开场交手，中段追击，结尾突围反杀。",
        summary: "主角突围并反杀追兵，战斗对决收束。",
      })),
      windowSize: 30,
    });
    assert.equal(diversityOnly.coverage.windowProgress, "complete");
    assert.equal(
      diversityOnly.coverage.meetsPrimaryQuota,
      true,
      "combat-primary fixture must meet primary quota so diversity is isolated",
    );
    assert.equal(diversityOnly.sceneDiversity.recommendForce, true);
    assert.equal(
      shouldPauseForGenreBeatShortfall(diversityOnly),
      false,
      "recommendForce alone must never pause pipeline",
    );

    // P1-4 产品 B：无 framing 信号 → 满窗 combat 也不 pause（不 enforce 默认养成配额）
    const emptyFramingFull = buildGenreBeatBoardSnapshot({
      framing: {},
      chapters: combatHeavyComplete,
      windowSize: 30,
    });
    assert.equal(emptyFramingFull.coverage.windowProgress, "complete");
    assert.equal(emptyFramingFull.coverage.targets.length, 0);
    assert.equal(emptyFramingFull.coverage.meetsPrimaryQuota, true);
    assert.equal(
      shouldPauseForGenreBeatShortfall(emptyFramingFull),
      false,
      "empty framing must not pause pipeline on default nurture quota",
    );

    const weakFramingFull = buildGenreBeatBoardSnapshot({
      framing: { sellingPoint: "一部关于勇气的故事" },
      chapters: combatHeavyComplete,
      windowSize: 30,
    });
    assert.equal(shouldPauseForGenreBeatShortfall(weakFramingFull), false);

    const reasonWithAnchor = formatGenreBeatShortfallPauseReason(failSnapshot, {
      lastChapterOrder: 30,
    });
    assert.match(reasonWithAnchor, /第30章后/);
    assert.match(reasonWithAnchor, /品类主配额未达标/);

    process.env.GENRE_BEAT_PIPELINE_PAUSE = "0";
    assert.equal(isGenreBeatPipelinePauseEnabled(), false);
    assert.equal(shouldPauseForGenreBeatShortfall(failSnapshot), false, "ops kill-switch disables pause");
  } finally {
    if (previous === undefined) {
      delete process.env.GENRE_BEAT_PIPELINE_PAUSE;
    } else {
      process.env.GENRE_BEAT_PIPELINE_PAUSE = previous;
    }
  }
});

test("qualityLoop persist fail-open metrics count blocking replan memory (P2-2)", () => {
  resetQualityLoopPersistFailOpenMetrics();
  assert.equal(getQualityLoopPersistFailOpenMetrics().total, 0);

  noteQualityLoopPersistFailOpen({
    chapterId: "c-soft",
    jobId: "job-1",
    chapterBlocksReplanGate: false,
  });
  let metrics = getQualityLoopPersistFailOpenMetrics();
  assert.equal(metrics.total, 1);
  assert.equal(metrics.blockingReplanMemoryCount, 0);
  assert.equal(metrics.lastChapterId, "c-soft");
  assert.equal(metrics.lastJobId, "job-1");
  assert.ok(metrics.lastAt);

  noteQualityLoopPersistFailOpen({
    chapterId: "c-replan",
    jobId: "job-1",
    chapterBlocksReplanGate: true,
  });
  metrics = getQualityLoopPersistFailOpenMetrics();
  assert.equal(metrics.total, 2);
  assert.equal(metrics.blockingReplanMemoryCount, 1);
  assert.equal(metrics.lastChapterId, "c-replan");

  assert.equal(isBlockingReplanQualityDebt({
    rootCauseCode: "replan_required",
    recommendedAction: "replan",
  }), true);
  assert.equal(isBlockingReplanQualityDebt({
    rootCauseCode: "draft_obligation_unmet",
    recommendedAction: "patch_repair",
  }), false);

  resetQualityLoopPersistFailOpenMetrics();
  assert.equal(getQualityLoopPersistFailOpenMetrics().total, 0);
});
