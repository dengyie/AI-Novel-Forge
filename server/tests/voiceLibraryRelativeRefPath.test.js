/**
 * P2-a: bind 存相对路径后，resolveEffectiveCloneRefPath 须把相对 ttsRefAudioPath
 * 解析回 voice-refs 根绝对路径，而非相对 cwd。
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-relpath-"));
process.env.AI_NOVEL_RUNTIME = "desktop";
process.env.AI_NOVEL_APP_DATA_DIR = TMP_ROOT;

const {
  resolveEffectiveCloneRefPath,
} = require("../dist/services/audiobook/voiceLibraryService");
const {
  resolveVoiceRefRoot,
} = require("../dist/services/audiobook/audiobookPaths");

function writeSilentPcmWav(filePath, { rate = 24000, seconds = 0.1 } = {}) {
  const numSamples = Math.max(1, Math.floor(rate * seconds));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

describe("bind relative ref path (P2-a)", () => {
  after(() => {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("resolveEffectiveCloneRefPath resolves a relative ttRefAudioPath to voice-refs root", () => {
    const root = resolveVoiceRefRoot();
    const absWav = writeSilentPcmWav(path.join(root, "nov-x", "char-y", "ref.wav"));
    const rel = path.relative(root, absWav).split(path.sep).join("/");

    // 模拟 bind 写入 DB 的相对路径；无 assetId 走 legacy 解析
    const resolved = resolveEffectiveCloneRefPath({
      ttsVoiceAssetId: null,
      ttsRefAudioPath: rel,
    });
    assert.equal(resolved, absWav);
    assert.ok(fs.existsSync(resolved));
  });

  it("resolveEffectiveCloneRefPath still resolves legacy absolute path", () => {
    const root = resolveVoiceRefRoot();
    const absWav = writeSilentPcmWav(path.join(root, "nov-x2", "char-y2", "ref.wav"));

    const resolved = resolveEffectiveCloneRefPath({
      ttsVoiceAssetId: null,
      ttsRefAudioPath: absWav,
    });
    assert.equal(resolved, absWav);
  });

  it("resolveEffectiveCloneRefPath returns null for empty input", () => {
    assert.equal(
      resolveEffectiveCloneRefPath({ ttsVoiceAssetId: null, ttsRefAudioPath: null }),
      null,
    );
    assert.equal(
      resolveEffectiveCloneRefPath({ ttsVoiceAssetId: null, ttsRefAudioPath: "  " }),
      null,
    );
  });
});
