const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isChapterAudioReady,
  isFullBookAudioReady,
  listReadyChapterAudioIds,
  pruneChunkWavArtifacts,
  resolveChapterAudioDir,
  resolveChapterAudioPath,
  resolveChunkAudioPath,
  resolveFullBookAudioPath,
  wipeChapterAudioArtifacts,
} = require("../dist/services/audiobook/audiobookPaths.js");

function writeTinyWav(filePath) {
  // 最小合法 RIFF 头 + 2 字节 PCM
  const buf = Buffer.alloc(46);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(38, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(2, 40);
  buf.writeUInt16LE(0, 44);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

test("listReadyChapterAudioIds / pruneChunkWavArtifacts keep chapter+full wav", () => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiobook-delivery-"));
  try {
    const chapterIds = ["chA", "chB"];
    for (const chapterId of chapterIds) {
      fs.mkdirSync(resolveChapterAudioDir(taskDir, chapterId), { recursive: true });
      writeTinyWav(resolveChunkAudioPath(taskDir, chapterId, 0));
      writeTinyWav(resolveChunkAudioPath(taskDir, chapterId, 1));
      writeTinyWav(resolveChapterAudioPath(taskDir, chapterId));
    }
    writeTinyWav(resolveFullBookAudioPath(taskDir));

    assert.equal(isChapterAudioReady(taskDir, "chA"), true);
    assert.deepEqual(listReadyChapterAudioIds(taskDir, chapterIds), ["chA", "chB"]);
    assert.equal(isFullBookAudioReady(taskDir), true);

    const removed = pruneChunkWavArtifacts(taskDir, chapterIds);
    assert.ok(removed >= 4, `expected prune >=4 chunk files, got ${removed}`);
    assert.equal(fs.existsSync(resolveChunkAudioPath(taskDir, "chA", 0)), false);
    assert.equal(fs.existsSync(resolveChapterAudioPath(taskDir, "chA")), true);
    assert.equal(fs.existsSync(resolveFullBookAudioPath(taskDir)), true);
    assert.deepEqual(listReadyChapterAudioIds(taskDir, chapterIds), ["chA", "chB"]);

    wipeChapterAudioArtifacts(taskDir, "chA");
    assert.equal(isChapterAudioReady(taskDir, "chA"), false);
    assert.equal(isFullBookAudioReady(taskDir), false);
    assert.deepEqual(listReadyChapterAudioIds(taskDir, chapterIds), ["chB"]);
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test("AudiobookTaskSummary progressive delivery fields exist on type surface", () => {
  /** @type {import('../../shared/dist/types/audiobook.js').AudiobookTaskSummary} */
  const sample = {
    id: "t1",
    novelId: "n1",
    novelTitle: "源世界",
    title: "有声书",
    status: "running",
    progress: 40,
    scopeMode: "range",
    attemptCount: 0,
    maxAttempts: 1,
    chapterCount: 3,
    completedChapterCount: 1,
    readyChapterIds: ["c1"],
    fullAudioReady: false,
    m4bStatus: null,
    chunksPruned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.equal(sample.readyChapterIds.length, 1);
  assert.equal(sample.fullAudioReady, false);
  assert.equal(sample.chunksPruned, false);
});
