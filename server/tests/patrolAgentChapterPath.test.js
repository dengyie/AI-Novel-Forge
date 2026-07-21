/**
 * PatrolAgent P3 路径契约：章 wav 必须落在 {taskDir}/chapters/{cid}/chapter.wav。
 * 根因：早期 path.join(taskDir, cid, "chapter.wav") 漏 chapters/，生产 E2E 出现 13 假阳性。
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "patrol-chapter-path-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;
process.env.AI_NOVEL_DB_ENGINE = "memory";

const {
  resolvePatrolChapterWav,
} = require("../dist/services/audiobook/ops/agents/PatrolAgent");
const {
  resolveChapterAudioPath,
  resolveAudiobookTaskDir,
  ensureChapterAudioDir,
} = require("../dist/services/audiobook/audiobookPaths");

describe("PatrolAgent P3 chapter.wav path contract", () => {
  it("resolvePatrolChapterWav === resolveChapterAudioPath（含 chapters/ 中间层）", () => {
    const taskDir = path.join(TMP_ROOT, "tasks", "novel-1", "task-1");
    const chapterId = "ch-42";
    const fromPatrol = resolvePatrolChapterWav(taskDir, chapterId);
    const fromPaths = resolveChapterAudioPath(taskDir, chapterId);
    assert.equal(fromPatrol, fromPaths);
    assert.ok(
      fromPatrol.includes(`${path.sep}chapters${path.sep}${chapterId}${path.sep}chapter.wav`),
      `expected chapters/ middle layer, got: ${fromPatrol}`,
    );
    // 旧错误形态不得再出现
    const legacyWrong = path.join(taskDir, chapterId, "chapter.wav");
    assert.notEqual(fromPatrol, legacyWrong);
  });

  it("权威路径存在时，不得把 chapters/ 下的真文件判为缺失", () => {
    const novelId = "n-path-contract";
    const taskId = "t-path-contract";
    const chapterId = "cid-ready";
    const taskDir = resolveAudiobookTaskDir(novelId, taskId);
    ensureChapterAudioDir(taskDir, chapterId);
    const wav = resolveChapterAudioPath(taskDir, chapterId);
    fs.writeFileSync(wav, Buffer.alloc(44)); // tiny placeholder
    assert.equal(fs.existsSync(wav), true);

    const patrolPath = resolvePatrolChapterWav(taskDir, chapterId);
    assert.equal(fs.existsSync(patrolPath), true, "Patrol 必须看见权威 chapters/ 路径上的文件");
    assert.equal(fs.existsSync(path.join(taskDir, chapterId, "chapter.wav")), false, "错误扁平路径不应存在");
  });
});
