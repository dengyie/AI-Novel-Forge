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
  assert.match(helpers, /export function isCharacterVoiceFormDirty/);
  assert.match(helpers, /export function canPreviewCharacterVoice/);
  assert.match(helpers, /CHARACTER_VOICE_MODE_OPTIONS/);
  assert.match(helpers, /findMimoVoiceCatalogItem/);
  assert.match(helpers, /isMimoTtsPresetVoice/);
  // dead export should not return
  assert.doesNotMatch(helpers, /export function getCharacterVoiceModeLabel/);
});

test("shared audiobook voice audio helpers exist", () => {
  const audio = read("src/lib/audiobookVoiceAudio.ts");
  assert.match(audio, /export function decodeBase64AudioToObjectUrl/);
  assert.match(audio, /export function createObjectUrlSlot/);
  assert.match(audio, /export async function tryAutoPlayAudio/);
  assert.match(audio, /export function resolveLocalAudioSrc/);
  // internal strip helper; not a public dual-revoke path
  assert.doesNotMatch(audio, /export function stripDataUrlBase64/);
  assert.doesNotMatch(audio, /export function replaceObjectUrl/);
});

test("CharacterVoiceEditor is the single configuration surface", () => {
  const editor = read("src/pages/novels/components/CharacterVoiceEditor.tsx");
  assert.match(editor, /export default function CharacterVoiceEditor/);
  assert.match(editor, /CHARACTER_VOICE_MODE_OPTIONS/);
  assert.match(editor, /MIMO_TTS_VOICE_CATALOG/);
  assert.match(editor, /canPreviewCharacterVoice/);
  assert.match(editor, /isCharacterVoiceFormDirty/);
  assert.match(editor, /未保存/);
  assert.match(editor, /试听音色/);
  assert.match(editor, /tryAutoPlayAudio/);
  assert.match(editor, /resolveLocalAudioSrc/);
  assert.match(editor, /createObjectUrlSlot/);
  assert.match(editor, /本地试听/);
  assert.match(editor, /配置方式/);
  assert.match(editor, /中文预置/);
  assert.match(editor, /英文预置/);
  // no speculative compact mode / dual revoke path
  assert.doesNotMatch(editor, /compact\?:/);
  assert.doesNotMatch(editor, /replaceObjectUrl/);
});

test("character sidebar and focus show voice binding badges", () => {
  const sidebar = read("src/pages/novels/components/CharacterAssetSidebar.tsx");
  const focus = read("src/pages/novels/components/CharacterFocusSummary.tsx");
  assert.match(sidebar, /resolveCharacterVoiceBinding/);
  assert.match(sidebar, /缺音色/);
  assert.match(focus, /有声书 ·/);
  assert.match(focus, /音色：\{voice\.detailLabel\}/);
});

test("character workspace mounts CharacterVoiceEditor once as source of truth", () => {
  const workspace = read("src/pages/novels/components/CharacterAssetWorkspace.tsx");
  assert.match(workspace, /novelId: string/);
  assert.match(workspace, /CharacterVoiceEditor/);
  assert.match(workspace, /有声书音色在上方专用卡片配置/);
  // 旧的内联重复配置 / 本地 decode 不应再残留
  assert.doesNotMatch(workspace, /previewAudiobookVoice/);
  assert.doesNotMatch(workspace, /function decodeBase64AudioToObjectUrl/);
  assert.doesNotMatch(workspace, /MIMO_TTS_VOICE_CATALOG/);
  assert.doesNotMatch(workspace, /模态：预置音色/);
  assert.doesNotMatch(workspace, /有声书音色已在上方专用卡片配置（含模态/);
  // 只应挂载一次编辑器
  const mounts = workspace.match(/<CharacterVoiceEditor/g) ?? [];
  assert.equal(mounts.length, 1);
});

test("audiobook panel lists bound voices and autoplays preview via shared audio util", () => {
  const panel = read("src/pages/novels/components/NovelAudiobookPanel.tsx");
  assert.match(panel, /characterVoiceRows/);
  assert.match(panel, /当前绑定/);
  assert.match(panel, /kind: "character"/);
  assert.match(panel, /kind: "plan"/);
  assert.match(panel, /autoPlay/);
  assert.match(panel, /previewAudioRef/);
  assert.match(panel, /decodeBase64AudioToObjectUrl/);
  assert.match(panel, /tryAutoPlayAudio/);
  assert.match(panel, /createObjectUrlSlot/);
  assert.match(panel, /@\/lib\/audiobookVoiceAudio/);
  assert.doesNotMatch(panel, /function decodeBase64AudioToObjectUrl/);
  assert.doesNotMatch(panel, /replaceObjectUrl/);
  // stale mutate(item) without kind wrapper should not remain
  assert.doesNotMatch(panel, /previewVoiceMutation\.mutate\(item\)/);
});
