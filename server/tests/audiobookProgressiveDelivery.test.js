const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// 逐章交付：每章「标注 → 合成 → chapter.wav 落盘」必须严格按章顺序，
// 第 1 章合成落盘时第 2 章尚未开始合成。
// 通过 monkey-patch 模块单例（mimoChatAudioTTSProvider.synthesize、
// audiobookAnnotationService.annotateChapter）注入假数据，不打真 TTS / LLM。

const mimoProviderPath = path.resolve(__dirname, "../dist/services/audiobook/MimoChatAudioTTSProvider.js");
const annotationServicePath = path.resolve(__dirname, "../dist/services/audiobook/AudiobookAnnotationService.js");
const pipelinePath = path.resolve(__dirname, "../dist/services/audiobook/AudiobookPipelineService.js");
const wavHelpersPath = path.resolve(__dirname, "../dist/services/audiobook/audiobookWav.js");
const pathsHelpersPath = path.resolve(__dirname, "../dist/services/audiobook/audiobookPaths.js");
const prismaPath = path.resolve(__dirname, "../dist/db/prisma.js");

// 合法 PCM WAV 字节（用于 TTS 假返回 + 校验落盘）
const { buildWavBuffer, createSilentPcm } = require(wavHelpersPath);
const {
  resolveAudiobookTaskDir,
  resolveChapterAudioPath,
  listReadyChapterAudioIds,
} = require(pathsHelpersPath);

function tinyWavBase64() {
  const pcm = createSilentPcm(50, 24_000, 1);
  const buf = buildWavBuffer(pcm, { numChannels: 1, sampleRate: 24_000, bitsPerSample: 16 });
  return Buffer.from(buf).toString("base64");
}

function makeDefer() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

let synthCount = 0;
function patchMimoProvider() {
  const mod = require.cache[mimoProviderPath];
  if (!mod) {
    throw new Error("MimoChatAudioTTSProvider not in require.cache; build first");
  }
  const instance = mod.exports.mimoChatAudioTTSProvider;
  instance.synthesize = async () => {
    synthCount += 1;
    return { audioBase64: tinyWavBase64() };
  };
}

let annotateCallLog = [];
function patchAnnotationService() {
  const mod = require.cache[annotationServicePath];
  if (!mod) {
    throw new Error("AudiobookAnnotationService not in require.cache");
  }
  const svc = mod.exports.audiobookAnnotationService;
  svc.annotateChapter = async (input) => {
    annotateCallLog.push(input.chapterId);
    return {
      chapterId: input.chapterId,
      chapterOrder: input.chapterOrder,
      chapterTitle: input.chapterTitle,
      deliveryStyleMode: "off",
      contentSha1: "sha-fake-" + input.chapterId,
      segments: [
        {
          index: 0,
          speakerKind: "narrator",
          speakerLabel: "旁白",
          text: `第 ${input.chapterOrder} 章旁白。`,
          ttsMode: "preset",
          voice: input.narrator?.voice || "茉莉",
          style: input.narrator?.style || "旁白",
        },
      ],
      error: null,
    };
  };
}

function patchPrisma(fakeChapters, annotationsJsonOverride) {
  const mod = require.cache[prismaPath];
  if (!mod) {
    throw new Error("prisma not in require.cache");
  }
  const prisma = mod.exports.prisma;
  const origChapter = prisma.chapter;
  const origTask = prisma.audiobookTask;
  prisma.chapter = {
    findMany: async ({ where, select }) => fakeChapters
      .filter((c) => where?.novelId === undefined || c.novelId === where.novelId)
      .filter((c) => !where?.id?.in || where.id.in.includes(c.id))
      .map((c) => Object.fromEntries(
        Object.entries(c).filter(([k]) => select ? Object.keys(select).includes(k) : true),
      )),
  };
  prisma.audiobookTask = {
    findUnique: async () => ({ annotationsJson: annotationsJsonOverride ?? null }),
  };
  return () => {
    prisma.chapter = origChapter;
    prisma.audiobookTask = origTask;
  };
}

