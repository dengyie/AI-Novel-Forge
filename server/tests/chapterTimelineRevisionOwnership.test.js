const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const {
  ChapterTimelineFinalizationService,
} = require("../dist/services/novel/runtime/ChapterTimelineFinalizationService.js");
const {
  timelineCheckerService,
  timelineExtractorService,
} = require("../dist/modules/timeline/index.js");
const {
  PrismaTimelineRepository,
} = require("../dist/modules/timeline/timeline.repository.js");

function timelineContext() {
  return {
    currentChapterIndex: 3,
    currentTime: { storyDayIndex: 2, label: "第二日夜" },
    previousEvents: [],
    plannedEventsThisChapter: [],
    openHooks: [],
    blockingHooks: [],
    softHooks: [],
    addressedHooks: [],
    forbiddenEvents: [],
    continuityRequirements: [],
    knownStateChanges: [],
  };
}

test("timeline extraction for revision N cannot commit after chapter advances to N+1", async () => {
  const originals = {
    checkpointFindMany: prisma.chapterArtifactSyncCheckpoint.findMany,
    checkpointFindFirst: prisma.chapterArtifactSyncCheckpoint.findFirst,
    checkpointCreate: prisma.chapterArtifactSyncCheckpoint.create,
    checkpointUpdateMany: prisma.chapterArtifactSyncCheckpoint.updateMany,
    checkpointUpsert: prisma.chapterArtifactSyncCheckpoint.upsert,
    chapterFindFirst: prisma.chapter.findFirst,
    transaction: prisma.$transaction,
    eventCreate: prisma.storyTimelineEvent.create,
    anchorUpsert: prisma.chapterTimeAnchor.upsert,
    hookCreateMany: prisma.timelineHook.createMany,
    reportCreate: prisma.timelineCheckReport.create,
    extract: timelineExtractorService.extractFromChapter,
    check: timelineCheckerService.checkChapter,
  };
  let contentRevision = 7;
  let releaseExtractor;
  let signalExtractorStarted;
  const extractorStarted = new Promise((resolve) => {
    signalExtractorStarted = resolve;
  });
  const extractorReleased = new Promise((resolve) => {
    releaseExtractor = resolve;
  });
  const writes = { events: 0, hooks: 0, anchors: 0, reports: 0 };

  const chapterLookup = async ({ where }) => (
    where.novelId === "novel-1"
      && where.id === "chapter-3"
      && (where.contentRevision === undefined || where.contentRevision === contentRevision)
      ? { id: "chapter-3", contentRevision }
      : null
  );
  const eventCreate = async ({ data }) => {
    writes.events += 1;
    return { id: `event-${writes.events}`, createdAt: new Date(), updatedAt: new Date(), ...data };
  };
  const anchorUpsert = async ({ create, update }) => {
    writes.anchors += 1;
    return {
      id: "anchor-3",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(writes.anchors === 1 ? create : update),
      novelId: "novel-1",
      chapterId: "chapter-3",
    };
  };
  const hookCreateMany = async ({ data }) => {
    writes.hooks += data.length;
    return { count: data.length };
  };

  prisma.chapterArtifactSyncCheckpoint.findMany = async () => [];
  prisma.chapterArtifactSyncCheckpoint.findFirst = async () => null;
  prisma.chapterArtifactSyncCheckpoint.create = async ({ data }) => ({
    id: "checkpoint-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });
  prisma.chapterArtifactSyncCheckpoint.updateMany = async () => ({ count: 1 });
  prisma.chapterArtifactSyncCheckpoint.upsert = async ({ create }) => ({
    id: "checkpoint-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...create,
  });
  prisma.chapter.findFirst = chapterLookup;
  prisma.storyTimelineEvent.create = eventCreate;
  prisma.chapterTimeAnchor.upsert = anchorUpsert;
  prisma.timelineHook.createMany = hookCreateMany;
  prisma.timelineCheckReport.create = async ({ data }) => ({
    id: "report-1",
    createdAt: new Date(),
    ...data,
  });
  prisma.$transaction = async (callback) => callback({
    chapter: { findFirst: chapterLookup },
    storyTimelineEvent: {
      create: eventCreate,
      deleteMany: async () => {
        writes.events += 1;
        return { count: 0 };
      },
    },
    chapterTimeAnchor: { upsert: anchorUpsert, deleteMany: async () => ({ count: 0 }) },
    timelineHook: {
      createMany: hookCreateMany,
      deleteMany: async () => {
        writes.hooks += 1;
        return { count: 0 };
      },
      updateMany: async () => {
        writes.hooks += 1;
        return { count: 0 };
      },
    },
    timelineCheckReport: {
      create: async ({ data }) => {
        writes.reports += 1;
        return { id: "report-1", createdAt: new Date(), ...data };
      },
    },
  });
  timelineExtractorService.extractFromChapter = async () => {
    signalExtractorStarted();
    await extractorReleased;
    return {
      events: [{
        title: "旧正文事件",
        summary: "revision 7 抽取出的事件",
        type: "plot",
        participantNames: [],
        stateChanges: [],
        possibleHooks: [{
          title: "旧正文钩子",
          description: "不应进入 revision 8 的时间线",
          priority: "high",
          resolveMode: "short_arc",
          blocking: false,
        }],
        occurred: true,
        confidence: 0.9,
        matchedPlannedEventIds: [],
      }],
      hooks: [],
      stateChanges: [],
      timeAnchor: { storyDayIndex: 2, label: "第二日夜" },
      addressedHookIds: [],
      resolvedHookIds: [],
    };
  };
  timelineCheckerService.checkChapter = () => ({ status: "passed", score: 1, issues: [] });

  try {
    const finalization = new ChapterTimelineFinalizationService().finalizeCurrentContent({
      novelId: "novel-1",
      chapterId: "chapter-3",
      expectedContentRevision: 7,
      content: "revision 7 的正文",
      contextPackage: {
        chapter: { id: "chapter-3", title: "第三章", order: 3 },
        timelineContext: timelineContext(),
        bookContract: { title: "并发测试小说" },
      },
      sourceStage: "chapter_content_finalization",
    });

    await extractorStarted;
    contentRevision = 8;
    releaseExtractor();
    const result = await finalization;

    assert.equal(result.syncMode, "degraded");
    assert.deepEqual(writes, { events: 0, hooks: 0, anchors: 0, reports: 0 });
  } finally {
    prisma.chapterArtifactSyncCheckpoint.findMany = originals.checkpointFindMany;
    prisma.chapterArtifactSyncCheckpoint.findFirst = originals.checkpointFindFirst;
    prisma.chapterArtifactSyncCheckpoint.create = originals.checkpointCreate;
    prisma.chapterArtifactSyncCheckpoint.updateMany = originals.checkpointUpdateMany;
    prisma.chapterArtifactSyncCheckpoint.upsert = originals.checkpointUpsert;
    prisma.chapter.findFirst = originals.chapterFindFirst;
    prisma.$transaction = originals.transaction;
    prisma.storyTimelineEvent.create = originals.eventCreate;
    prisma.chapterTimeAnchor.upsert = originals.anchorUpsert;
    prisma.timelineHook.createMany = originals.hookCreateMany;
    prisma.timelineCheckReport.create = originals.reportCreate;
    timelineExtractorService.extractFromChapter = originals.extract;
    timelineCheckerService.checkChapter = originals.check;
  }
});

test("automatic timeline replacement preserves manual rows and manual chapter anchor", async () => {
  const originalTransaction = prisma.$transaction;
  const calls = {
    eventDelete: [],
    hookDelete: [],
    hookUpdate: [],
    eventCreate: [],
    hookCreate: [],
    anchorUpsert: 0,
    reports: 0,
  };
  const tx = {
    chapter: { findFirst: async ({ where }) => (
      where.novelId === "novel-1"
        && where.id === "chapter-3"
        && where.contentRevision === 8
        ? { id: "chapter-3" }
        : null
    ) },
    storyTimelineEvent: {
      deleteMany: async ({ where }) => {
        calls.eventDelete.push(where);
        return { count: 1 };
      },
      create: async ({ data }) => {
        calls.eventCreate.push(data);
        return { id: "event-new", createdAt: new Date(), updatedAt: new Date(), ...data };
      },
    },
    timelineHook: {
      deleteMany: async ({ where }) => {
        calls.hookDelete.push(where);
        return { count: 1 };
      },
      updateMany: async ({ where }) => {
        calls.hookUpdate.push(where);
        return { count: 0 };
      },
      createMany: async ({ data }) => {
        calls.hookCreate.push(...data);
        return { count: data.length };
      },
    },
    chapterTimeAnchor: {
      findUnique: async () => ({ source: "manual" }),
      upsert: async () => {
        calls.anchorUpsert += 1;
        return {};
      },
    },
    timelineCheckReport: {
      create: async () => {
        calls.reports += 1;
        return {};
      },
    },
  };
  prisma.$transaction = async (callback) => callback(tx);

  try {
    await new PrismaTimelineRepository().commitAutomaticChapterTimeline({
      owner: { novelId: "novel-1", chapterId: "chapter-3", expectedContentRevision: 8 },
      events: [{
        novelId: "novel-1",
        chapterId: "chapter-3",
        chapterIndex: 3,
        eventOrder: 3001,
        storyDayIndex: 2,
        storyTimeLabel: "第二日夜",
        title: "新正文事件",
        summary: "仅替换自动抽取事件",
        type: "plot",
        status: "occurred",
        visibility: "reader_known",
        source: "chapter_extraction",
        participantIds: [],
        locationId: null,
        factionIds: [],
        prerequisiteEventIds: [],
        consequenceEventIds: [],
        stateChanges: [],
        eventKey: "new-event",
        confidence: 0.9,
      }],
      anchor: {
        novelId: "novel-1",
        chapterId: "chapter-3",
        chapterIndex: 3,
        storyDayIndex: 2,
        timeLabel: "第二日夜",
        startsAfterEventIds: [],
        plannedEventIds: [],
        previousHookIds: [],
        nextHookIds: [],
        forbiddenEventIds: [],
      },
      hooks: [{
        novelId: "novel-1",
        createdInChapterId: "chapter-3",
        createdInChapterIndex: 3,
        title: "新钩子",
        description: "仅替换自动抽取钩子",
        priority: "high",
      }],
      addressedHookIds: ["manual-hook", "automatic-hook"],
      resolvedHookIds: [],
      checkReport: {
        novelId: "novel-1",
        chapterId: "chapter-3",
        chapterIndex: 3,
        status: "passed",
        score: 1,
        issues: [],
      },
    });

    assert.deepEqual(calls.eventDelete, [{
      novelId: "novel-1",
      chapterId: "chapter-3",
      source: "chapter_extraction",
    }]);
    assert.deepEqual(calls.hookDelete, [{
      novelId: "novel-1",
      createdInChapterId: "chapter-3",
      source: "chapter_extraction",
    }]);
    assert.equal(calls.anchorUpsert, 0);
    assert.equal(calls.eventCreate.length, 1);
    assert.equal(calls.hookCreate.length, 1);
    assert.equal(calls.hookCreate[0].source, "chapter_extraction");
    assert.ok(calls.hookUpdate.every((where) => where.source === "chapter_extraction"));
    assert.equal(calls.reports, 1);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});
