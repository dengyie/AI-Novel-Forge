import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(clientRoot, rel), "utf8");
}

test("resolveCharacterVoiceBinding helper covers preset/design/clone readiness", () => {
  const helpers = read("src/pages/novels/components/characterAssetWorkspace.helpers.ts");
  assert.match(helpers, /export function resolveCharacterVoiceBinding/);
  assert.match(helpers, /mode === "design"/);
  assert.match(helpers, /mode === "clone"/);
  assert.match(helpers, /shortLabel/);
  assert.match(helpers, /detailLabel/);
});

test("character sidebar and focus show voice binding badges", () => {
  const sidebar = read("src/pages/novels/components/CharacterAssetSidebar.tsx");
  const focus = read("src/pages/novels/components/CharacterFocusSummary.tsx");
  assert.match(sidebar, /resolveCharacterVoiceBinding/);
  assert.match(sidebar, /缺音色/);
  assert.match(focus, /有声书 ·/);
  assert.match(focus, /音色：\{voice\.detailLabel\}/);
});

test("character workspace has dedicated voice card + autoplay preview", () => {
  const workspace = read("src/pages/novels/components/CharacterAssetWorkspace.tsx");
  assert.match(workspace, /novelId: string/);
  assert.match(workspace, /previewAudiobookVoice/);
  assert.match(workspace, /有声书音色/);
  assert.match(workspace, /试听音色/);
  assert.match(workspace, /autoPlay/);
  assert.match(workspace, /previewAudioRef/);
  assert.match(workspace, /decodeBase64AudioToObjectUrl|atob\(/);
  assert.match(workspace, /有声书音色配置/);
});

test("audiobook panel lists bound voices and autoplays preview", () => {
  const panel = read("src/pages/novels/components/NovelAudiobookPanel.tsx");
  assert.match(panel, /characterVoiceRows/);
  assert.match(panel, /当前绑定/);
  assert.match(panel, /kind: "character"/);
  assert.match(panel, /kind: "plan"/);
  assert.match(panel, /autoPlay/);
  assert.match(panel, /previewAudioRef/);
  assert.match(panel, /decodeBase64AudioToObjectUrl/);
  // stale mutate(item) without kind wrapper should not remain
  assert.doesNotMatch(panel, /previewVoiceMutation\.mutate\(item\)/);
});
