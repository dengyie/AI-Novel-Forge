const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  AUDIOBOOK_WORKSPACE_OVERVIEW_MAX,
  buildAudiobookWorkspaceOverview,
} = require("../dist/services/audiobook/audiobookWorkspaceOverview.js");
const {
  audiobookVoiceReadinessService,
} = require("../dist/services/audiobook/AudiobookVoiceReadinessService.js");

const serverRoot = path.resolve(__dirname, "..");

test("overview max constant is 50", () => {
  assert.equal(AUDIOBOOK_WORKSPACE_OVERVIEW_MAX, 50);
});

test("buildSummaryFromRows skipRefAudioProbe avoids probe path for clone with path", () => {
  const summary = audiobookVoiceReadinessService.buildSummaryFromRows({
    novelId: "n-list",
    narratorVoice: "茉莉",
    narratorStyle: null,
    characters: [
      {
        id: "c1",
        name: "甲",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "clone",
        ttsVoice: null,
        ttsStyle: null,
        ttsDesignPrompt: null,
        // 故意给不存在的路径；列表模式不得因 probe 判 invalid
        ttsRefAudioPath: "/definitely/not/a/real/ref-audio-for-overview.wav",
        ttsPreviewAudioPath: null,
        ttsPreviewSampleText: null,
        ttsPreviewFingerprint: null,
        ttsPreviewGeneratedAt: null,
      },
    ],
    skipRefAudioProbe: true,
  });
  assert.equal(summary.voiceOk, true);
  assert.equal(summary.voiceConfigured, 1);
  assert.equal(summary.items[0].voiceBindingStatus, "configured");
});

test("buildSummaryFromRows default path probes clone and marks invalid when missing", () => {
  const summary = audiobookVoiceReadinessService.buildSummaryFromRows({
    novelId: "n-detail",
    narratorVoice: "茉莉",
    narratorStyle: null,
    characters: [
      {
        id: "c1",
        name: "甲",
        gender: "male",
        castRole: "protagonist",
        ttsMode: "clone",
        ttsVoice: null,
        ttsStyle: null,
        ttsDesignPrompt: null,
        ttsRefAudioPath: "/definitely/not/a/real/ref-audio-for-overview.wav",
        ttsPreviewAudioPath: null,
        ttsPreviewSampleText: null,
        ttsPreviewFingerprint: null,
        ttsPreviewGeneratedAt: null,
      },
    ],
  });
  assert.equal(summary.voiceOk, false);
  assert.equal(summary.items[0].voiceBindingStatus, "invalid");
});

test("buildAudiobookWorkspaceOverview empty ids → items [] without db work", async () => {
  const result = await buildAudiobookWorkspaceOverview([]);
  assert.deepEqual(result.items, []);
});

test("overview source contract: bulk summary, no assess, skip probe, max 50, latest-task window", () => {
  const src = fs.readFileSync(
    path.join(serverRoot, "src/services/audiobook/audiobookWorkspaceOverview.ts"),
    "utf8",
  );
  assert.match(src, /OVERVIEW_MAX_NOVELS\s*=\s*50/);
  assert.match(src, /skipRefAudioProbe:\s*true/);
  assert.match(src, /buildSummaryFromRows/);
  assert.doesNotMatch(src, /\.assess\s*\(/);
  assert.match(src, /findMany/);
  // 每本 latest task：窗口函数，禁止无界 audiobookTask.findMany 全历史
  assert.match(src, /ROW_NUMBER\(\)\s*OVER/);
  assert.match(src, /loadLatestTasksByNovel/);
  assert.doesNotMatch(src, /audiobookTask\.findMany/);
  // 禁止列表路径 full 音频磁盘 stat
  assert.doesNotMatch(src, /fullAudioReady:\s*true/);
  assert.doesNotMatch(src, /statSync|existsSync/);
});

test("route registers POST workspace-overview before :id workspace", () => {
  const routes = fs.readFileSync(
    path.join(serverRoot, "src/modules/novel/production/http/novelAudiobookRoutes.ts"),
    "utf8",
  );
  const overviewIdx = routes.indexOf('"/audiobook/workspace-overview"');
  const workspaceIdx = routes.indexOf('"/:id/audiobook/workspace"');
  assert.ok(overviewIdx > 0, "workspace-overview route missing");
  assert.ok(workspaceIdx > overviewIdx, "overview must register before :id workspace");
  assert.match(routes, /buildAudiobookWorkspaceOverview/);
  assert.match(routes, /workspaceOverviewBodySchema/);
});
