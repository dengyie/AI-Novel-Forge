const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../dist/db/prisma.js');
const { ChapterTaskSheetQualityGateService } = require('../dist/services/novel/volume/ChapterTaskSheetQualityGateService.js');
const { reviewChapterExecutionContinuity } = require('../dist/services/novel/volume/chapterExecutionContinuity.js');

// 移植自上游 2026-10-17 executionContinuityReview.test.js（按本仓形态适配）：
// 形状就绪的已有合同在进入写作前做一次前文语义核对；相同有效输入复用结果；
// AI 冲突指导送回现有生成链；前文在核对期间变化不得授权过期复用。

function fixture(t) {
  const originals = [
    ChapterTaskSheetQualityGateService.prototype.evaluate,
    prisma.chapterArtifactSyncCheckpoint.findUnique,
    prisma.chapterArtifactSyncCheckpoint.upsert,
  ];
  const rows = new Map();
  const calls = [];
  const previous = {
    order: 3,
    title: '信纸多出一行',
    content: '林砚把自己手抄的纸翻过来，背面有了周德海的名字。两人离开钟表铺，向邮局走去。',
  };
  const candidate = {
    novelId: 'n', volumeId: 'v', chapterId: 'c4', chapterOrder: 4,
    title: '工牌对上了', summary: '核对工牌', purpose: '比对信件旧校名',
    exclusiveEvent: '发现父亲真实履历', endingState: '获得邮戳编号',
    nextChapterEntryState: '查找分拣口', conflictLevel: 3, revealLevel: 2,
    targetWordCount: 3000, mustAvoid: '不得提前揭晓秘密', payoffRefs: [],
    taskSheet: '苏晚离开钟表铺时，林砚发现邮戳编号。',
    sceneCards: '场景一：邮局前台核对工牌；场景二：发现信件异常并收尾。',
    previousChapterResult: {
      chapterOrder: previous.order, title: previous.title, content: previous.content,
    },
  };
  const state = {
    assessment: {
      verdict: 'usable', safeToSync: true, loadRisk: 'normal', recommendedHandling: 'use_as_is',
      summary: '可以承接', issues: [], repairGuidance: [], confidence: 0.9,
    },
    sourceChangesDuringReview: false,
  };
  ChapterTaskSheetQualityGateService.prototype.evaluate = async (input, options) => {
    calls.push(input);
    if (state.sourceChangesDuringReview) previous.content += '父亲出现了。';
    await options.onEvaluated({ assessment: state.assessment });
    return { status: 'passed', canEnterExecution: true, issues: [], summary: state.assessment.summary, repairGuidance: [], confidence: 0.9 };
  };
  const key = (input) => JSON.stringify(input.where);
  prisma.chapterArtifactSyncCheckpoint.findUnique = async (input) => rows.get(key(input)) ?? null;
  prisma.chapterArtifactSyncCheckpoint.upsert = async (input) => { rows.set(key(input), input.create); return input.create; };
  t.after(() => {
    [
      ChapterTaskSheetQualityGateService.prototype.evaluate,
      prisma.chapterArtifactSyncCheckpoint.findUnique,
      prisma.chapterArtifactSyncCheckpoint.upsert,
    ] = originals;
  });
  const options = { provider: 'deepseek', model: 'offline-model', mode: 'full_book_autopilot' };
  return { candidate, previous, state, calls, rows, options };
}

test('shape-ready plans are checked against saved prose once and reused only with identical effective inputs', async (t) => {
  const f = fixture(t);
  const first = await reviewChapterExecutionContinuity(f.candidate, f.options);
  const second = await reviewChapterExecutionContinuity(f.candidate, f.options);
  assert.equal(f.calls.length, 1, 'identical effective inputs reuse the cached review');
  assert.equal(first.result.status, 'passed');
  assert.equal(second.result.status, 'passed');
  f.previous.content += '手抄件仍在内袋里。';
  f.candidate.previousChapterResult.content = f.previous.content;
  await reviewChapterExecutionContinuity(f.candidate, f.options);
  assert.equal(f.calls.length, 2, 'changed previous prose invalidates the cached identity');
});

test('AI continuity conflicts surface structured guidance for the existing contract chain', async (t) => {
  const f = fixture(t);
  f.state.assessment = {
    ...f.state.assessment, verdict: 'repairable', safeToSync: false, recommendedHandling: 'repair_contract',
    summary: '前文已到邮局，不能无故回到钟表铺',
    repairGuidance: ['把编号发现移至邮局，并保留手抄件和已有字迹'],
  };
  const checked = await reviewChapterExecutionContinuity(f.candidate, f.options);
  assert.ok(checked);
  assert.equal(checked.assessment.recommendedHandling, 'repair_contract');
  assert.ok(checked.result.repairGuidance.join('\n').includes('移至邮局') || checked.assessment.repairGuidance.join('').includes('移至邮局'));
});

test('missing prose and aborted requests cannot trigger a semantic check', async (t) => {
  const f = fixture(t);
  assert.equal(await reviewChapterExecutionContinuity(
    { ...f.candidate, previousChapterResult: { ...f.candidate.previousChapterResult, content: '   ' } },
    f.options,
  ), null);
  const controller = new AbortController();
  controller.abort(new Error('offline cancelled'));
  await assert.rejects(
    reviewChapterExecutionContinuity(f.candidate, { ...f.options, signal: controller.signal }),
    /offline cancelled/,
  );
  assert.equal(f.calls.length, 0);
});

test('without an explicit model identity the review still runs but never caches', async (t) => {
  const f = fixture(t);
  await reviewChapterExecutionContinuity(f.candidate, { mode: 'ai_copilot' });
  await reviewChapterExecutionContinuity(f.candidate, { mode: 'ai_copilot' });
  assert.equal(f.calls.length, 2, 'no model identity means no reuse');
  assert.equal(f.rows.size, 0);
});
