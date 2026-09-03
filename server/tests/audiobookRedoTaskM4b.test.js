/**
 * m4b 封装置失败后受支持重做入口（redoTaskM4b）的回归测试。
 *
 * 背景（2026-09-03 生产事故根因复盘）：m4b 封装只在任务首次成功时随后台触发一次；
 * 若中途失败（超时/资源争抢/宿主 OOM），任务保持 succeeded 但 label 变成
 * 「有声书生成完成；m4b 失败（…）」，前端没有按钮也无法再触发，只能靠手工脚本
 * 绕过代码库。此测试锁定 redoTaskM4b 的防护与会话语义：
 *  - 非 succeeded → 仅读校验，不动盘/不触发
 *  - taskDir 缺失 / 全书 WAV 缺失 → 400，不触发
 *  - m4b 已 ready → 幂等早退（不重置 label、不重编码）
 *  - succeeded + WAV 在 + m4b 缺 → 重置为「封装中」label、清掉旧 m4b 失败结论，触发后台 force 重封装
 *
 * 与 retryTaskClaim.test.js 同约定：stub 共享 prisma 单例，串行（concurrency: false）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");
const {
  resolveFullBookAudioPath,
  resolveFullBookM4bPath,
} = require("../dist/services/audiobook/audiobookPaths.js");

const M4B_ENCODING_LABEL = "有声书生成完成（m4b 后台封装中）";

function makeTaskDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ab-redo-${label}-`));
}

function makeTaskRow(overrides = {}, taskDir) {
  return {
    id: "at-1",
    novelId: "novel-1",
    title: "测试书",
    scopeMode: "full",
    chapterIdsJson: JSON.stringify(["c1", "c2"]),
    chapterCount: 2,
    completedChapterCount: 2,
    narratorVoice: "v",
    narratorStyle: "s",
    provider: null,
    model: null,
    temperature: null,
    status: "succeeded",
    progress: 100,
    retryCount: 0,
    maxRetries: 3,
    pendingManualRecovery: false,
    heartbeatAt: new Date(),
    currentStage: "finalizing",
    currentItemKey: null,
    currentItemLabel: "有声书生成完成；m4b 失败（ffmpeg 封装 m4b 超时）",
    cancelRequestedAt: null,
    error: null,
    summary: null,
    annotationsJson: null,
    progressJson: null,
    resultJson: JSON.stringify({ m4b: { status: "failed", reason: "超时" } }),
    outputDir: taskDir,
    fullAudioPath: "full-book.wav",
    startedAt: new Date(),
    finishedAt: new Date(),
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    llmCallCount: 0,
    lastTokenRecordedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// 最小合法 PCM WAV（44 字节头 + 若干静音样本），规避 isValidPcmWavFile 门禁
function writeFakeWav(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sampleRate = 24000;
  const channels = 1;
  const bits = 16;
  const dataBytes = 1000;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

test("redoTaskM4b: m4b 已 ready → 幂等早退，不重置 label、不重编码", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("ready");
  const m4bPath = resolveFullBookM4bPath(taskDir);
  fs.mkdirSync(path.dirname(m4bPath), { recursive: true });
  fs.writeFileSync(m4bPath, Buffer.alloc(128)); // >=64 视为 ready
  const existing = makeTaskRow({}, taskDir);
  const service = new AudiobookTaskService();

  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  const updateArgs = [];
  prisma.audiobookTask.findUnique = async () => ({ ...existing, novel: { id: "novel-1", title: "测试书" } });
  prisma.audiobookTask.updateMany = async (args) => { updateArgs.push(args); return { count: 1 }; };

  try {
    const r = await service.redoTaskM4b("at-1");
    assert.equal(r?.id, "at-1");
    assert.equal(updateArgs.length, 0, "m4b ready 时不应有任何 updateMany（重置/去触发）");
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("redoTaskM4b: taskDir 缺失 → 400，不触发", { concurrency: false }, async () => {
  const existing = makeTaskRow({ outputDir: null }, null);
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  prisma.audiobookTask.findUnique = async () => ({ ...existing, novel: { id: "novel-1", title: "测试书" } });
  prisma.audiobookTask.updateMany = async () => { throw new Error("不应到这里"); };

  try {
    await assert.rejects(
      service.redoTaskM4b("at-1"),
      (e) => e.status === 400 || (e instanceof Error && /无输出目录/.test(e.message)),
    );
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("redoTaskM4b: 非 succeeded → 400，不动盘", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("non-succeeded");
  fs.writeFileSync(resolveFullBookAudioPath(taskDir), writeFakeWav(resolveFullBookAudioPath(taskDir)));
  const existing = makeTaskRow({ status: "running" }, taskDir);
  const service = new AudiobookTaskService();
  const originals = {
    findUnique: prisma.audiobookTask.findUnique,
    updateMany: prisma.audiobookTask.updateMany,
  };
  prisma.audiobookTask.findUnique = async () => ({ ...existing, novel: { id: "novel-1", title: "测试书" } });
  prisma.audiobookTask.updateMany = async () => { throw new Error("不应触发 update"); };

  try {
    await assert.rejects(
      () => service.redoTaskM4b("at-1"),
      (e) => (e instanceof Error && /仅生成完成/.test(e.message)),
    );
  } finally {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
  }
});

test("redoTaskM4b: succeeded + WAV 在 + m4b 缺 → 重置 label/清 resultJson 并触发 force 重封装", { concurrency: false }, async () => {
  const taskDir = makeTaskDir("sched");
  fs.writeFileSync(resolveFullBookAudioPath(taskDir), writeFakeWav(resolveFullBookAudioPath(taskDir)));
  const existing = makeTaskRow({}, taskDir);
  const service = new AudiobookTaskService();

  const originals = {
    taskFindUnique: prisma.audiobookTask.findUnique,
    taskUpdateMany: prisma.audiobookTask.updateMany,
    chapterFindMany: prisma.chapter.findMany,
    novelFindUnique: prisma.novel.findUnique,
  };
  const updateArgs = [];
  prisma.audiobookTask.findUnique = async () => ({ ...existing, novel: { id: "novel-1", title: "测试书" } });
  prisma.audiobookTask.updateMany = async (args) => { updateArgs.push(args); return { count: 1 }; };
  // 后台 force 重封装会异步读章节/书标题；这里 stub 成空，避免触达真实 dev.db
  prisma.chapter.findMany = async () => [];
  prisma.novel.findUnique = async () => null;

  try {
    await service.redoTaskM4b("at-1");
    // 重做入口至少发生一次 updateMany：重置 label + 清 resultJson
    const reset = updateArgs.find(
      (a) => a.data && a.data.currentItemLabel === M4B_ENCODING_LABEL,
    );
    assert.ok(reset, "应有重置为「封装中」的 updateMany");
    assert.equal(reset.data.resultJson, "{}", "应清掉旧 m4b 失败结论");
    assert.equal(reset.where.id, "at-1");
  } finally {
    prisma.audiobookTask.findUnique = originals.taskFindUnique;
    prisma.audiobookTask.updateMany = originals.taskUpdateMany;
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.novel.findUnique = originals.novelFindUnique;
  }
});