const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/db/prisma.js');
const factory = require('../dist/llm/factory.js');
const { normalizeChapterScenePlan, serializeChapterScenePlan } = require('../../shared/dist/types/chapterLengthControl.js');
const { ChapterTaskSheetQualityGateService } = require('../dist/services/novel/volume/ChapterTaskSheetQualityGateService.js');
const { ChapterExecutionContractService } = require('../dist/services/novel/volume/ChapterExecutionContractService.js');
const generation = require('../dist/services/novel/volume/volumeGenerationOrchestrator.js');

// P1#1 回归（2026-10-31 review 修复）：写前连续性核对的分支判据必须基于
// assessment.recommendedHandling —— repair_contract 在 autopilot 下把指导送回
// 现有生成链做一次有界重生成（不 throw）；unusable / replan_window 硬阻断；
// 副驾模式不静默重生成；use_as_is 复用；kill-switch 整体回退旧行为。

function fixture(t) {
  const originals = [
    ChapterTaskSheetQualityGateService.prototype.evaluate,
    prisma.chapter.findFirst,
    prisma.chapterArtifactSyncCheckpoint.findUnique,
    prisma.chapterArtifactSyncCheckpoint.upsert,
    factory.resolveLLMClientOptions,
    generation.generateVolumePlanDocument,
  ];
  const previous = {
    order: 3,
    title: '信纸多出一行',
    content: '林砚把自己手抄的纸翻过来，背面有了周德海的名字。两人离开钟表铺，向邮局走去。',
  };
  const sceneCards = serializeChapterScenePlan(normalizeChapterScenePlan({
    scenes: [1, 2, 3].map((n) => ({
      key: `s${n}`, title: `场景${n}`, purpose: '核对工牌', entryState: '两人在邮局',
      exitState: '确认新线索', mustAdvance: ['核对学校'], mustPreserve: ['保留手抄件'],
      forbiddenExpansion: ['不提前揭晓真相'], targetWordCount: 1000,
    })),
  }, 3000));
  const chapterRow = {
    id: 'c4', novelId: 'n', title: '工牌对上了', order: 4,
    targetWordCount: 3000, conflictLevel: 3, revealLevel: 2, mustAvoid: '不得提前揭晓秘密',
    taskSheet: '苏晚离开钟表铺时，林砚发现邮戳编号。',
    sceneCards,
    content: '', contentRevision: 0, updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  };
  const workspaceChapter = {
    id: 'p4', title: '工牌对上了', summary: '核对工牌', purpose: '比对信件旧校名',
    exclusiveEvent: '发现父亲真实履历', endingState: '获得邮戳编号',
    nextChapterEntryState: '查找分拣口', taskSheet: chapterRow.taskSheet,
    sceneCards, targetWordCount: 3000,
  };
  const state = {
    assessment: {
      verdict: 'usable', safeToSync: true, loadRisk: 'normal', recommendedHandling: 'use_as_is',
      summary: '可以承接', issues: [], repairGuidance: [], confidence: 0.9,
    },
    reviewCalls: [],
    generated: [],
  };
  const boundary = new Error('offline generator boundary');
  ChapterTaskSheetQualityGateService.prototype.evaluate = async (candidate, options) => {
    state.reviewCalls.push({ candidate, mode: options.mode });
    await options.onEvaluated({ assessment: state.assessment });
    // 映射语义与 shared mapSemanticAssessmentToQualityGate 一致：仅 usable+safeToSync 可执行。
    if (state.assessment.verdict === 'usable' && state.assessment.safeToSync) {
      return { status: 'passed', canEnterExecution: true, issues: [], summary: state.assessment.summary, repairGuidance: [], confidence: 0.9 };
    }
    return {
      status: options.mode === 'full_book_autopilot' ? 'repairable' : 'needs_confirmation',
      canEnterExecution: false,
      issues: state.assessment.issues.map((issue) => ({ ...issue, repairHint: issue.repairHint ?? issue.summary })),
      summary: state.assessment.summary,
      repairGuidance: state.assessment.repairGuidance,
      confidence: 0.9,
    };
  };
  prisma.chapter.findFirst = async ({ where }) => {
    if (where.id) return chapterRow;
    if (where.order === previous.order) return previous;
    return null;
  };
  prisma.chapterArtifactSyncCheckpoint.findUnique = async () => null;
  prisma.chapterArtifactSyncCheckpoint.upsert = async (input) => input.create;
  factory.resolveLLMClientOptions = async () => ({
    provider: 'deepseek', model: 'offline-model', baseURL: 'https://offline.invalid',
    temperature: 0.1, maxTokens: null, requestProtocol: 'openai_compatible', structuredStrategy: null,
  });
  generation.generateVolumePlanDocument = async (input) => {
    state.generated.push(input);
    throw boundary;
  };
  const service = new ChapterExecutionContractService({
    storyMacroPlanService: { getPlan: async () => null },
    styleBindingService: { resolveForGeneration: async () => null },
    ensureVolumeWorkspace: async () => ({ novelId: 'n', volumes: [{ id: 'v', chapters: [workspaceChapter] }] }),
    findVolumeChapterMatch: () => ({ volumeId: 'v', volumeChapterId: 'p4' }),
    ensureActiveVersionRecord: async () => ({ versionId: 'ver1', version: 1 }),
    emitVolumeUpdated: () => undefined,
  });
  const baseOptions = {
    provider: 'deepseek', model: 'offline-model', entrypoint: 'auto_director',
    chapterTaskSheetQualityMode: 'full_book_autopilot',
  };
  t.after(() => {
    [
      ChapterTaskSheetQualityGateService.prototype.evaluate,
      prisma.chapter.findFirst,
      prisma.chapterArtifactSyncCheckpoint.findUnique,
      prisma.chapterArtifactSyncCheckpoint.upsert,
      factory.resolveLLMClientOptions,
      generation.generateVolumePlanDocument,
    ] = originals;
  });
  return { state, service, baseOptions, boundary, workspaceChapter };
}

