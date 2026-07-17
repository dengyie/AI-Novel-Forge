import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadBadges() {
  const modPath = path.join(clientRoot, "src/pages/audiobook/audiobookWorkspaceBadges.ts");
  return import(pathToFileURL(modPath).href);
}

function baseOverview(patch = {}) {
  return {
    novelId: "n1",
    readiness: {
      voiceOk: true,
      voiceConfigured: 2,
      characterTotal: 2,
      previewReady: 2,
      previewMissing: 0,
      previewStale: 0,
      readyForWorkbench: true,
      narratorValid: true,
    },
    latestTask: null,
    activeReadinessJob: false,
    ...patch,
  };
}

test("badge: running task wins over missing voice", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({
      readiness: {
        voiceOk: false,
        voiceConfigured: 0,
        characterTotal: 3,
        previewReady: 0,
        previewMissing: 3,
        previewStale: 0,
        readyForWorkbench: false,
        narratorValid: true,
      },
      latestTask: {
        id: "t1",
        status: "running",
        progress: 42,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    }),
  );
  assert.equal(result.primary?.label, "生成中 42%");
  assert.equal(result.primary?.variant, "default");
  assert.ok(result.secondary.some((b) => b.label.startsWith("音色")));
});

test("badge: succeeded then new running → 生成中", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({
      latestTask: {
        id: "t2",
        status: "queued",
        progress: 0,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    }),
  );
  assert.equal(result.primary?.label, "生成中 0%");
});

test("badge: failed primary", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({
      latestTask: {
        id: "t3",
        status: "failed",
        progress: 10,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    }),
  );
  assert.equal(result.primary?.label, "上次失败");
  assert.equal(result.primary?.variant, "destructive");
});

test("badge: readiness null + no task", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({ readiness: null, latestTask: null }),
  );
  assert.equal(result.primary?.label, "态势暂不可用");
});

test("badge: voiceOk + no task → 待生成", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(baseOverview());
  assert.equal(result.primary?.label, "待生成");
});

test("badge: 0 characters voiceOk → 待生成 + secondary counts", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({
      readiness: {
        voiceOk: true,
        voiceConfigured: 0,
        characterTotal: 0,
        previewReady: 0,
        previewMissing: 0,
        previewStale: 0,
        readyForWorkbench: true,
        narratorValid: true,
      },
    }),
  );
  assert.equal(result.primary?.label, "待生成");
  assert.equal(result.secondary.length, 2);
  assert.ok(result.secondary.some((b) => b.label.includes("0/0")));
});

test("badge: succeeded weak listen signal", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({
      latestTask: {
        id: "t4",
        status: "succeeded",
        progress: 100,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    }),
  );
  assert.equal(result.primary?.label, "可听/可下");
});

test("badge: active readiness job", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(
    baseOverview({ activeReadinessJob: true, latestTask: null }),
  );
  assert.equal(result.primary?.label, "就绪中");
});

test("badge: null overview", async () => {
  const { resolveAudiobookWorkspaceBadges } = await loadBadges();
  const result = resolveAudiobookWorkspaceBadges(null);
  assert.equal(result.primary, null);
  assert.deepEqual(result.secondary, []);
});

test("workspace page wires overview + badge resolver", () => {
  const page = readFileSync(
    path.join(clientRoot, "src/pages/audiobook/AudiobookWorkspacePage.tsx"),
    "utf8",
  );
  assert.match(page, /postAudiobookWorkspaceOverview/);
  assert.match(page, /resolveAudiobookWorkspaceBadges/);
  assert.match(page, /audiobookWorkspaceOverview/);
  assert.match(page, /novelIdsKey/);
  assert.match(page, /novelIds\.join/);
});

test("project panel IA anchors + mobile fixed CTA + queryKeys tasks", () => {
  const panel = readFileSync(
    path.join(clientRoot, "src/pages/novels/components/NovelAudiobookPanel.tsx"),
    "utf8",
  );
  assert.match(panel, /id="ab-prepare"/);
  assert.match(panel, /id="ab-create"/);
  assert.match(panel, /id="ab-tasks"/);
  assert.match(panel, /bottom:\s*"calc\(4\.25rem \+ env\(safe-area-inset-bottom\)\)"/);
  assert.match(panel, /queryKeys\.novels\.audiobookTasks/);
  assert.doesNotMatch(panel, /\["novel-audiobook-tasks"/);
  assert.match(panel, /from "@\/components\/ui\/toast"/);
});

test("ReadinessSection native toast + overview invalidate; panel no dual toast bridge", () => {
  const readiness = readFileSync(
    path.join(clientRoot, "src/pages/novels/components/AudiobookVoiceReadinessSection.tsx"),
    "utf8",
  );
  const panel = readFileSync(
    path.join(clientRoot, "src/pages/novels/components/NovelAudiobookPanel.tsx"),
    "utf8",
  );
  assert.match(readiness, /from "@\/components\/ui\/toast"/);
  assert.match(readiness, /function reportReadinessTerminal/);
  assert.match(readiness, /toast\.success/);
  assert.match(readiness, /toast\.error/);
  assert.match(readiness, /audiobookWorkspaceOverviewPrefix|audiobook-workspace-overview/);
  // panel readiness onMessage must not re-toast with regex dual path
  assert.doesNotMatch(
    panel,
    /onMessage=\{\(text\) => \{[\s\S]*?toast\.(success|error)/,
  );
  assert.match(panel, /ReadinessSection 终态已 toast/);
});

test("workspace page surfaces overview error and truncated banner", () => {
  const page = readFileSync(
    path.join(clientRoot, "src/pages/audiobook/AudiobookWorkspacePage.tsx"),
    "utf8",
  );
  assert.match(page, /overviewQuery\.isError/);
  assert.match(page, /重试态势/);
  assert.match(page, /truncated/);
  assert.match(page, /态势失败/);
});

test("panel reprocess invalidates overview; tasks pad for mobile fixed CTA", () => {
  const panel = readFileSync(
    path.join(clientRoot, "src/pages/novels/components/NovelAudiobookPanel.tsx"),
    "utf8",
  );
  assert.match(panel, /onReprocessed=\{\(\) => \{[\s\S]*?audiobookWorkspaceOverviewPrefix/);
  assert.match(panel, /id="ab-tasks"[\s\S]*?pb-28/);
  assert.match(panel, /audiobookWorkspaceOverviewPrefix/);
});

test("queryKeys exposes audiobookWorkspaceOverviewPrefix", () => {
  const keys = readFileSync(
    path.join(clientRoot, "src/api/queryKeys.ts"),
    "utf8",
  );
  assert.match(keys, /audiobookWorkspaceOverviewPrefix:\s*\[\"novels\",\s*\"audiobook-workspace-overview\"\]/);
});

test("project page narrator save invalidates overview prefix", () => {
  const project = readFileSync(
    path.join(clientRoot, "src/pages/audiobook/AudiobookProjectPage.tsx"),
    "utf8",
  );
  assert.match(project, /audiobookWorkspaceOverviewPrefix/);
  assert.match(project, /saveNarratorMutation/);
});
