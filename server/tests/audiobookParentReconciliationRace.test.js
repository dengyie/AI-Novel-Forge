const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prisma } = require("../dist/db/prisma.js");
const { AudiobookTaskService } = require("../dist/services/audiobook/AudiobookTaskService.js");
const { buildWavBuffer } = require("../dist/services/audiobook/audiobookWav.js");
const { ensureChapterAudioDir, resolveChapterAudioPath } = require("../dist/services/audiobook/audiobookPaths.js");

function fixture(t, { allReady = false, beforeWrite = () => {} } = {}) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-parent-cas-"));
  const parent = {
    id: "parent", novelId: "novel", title: "CAS regression", status: "running",
    currentStage: "continuing", progress: 2, cancelRequestedAt: null,
    chapterIdsJson: JSON.stringify(["chapter-1", "chapter-2"]),
    m4bGenerationToken: "parent-A", resultJson: null, fullAudioPath: null,
    progressJson: JSON.stringify({ failedContinueChapters: ["chapter-1"] }),
    outputDir: taskDir,
  };
  const child = {
    id: "child", novelId: "novel", status: "failed", m4bGenerationToken: "child-A",
    chapterIdsJson: JSON.stringify(["chapter-2"]),
    progressJson: JSON.stringify({ parentTaskId: "parent", parentGenerationToken: "parent-A" }),
  };
  if (allReady) {
    const wav = buildWavBuffer(Buffer.alloc(800), { numChannels: 1, sampleRate: 16000, bitsPerSample: 16 });
    for (const chapterId of ["chapter-1", "chapter-2"]) {
      ensureChapterAudioDir(taskDir, chapterId);
      fs.writeFileSync(resolveChapterAudioPath(taskDir, chapterId), wav);
    }
  }
  const originals = { findUnique: prisma.audiobookTask.findUnique, updateMany: prisma.audiobookTask.updateMany };
  let writes = 0;
  prisma.audiobookTask.findUnique = async ({ where }) => {
    const row = where.id === child.id ? child : parent;
    return { ...row };
  };
  prisma.audiobookTask.updateMany = async ({ where, data }) => {
    beforeWrite(parent, ++writes, data);
    const matches = Object.entries(where).every(([key, expected]) => {
      if (expected === undefined) return true;
      if (expected?.in) return expected.in.includes(parent[key]);
      if (expected?.not) return parent[key] !== expected.not;
      return parent[key] === expected;
    });
    if (!matches) return { count: 0 };
    Object.assign(parent, data);
    return { count: 1 };
  };
  const service = new AudiobookTaskService();
  const encodes = [];
  service.scheduleBackgroundM4bEncode = async (input) => { encodes.push(input); };
  t.after(() => {
    prisma.audiobookTask.findUnique = originals.findUnique;
    prisma.audiobookTask.updateMany = originals.updateMany;
    fs.rmSync(taskDir, { recursive: true, force: true });
  });
  return { parent, child, service, encodes, writes: () => writes };
}

test("failed reconciliation retries a same-generation progress conflict and leaves continuing", { concurrency: false }, async (t) => {
  const f = fixture(t, { beforeWrite: (row, attempt) => {
    if (attempt === 1) row.progressJson = JSON.stringify({
      failedContinueChapters: ["chapter-1", "chapter-2"], retainedMetadata: "latest",
    });
  } });
  await f.service.reconcileParent(f.parent.id);
  assert.equal(f.parent.status, "failed", "a CAS conflict must not strand the parent in continuing");
  assert.deepEqual(JSON.parse(f.parent.progressJson).failedContinueChapters, ["chapter-1", "chapter-2"]);
  assert.equal(JSON.parse(f.parent.progressJson).retainedMetadata, "latest");
  assert.equal(f.writes(), 2);
});

test("successful reconciliation preserves concurrent metadata and starts one encoder", { concurrency: false }, async (t) => {
  const f = fixture(t, { allReady: true, beforeWrite: (row, attempt) => {
    if (attempt === 1) row.progressJson = JSON.stringify({ retainedMetadata: "latest" });
  } });
  await f.service.reconcileParent(f.parent.id);
  assert.equal(f.parent.status, "succeeded");
  assert.equal(JSON.parse(f.parent.progressJson).retainedMetadata, "latest");
  assert.equal(f.encodes.length, 1);
  assert.equal(f.writes(), 2);
});

test("reconciliation never retries into a replacement parent generation", { concurrency: false }, async (t) => {
  const f = fixture(t, { beforeWrite: (row) => {
    row.m4bGenerationToken = "parent-B";
    row.progressJson = JSON.stringify({ retainedMetadata: "replacement" });
  } });
  await f.service.reconcileParent(f.parent.id);
  assert.equal(f.parent.status, "running");
  assert.equal(f.parent.m4bGenerationToken, "parent-B");
  assert.equal(f.writes(), 1);
});

test("cancel requested during reconciliation cannot be overwritten by a terminal projection", { concurrency: false }, async (t) => {
  const f = fixture(t, { beforeWrite: (row) => { row.cancelRequestedAt = new Date(); } });
  await f.service.reconcileParent(f.parent.id);
  assert.equal(f.parent.status, "running");
  assert.ok(f.parent.cancelRequestedAt);
});

test("a late child callback cannot add failures or settle a replacement parent", { concurrency: false }, async (t) => {
  const f = fixture(t);
  f.parent.m4bGenerationToken = "parent-B";
  const originalProgress = f.parent.progressJson;
  await f.service.finalizeContinueChild(f.child.id, true, "child-A");
  assert.equal(f.parent.status, "running");
  assert.equal(f.parent.progressJson, originalProgress);
  assert.equal(f.writes(), 0);
});

test("exhausted progress contention is reported instead of silently leaving continuing", { concurrency: false }, async (t) => {
  const f = fixture(t, { beforeWrite: (row, attempt) => {
    row.progressJson = JSON.stringify({ retainedMetadata: attempt });
  } });
  await assert.rejects(f.service.reconcileParent(f.parent.id), /CAS/);
  assert.equal(f.parent.status, "running");
  assert.equal(f.writes(), 5);
});

test("current child failure records missing chapters and settles its parent", { concurrency: false }, async (t) => {
  const f = fixture(t);
  await f.service.finalizeContinueChild(f.child.id, true, "child-A");
  assert.equal(f.parent.status, "failed");
  assert.deepEqual(JSON.parse(f.parent.progressJson).failedContinueChapters, ["chapter-1", "chapter-2"]);
});

test("parent rotation while appending child failures is fenced on every retry", { concurrency: false }, async (t) => {
  const f = fixture(t, { beforeWrite: (row, attempt) => {
    if (attempt === 1) {
      row.m4bGenerationToken = "parent-B";
      row.progressJson = JSON.stringify({ retainedMetadata: "new generation" });
    }
  } });
  await f.service.finalizeContinueChild(f.child.id, true, "child-A");
  assert.equal(f.parent.status, "running");
  assert.equal(JSON.parse(f.parent.progressJson).retainedMetadata, "new generation");
  assert.equal(JSON.parse(f.parent.progressJson).failedContinueChapters, undefined);
  assert.equal(f.writes(), 1);
});

test("fallback after a reconcile exception cannot settle a replacement parent", { concurrency: false }, async (t) => {
  const f = fixture(t);
  f.service.reconcileParent = async () => {
    f.parent.m4bGenerationToken = "parent-B";
    throw new Error("projection unavailable");
  };
  await f.service.finalizeContinueChild(f.child.id, false, "child-A");
  assert.equal(f.parent.status, "running");
  assert.equal(f.writes(), 0);
});
