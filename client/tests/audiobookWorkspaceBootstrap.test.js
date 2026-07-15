import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("AudiobookProjectPage uses lightweight workspace bootstrap API", () => {
  const page = readFileSync(join(clientRoot, "src/pages/audiobook/AudiobookProjectPage.tsx"), "utf8");
  assert.match(page, /getAudiobookWorkspace/);
  assert.match(page, /queryKeys\.novels\.audiobookWorkspace/);
  // 禁止真正调用/导入 getNovelDetail（注释里可提及其对比）
  assert.doesNotMatch(page, /import\s*\{[^}]*\bgetNovelDetail\b/);
  assert.doesNotMatch(page, /\bgetNovelDetail\s*\(/);
  assert.match(page, /不含正文|不含章节正文|轻量 bootstrap/);
});

test("client audiobook API exposes getAudiobookWorkspace", () => {
  const api = readFileSync(join(clientRoot, "src/api/novel/audiobook.ts"), "utf8");
  assert.match(api, /export async function getAudiobookWorkspace/);
  assert.match(api, /\/novels\/\$\{novelId\}\/audiobook\/workspace/);
});

test("queryKeys includes audiobookWorkspace", () => {
  const keys = readFileSync(join(clientRoot, "src/api/queryKeys.ts"), "utf8");
  assert.match(keys, /audiobookWorkspace:\s*\(id:\s*string\)\s*=>\s*\["novels",\s*"audiobook-workspace"/);
});