test('repair_contract conflict regenerates through the existing chain with guidance (autopilot)', async (t) => {
  const f = fixture(t);
  f.state.assessment = {
    verdict: 'repairable', safeToSync: false, loadRisk: 'normal', recommendedHandling: 'repair_contract',
    summary: '前文已到邮局，不能无故回到钟表铺',
    issues: [{ id: 'continuity', severity: 'medium', target: 'semantic', summary: '入口地点冲突', repairHint: '把编号发现移至邮局' }],
    repairGuidance: ['保留手抄件和已有字迹'],
    confidence: 0.9,
  };
  await assert.rejects(
    f.service.ensureChapterExecutionContract('n', 'c4', f.baseOptions),
    (error) => error === f.boundary,
  );
  assert.equal(f.state.generated.length, 1, 'guidance flows into the existing generation chain');
  const guidance = f.state.generated[0].options.guidance ?? '';
  assert.ok(guidance.includes('上一章实际正文与本章规划需要协调'));
  assert.ok(guidance.includes('移至邮局'));
  assert.equal(f.state.reviewCalls.length, 1);
});

test('unusable verdict hard-blocks without regenerating', async (t) => {
  const f = fixture(t);
  f.state.assessment = {
    verdict: 'unusable', safeToSync: false, loadRisk: 'normal', recommendedHandling: 'repair_contract',
    summary: '任务单缺失本章职责', issues: [], repairGuidance: [], confidence: 0.9,
  };
  await assert.rejects(
    f.service.ensureChapterExecutionContract('n', 'c4', f.baseOptions),
    (error) => error.name === 'ChapterTaskSheetQualityGateError',
  );
  assert.equal(f.state.generated.length, 0);
});

test('copilot mode requires confirmation instead of silently regenerating', async (t) => {
  const f = fixture(t);
  f.state.assessment = {
    verdict: 'repairable', safeToSync: false, loadRisk: 'normal', recommendedHandling: 'repair_contract',
    summary: '前文已到邮局', issues: [], repairGuidance: [], confidence: 0.9,
  };
  await assert.rejects(
    f.service.ensureChapterExecutionContract('n', 'c4', {
      ...f.baseOptions,
      chapterTaskSheetQualityMode: 'ai_copilot',
      entrypoint: 'manual',
    }),
    (error) => error.name === 'ChapterTaskSheetQualityGateError',
  );
  assert.equal(f.state.generated.length, 0);
});

test('use_as_is reuses the contract and kill-switch restores the legacy fast path', async (t) => {
  const f = fixture(t);
  const reused = await f.service.ensureChapterExecutionContract('n', 'c4', f.baseOptions);
  assert.equal(f.state.generated.length, 0);
  assert.equal(f.state.reviewCalls.length, 1);
  assert.ok(reused.taskSheet.includes('邮戳编号'));

  const previousEnv = process.env.CHAPTER_EXECUTION_CONTINUITY_REVIEW;
  try {
    process.env.CHAPTER_EXECUTION_CONTINUITY_REVIEW = '0';
    f.state.reviewCalls.length = 0;
    const legacy = await f.service.ensureChapterExecutionContract('n', 'c4', f.baseOptions);
    assert.equal(f.state.reviewCalls.length, 0, 'kill-switch skips the review entirely');
    assert.ok(legacy.taskSheet.includes('邮戳编号'));
  } finally {
    if (previousEnv === undefined) delete process.env.CHAPTER_EXECUTION_CONTINUITY_REVIEW;
    else process.env.CHAPTER_EXECUTION_CONTINUITY_REVIEW = previousEnv;
  }
});