function patchTaskDirPaths(tmpRoot) {
  const pathsMod = require.cache[pathsHelpersPath].exports;
  const origResolve = pathsMod.resolveAudiobookTaskDir;
  const origEnsure = pathsMod.ensureAudiobookTaskDir;
  pathsMod.resolveAudiobookTaskDir = (nId, tId) => path.join(tmpRoot, nId, tId);
  pathsMod.ensureAudiobookTaskDir = (nId, tId) => {
    const dir = path.join(tmpRoot, nId, tId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return () => {
    pathsMod.resolveAudiobookTaskDir = origResolve;
    pathsMod.ensureAudiobookTaskDir = origEnsure;
  };
}


function buildChapters(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ch${i + 1}`,
    order: i + 1,
    title: `第${i + 1}章`,
    content: `第 ${i + 1} 章正文。`,
  }));
}

function buildProgressSink(gate, reached, chapterIdGate) {
  // 在「某章 phase=synthesizing 且 message=第 N 章完成」那一刻阻塞 onProgress，
  // 此时外部可在阻塞期间断言 chapter.wav 是否已落盘 + 后续章是否尚未开始。
  return async (progress) => {
    if (
      progress.phase === "synthesizing"
      && /第 \d+ 章完成/.test(progress.message)
      && progress.chapterId === chapterIdGate
      && gate
    ) {
      if (reached) reached.resolve();
      await gate.promise;
    }
  };
}

test("逐章交付：第 1 章合成完落盘时第 2 章尚未开始合成", async () => {
  delete require.cache[pipelinePath];
  require(pipelinePath);
  patchMimoProvider();
  patchAnnotationService();

  const { AudiobookPipelineService } = require(pipelinePath);
  const pipeline = new AudiobookPipelineService();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-prog-"));
  const novelId = "novel-prog-test";
  const taskId = "task-prog-1";
  const restorePaths = patchTaskDirPaths(tmpRoot);
  const fakeChaptersWithNovel = buildChapters(3).map((c) => ({ ...c, novelId }));
  const restorePrisma = patchPrisma(fakeChaptersWithNovel, null);

  try {
    const chapters = buildChapters(3);
    const chapterIds = chapters.map((c) => c.id);

    // 阻塞点：第 1 章「完成」emit 时，外部在阻塞期间断言 ch1 ready / ch2 未合成
    const gate = makeDefer();
    const reached = makeDefer();
    const sink = buildProgressSink(gate, reached, "ch1");

    const runPromise = pipeline.run({
      taskId,
      novelId,
      chapterIds,
      narrator: { voice: "茉莉", style: "知性旁白" },
      characterVoices: [],
      deliveryStyleMode: "off",
      isCancelRequested: async () => false,
      onProgress: sink,
    });

    // 先等 pipeline 真正跑到第 1 章「完成」emit（阻塞入队点），再断言落盘时机
    await reached.promise;

    // 阻塞期间断言落盘时机
    const readyAtGate = listReadyChapterAudioIds(
      path.join(tmpRoot, novelId, taskId),
      chapterIds,
    );
    const ch2Wav = resolveChapterAudioPath(path.join(tmpRoot, novelId, taskId), "ch2");
    assert.deepEqual(
      readyAtGate,
      ["ch1"],
      "第 1 章完成 emit 时：readyChapterIds 应只含 ch1",
    );
    assert.equal(
      fs.existsSync(ch2Wav),
      false,
      "第 1 章完成 emit 时：ch2 chapter.wav 不应存在",
    );

    // 放行
    gate.resolve();

    const result = await runPromise;
    assert.equal(result.completedChapterCount, 3);
    const finalReady = listReadyChapterAudioIds(
      path.join(tmpRoot, novelId, taskId),
      chapterIds,
    );
    assert.deepEqual(finalReady, ["ch1", "ch2", "ch3"]);

    // 逐章顺序的硬证据：annotateCallLog 必须严格 [ch1, ch2, ch3]
    assert.deepEqual(annotateCallLog, ["ch1", "ch2", "ch3"]);

    // 合成发生次数：每章 1 chunk × 3 = 3 次合成调用（TTS 真发）
    assert.equal(synthCount, 3, "逐章交付下每章应合成 1 chunk");
  } finally {
    restorePrisma();
    restorePaths();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("逐章进度列表：chapterProgress 随 chunk 推进、终态全 ready、磁盘 reconcile 为真", async () => {
  delete require.cache[pipelinePath];
  require(pipelinePath);
  patchMimoProvider();
  patchAnnotationService();

  const { AudiobookPipelineService } = require(pipelinePath);
  const pipeline = new AudiobookPipelineService();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-prog2-"));
  const novelId = "novel-prog-test2";
  const taskId = "task-prog-2";
  const restorePaths = patchTaskDirPaths(tmpRoot);
  const fakeChaptersWithNovel = buildChapters(2).map((c) => ({ ...c, novelId }));
  const restorePrisma = patchPrisma(fakeChaptersWithNovel, null);

  const emits = [];
  try {
    const chapters = buildChapters(2);
    const chapterIds = chapters.map((c) => c.id);

    const runPromise = pipeline.run({
      taskId,
      novelId,
      chapterIds,
      narrator: { voice: "茉莉", style: "知性旁白" },
      characterVoices: [],
      deliveryStyleMode: "off",
      isCancelRequested: async () => false,
      onProgress: async (progress) => {
        emits.push(progress);
      },
    });
    await runPromise;

    // 1) ch1 合成中 emit：chapterProgress[0].status=synthesizing、completedChunks=0、totalChunks=1
    //    （每章 mock 返回 1 段 → 1 chunk；i=0 时已合成完成前那只 emit）
    const ch1Synth = emits.find(
      (e) => e.chapterId === "ch1" && e.phase === "synthesizing" && /合成第 1 章 chunk 1\/1/.test(e.message),
    );
    assert.ok(ch1Synth, "应捕获 ch1 chunk 合成 emit");
    assert.ok(Array.isArray(ch1Synth.chapterProgress), "合成 emit 必须带 chapterProgress 数组");
    assert.equal(ch1Synth.chapterProgress[0].chapterId, "ch1");
    assert.equal(ch1Synth.chapterProgress[0].status, "synthesizing");
    assert.equal(ch1Synth.chapterProgress[0].completedChunks, 0);
    assert.equal(ch1Synth.chapterProgress[0].totalChunks, 1);
    assert.equal(ch1Synth.chapterProgress[1].status, "pending", "ch2 此时尚未开始");

    // 2) ch1 完成后 ch2 开始前：终态所有章 status=ready
    const finalEmit = emits[emits.length - 1];
    assert.ok(finalEmit.chapterProgress.every((e) => e.status === "ready"),
      `终态全章应 ready，实际：${JSON.stringify(finalEmit.chapterProgress.map((e) => e.status))}`);
    assert.equal(finalEmit.chapterProgress.length, 2);
    assert.equal(finalEmit.chapterProgress[0].completedChunks, 1);
    assert.equal(finalEmit.chapterProgress[0].totalChunks, 1);

    // 3) 磁盘是真理：删 ch1 chapter.wav 后 deriveChapterProgress 不再强制其 ready
    const { deriveChapterProgress } = require(
      "../dist/services/audiobook/AudiobookTaskService.js",
    );
    const progressJsonSnapshot = JSON.stringify({
      deliveryStyleMode: "off",
      chapterProgress: finalEmit.chapterProgress,
    });
    // ch1 在盘 → 强制 ready
    const beforeDelete = deriveChapterProgress(progressJsonSnapshot, chapterIds, ["ch1", "ch2"]);
    assert.equal(beforeDelete[0].status, "ready");
    // 删 ch1 chapter.wav（listReadyChapterAudioIds 会拒识）→ 该章不被强制 ready，维持原数组值
    const ch1Wav = resolveChapterAudioPath(path.join(tmpRoot, novelId, taskId), "ch1");
    fs.unlinkSync(ch1Wav);
    const afterDelete = deriveChapterProgress(progressJsonSnapshot, chapterIds, ["ch2"]);
    assert.notEqual(afterDelete[0].status, "ready",
      `删 ch1 wav 后该章不应显示 ready，实际：${afterDelete[0].status}`);
    assert.equal(afterDelete[1].status, "ready", "ch2 在盘仍 ready");
  } finally {
    restorePrisma();
    restorePaths();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
