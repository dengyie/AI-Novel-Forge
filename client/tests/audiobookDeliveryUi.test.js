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
  assert.match(panel, /triggerBlobDownload|fetchMediaBlob/);
  assert.match(panel, /readyChapterIds/);
  assert.match(panel, /resource:\s*"chapter"/);
  assert.match(panel, /resource:\s*"full_m4b"/);
  assert.match(panel, /下载 m4b（推荐）|下载全书 WAV/);
  assert.match(panel, /不经 SSH|与小说导出一致/);
  assert.match(panel, /TaskAudioControls novelId=\{novelId\} task=\{task\} chapters=\{(sortedChapters|chapters)\}/);
  // 禁止把远程主机路径当交付入口
  assert.doesNotMatch(panel, /ssh-/i);
  assert.doesNotMatch(panel, /\/personal\/pxed\//);
});

test("NovelAudiobookPanel keeps stable media URL cache (no updatedAt reissue)", () => {
  const panel = readFileSync(
    join(clientRoot, "src/pages/novels/components/NovelAudiobookPanel.tsx"),
    "utf8",
  );
  assert.match(panel, /mediaCacheRef/);
  // 允许注释提及 updatedAt；禁止作为 effect 依赖或代码读取
  assert.doesNotMatch(panel, /task\.updatedAt\s*[,}\]]/);
  assert.doesNotMatch(panel, /deps:.*task\.updatedAt|\[([^\]]*task\.updatedAt[^\]]*)\]/);
  assert.match(panel, /fetchMediaBlob/);
  assert.match(panel, /withDownloadParam|download=1/);
  assert.match(panel, /downloadProgress|正在下载到本地/);
  // 就绪态以服务端 fullAudioReady 为准，不 OR status===succeeded
  assert.doesNotMatch(
    panel,
    /fullAudioReady\s*\|\|\s*task\.fullAudioPath\s*\|\|\s*task\.status\s*===\s*"succeeded"/,
  );
  assert.match(panel, /Boolean\(task\.fullAudioReady\)/);
});

test("client audiobook API still exposes chapter media issue helper", () => {
  const api = readFileSync(join(clientRoot, "src/api/novel/audiobook.ts"), "utf8");
  assert.match(api, /export async function issueAudiobookMediaUrl/);
  assert.match(api, /resource:\s*"chapter"/);
  assert.match(api, /resource:\s*"full_m4b"/);
});
