const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const {
  checkVoiceRefAudioPath,
  isPathInside,
  probeVoiceRefAudioOk,
} = require("../dist/services/audiobook/voiceRefPath.js");
const { resolveVoiceRefRoot } = require("../dist/services/audiobook/audiobookPaths.js");

test("isPathInside rejects parent escape", () => {
  const root = "/tmp/voice-refs-root";
  assert.equal(isPathInside(root, path.join(root, "a", "b.wav")), true);
  assert.equal(isPathInside(root, path.join(root, "..", "etc", "passwd")), false);
  assert.equal(isPathInside(root, "/etc/passwd"), false);
});

test("checkVoiceRefAudioPath rejects out-of-root absolute path", () => {
  const outside = path.join(os.tmpdir(), `not-voice-ref-${Date.now()}.wav`);
  fs.writeFileSync(outside, Buffer.alloc(64));
  try {
    const checked = checkVoiceRefAudioPath(outside);
    assert.equal(checked.ok, false);
    if (!checked.ok) {
      assert.match(checked.reason, /越界|voice-refs/);
    }
    assert.equal(probeVoiceRefAudioOk(outside), false);
  } finally {
    try { fs.unlinkSync(outside); } catch { /* ignore */ }
  }
});

test("checkVoiceRefAudioPath accepts file under voice-refs root", () => {
  const root = resolveVoiceRefRoot();
  const dir = path.join(root, "test-novel", "test-char");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ref.wav");
  fs.writeFileSync(file, Buffer.alloc(128));
  try {
    const checked = checkVoiceRefAudioPath(file);
    assert.equal(checked.ok, true);
    if (checked.ok) {
      assert.equal(checked.absolutePath, path.resolve(file));
    }
    assert.equal(probeVoiceRefAudioOk(file), true);
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
});

test("checkVoiceRefAudioPath rejects empty and traversal tokens", () => {
  assert.equal(checkVoiceRefAudioPath("").ok, false);
  assert.equal(checkVoiceRefAudioPath("../etc/passwd").ok, false);
  assert.equal(probeVoiceRefAudioOk(null), null);
  assert.equal(probeVoiceRefAudioOk(""), null);
});
