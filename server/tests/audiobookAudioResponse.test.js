const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { streamAudioFile } = require("../dist/modules/novel/production/http/audiobook");

async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-response-"));
  const file = path.join(dir, "sample.wav");
  fs.writeFileSync(file, "0123456789");
  const streams = [];
  const originalCreate = fs.createReadStream;
  fs.createReadStream = (...args) => {
    const source = originalCreate(...args);
    streams.push(source);
    return source;
  };
  const app = express();
  app.get("/audio", (req, res) => streamAudioFile(req, res, file, "sample.wav", "audio/wav"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/audio`;
  try {
    await run({ file, dir, url, streams, originalCreate });
  } finally {
    fs.createReadStream = originalCreate;
    for (const source of streams) source.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForClose(source) {
  if (source.closed) return;
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); source.off("close", done); resolve(); };
    const timer = setTimeout(done, 500);
    source.once("close", done);
  });
}

test("audio response closes the file descriptor after repeated HTTP client aborts", async () => {
  await fixture(async ({ file, url, streams }) => {
    fs.truncateSync(file, 32 * 1024 * 1024);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve, reject) => {
        const req = http.get(url, { headers: i % 2 ? { Range: "bytes=0-16777215" } : {} }, (res) => {
          res.once("data", () => { res.destroy(); resolve(); });
          res.on("error", () => {});
        });
        req.on("error", reject);
      });
      const source = streams.at(-1);
      await waitForClose(source);
      assert.equal(source.closed, true, "disconnected response must close its audio source");
      assert.equal(source.fd, null);
    }
  });
});

test("audio response preserves full, byte range, suffix and unsatisfiable responses", async () => {
  await fixture(async ({ url, streams }) => {
    for (const [range, status, content, contentRange] of [
      [undefined, 200, "0123456789", null],
      ["bytes=2-5", 206, "2345", "bytes 2-5/10"],
      ["bytes=-3", 206, "789", "bytes 7-9/10"],
      ["bytes=99-", 416, "", "bytes */10"],
    ]) {
      const response = await fetch(url, { headers: range ? { Range: range } : {} });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("content-range"), contentRange);
      assert.equal(await response.text(), content);
    }
    assert.equal(streams.length, 3, "416 must not open an audio file");
    for (const source of streams) { await waitForClose(source); assert.equal(source.closed, true); }
  });
});

test("audio response handles asynchronous open failure without an uncaught stream error", async () => {
  await fixture(async ({ url, dir, streams, originalCreate }) => {
    fs.createReadStream = (_file, options) => {
      const source = originalCreate(path.join(dir, "removed-after-stat.wav"), options);
      streams.push(source);
      return source;
    };
    await assert.rejects(fetch(url), /fetch failed/);
    await waitForClose(streams[0]);
    assert.equal(streams[0].closed, true);
  });
});

test('mutable audio URLs never permit stale full or range response reuse', async () => {
  await fixture(async ({ url, file }) => {
    for (const [text, range, expected] of [['0123456789', null, '0123456789'], ['abcdefghij', 'bytes=2-5', 'cdef']]) {
      fs.writeFileSync(file, text);
      const response = await fetch(url, { headers: range ? { Range: range } : {} });
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(await response.text(), expected);
    }
  });
});
