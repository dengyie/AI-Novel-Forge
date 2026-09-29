const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const wav = require('../dist/services/audiobook/audiobookWav.js');

test('whole-book concatenation crosses RIFF limit without allocating the audio', (t) => {
  const dataSize = 0x80000000;
  const header = wav.buildWavBuffer(Buffer.alloc(2), { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 });
  header.writeUInt32LE(36 + dataSize, 4);
  header.writeUInt32LE(dataSize, 40);
  let outputHeader;
  let finalPosition = 0;
  let published = false;
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'statSync', () => ({ size: dataSize + 44 }));
  t.mock.method(fs, 'openSync', () => 42);
  t.mock.method(fs, 'closeSync', () => {});
  t.mock.method(fs, 'mkdirSync', () => {});
  t.mock.method(fs, 'readSync', (_fd, buffer, offset, length, position) => {
    if (position === 0) header.copy(buffer, offset);
    return length;
  });
  t.mock.method(fs, 'writeSync', (_fd, buffer, offset, length, position) => {
    if (position === 0) outputHeader = Buffer.from(buffer);
    finalPosition = position + length;
    return length;
  });
  t.mock.method(fs, 'renameSync', () => { published = true; });
  const result = wav.concatWavFiles(['a.wav', 'b.wav'], '/virtual/full.wav');
  assert.equal(outputHeader.toString('ascii', 0, 4), 'RF64');
  const info = wav.parseWavInfo(outputHeader);
  assert.equal(info.dataSize, 0x100000000);
  assert.equal(info.dataOffset, 80);
  assert.equal(finalPosition, result.bytes);
  assert.equal(result.bytes, info.dataSize + info.dataOffset);
  assert.equal(published, true);
});

test('small PCM still uses RIFF and concatenates payload at the actual header boundary', () => {
  const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'small-wav-'));
  try {
    const first = path.join(dir, 'a.wav'), second = path.join(dir, 'b.wav'), output = path.join(dir, 'out.wav');
    const format = { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 };
    fs.writeFileSync(first, wav.buildWavBuffer(Buffer.from([1, 2]), format));
    fs.writeFileSync(second, wav.buildWavBuffer(Buffer.from([3, 4]), format));
    const result = wav.concatWavFiles([first, second], output);
    const audio = fs.readFileSync(output);
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.bytes, 48);
    assert.deepEqual([...wav.extractPcmFromWav(audio).pcm], [1, 2, 3, 4]);
    assert.equal(wav.isValidPcmWavFile(output), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RF64 parser rejects absent and unsafe 64-bit size metadata', () => {
  const header = Buffer.alloc(80);
  header.write('RF64'); header.write('WAVE', 8);
  header.write('ds64', 12); header.writeUInt32LE(28, 16);
  header.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 28);
  assert.throws(() => wav.parseWavInfo(header), /安全范围/);
  header.write('JUNK', 12);
  header.write('fmt ', 48); header.writeUInt32LE(16, 52); header.writeUInt16LE(1, 56);
  header.write('data', 72); header.writeUInt32LE(0xffffffff, 76);
  assert.throws(() => wav.parseWavInfo(header), /缺少 ds64/);
});
