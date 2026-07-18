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
  // 确保重新加载 pipeline 后再 patch
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
