import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("NovelAudiobookPanel delivery uses media-access and progressive chapters", () => {
  const panel = readFileSync(
    join(clientRoot, "src/pages/novels/components/NovelAudiobookPanel.tsx"),
    "utf8",
  );
  assert.match(panel, /issueAudiobookMediaUrl/);
  assert.match(panel, /triggerBrowserDownload/);
  assert.match(panel, /readyChapterIds/);
  assert.match(panel, /resource:\s*"chapter"/);
  assert.match(panel, /resource:\s*"full_m4b"/);
  assert.match(panel, /下载 m4b（推荐）|下载全书 WAV/);
  assert.match(panel, /不经 SSH|与小说导出一致/);
  assert.match(panel, /TaskAudioControls novelId=\{novelId\} task=\{task\} chapters=\{sortedChapters\}/);
  // 禁止把远程主机路径当交付入口
  assert.doesNotMatch(panel, /ssh-/i);
  assert.doesNotMatch(panel, /\/personal\/pxed\//);
});

test("client audiobook API still exposes chapter media issue helper", () => {
  const api = readFileSync(join(clientRoot, "src/api/novel/audiobook.ts"), "utf8");
  assert.match(api, /export async function issueAudiobookMediaUrl/);
  assert.match(api, /resource:\s*"chapter"/);
  assert.match(api, /resource:\s*"full_m4b"/);
});
