const test = require("node:test");
const assert = require("node:assert/strict");

const { streamToSSE } = require("../dist/llm/streaming.js");

/**
 * F6 回归测试：客户端断连 → 调用方 signal abort 时，streamToSSE 必须
 *  1) 立即停止从上游拉取 chunk（break for-await），
 *  2) 跳过 done/error 帧写回（不向已关闭的 res 再写），
 *  3) 仍然调用 onDone，使章节 in-process 锁的 `finally { releaseRepairLock() }` 执行。
 *
 * 对应路由：novelReviewRoutes POST /:id/chapters/:chapterId/repair。
 */

function createMockResponse() {
  const frames = [];
  let ended = false;
  const res = {
    headers: {},
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders() {
      /* noop */
    },
    write(data) {
      if (ended) {
        throw new Error("write after end");
      }
      // 解析 `data: {...}\n\n`
      const match = /^data: (.+)\n\n$/.exec(data);
      if (match) {
        try {
          frames.push(JSON.parse(match[1]));
        } catch {
          frames.push({ raw: data });
        }
      }
      return true;
    },
    end() {
      ended = true;
      this.writableEnded = true;
    },
  };
  return { res, frames };
}

async function* chunksFrom(items) {
  for (const item of items) {
    yield item;
  }
}

test("F6: already-aborted signal breaks chunk drain and skips done/error frames, onDone still runs", async () => {
  const controller = new AbortController();
  controller.abort();
  const { res, frames } = createMockResponse();

  let onDoneCalls = 0;
  await streamToSSE(
    res,
    chunksFrom([{ content: "甲" }, { content: "乙" }]),
    () => {
      onDoneCalls += 1;
    },
    { signal: controller.signal },
  );

  assert.equal(onDoneCalls, 1, "onDone 必须被调用一次（锁 finally 释放依赖它）");
  const chunkFrames = frames.filter((f) => f.type === "chunk");
  const doneFrames = frames.filter((f) => f.type === "done");
  const errorFrames = frames.filter((f) => f.type === "error");
  assert.equal(chunkFrames.length, 0, "已 abort 时不应再拉/写任何 chunk");
  assert.equal(doneFrames.length, 0, "已 abort 时不应写 done 帧");
  assert.equal(errorFrames.length, 0, "已 abort 时不应写 error 帧");
  assert.equal(res.writableEnded, true, "res 必须 end()");
});

test("F6: signal aborts mid-stream → only pre-abort chunks written, no done/error frame, onDone runs", async () => {
  const controller = new AbortController();
  const { res, frames } = createMockResponse();

  async function* abortMidway() {
    yield { content: "甲" };
    controller.abort(new Error("client disconnected"));
    yield { content: "乙" };
  }

  let onDoneCalls = 0;
  await streamToSSE(
    res,
    abortMidway(),
    () => {
      onDoneCalls += 1;
    },
    { signal: controller.signal },
  );

  assert.equal(onDoneCalls, 1, "onDone 仍须被调用一次");
  const chunkContents = frames
    .filter((f) => f.type === "chunk")
    .map((f) => f.content);
  assert.deepEqual(chunkContents, ["甲"], "只应写 abort 前已拉到的 chunk");
  const doneFrames = frames.filter((f) => f.type === "done");
  const errorFrames = frames.filter((f) => f.type === "error");
  assert.equal(doneFrames.length, 0, "abort 后不应写 done 帧");
  assert.equal(errorFrames.length, 0, "abort 后不应写 error 帧");
});

test("F6: onDone rejects while signal aborted → catch skips error frame", async () => {
  // 模拟真实路径：客户端断连 → controller.abort() 触发 heavy prompt captureStreamOutput
  // 内部 settleReject → `await streamed.complete` 抛错到 onDone → 冒泡到 streamToSSE catch。
  // signal 已 abort 时 catch 分支必须 return，避免向已关闭 res 写 error 帧。
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  const { res, frames } = createMockResponse();

  let onDoneCalls = 0;
  await streamToSSE(
    res,
    chunksFrom([{ content: "甲" }]),
    () => {
      onDoneCalls += 1;
      throw new Error("streamed.complete rejected due to abort");
    },
    { signal: controller.signal },
  );

  assert.equal(onDoneCalls, 1, "onDone 仍须被调用");
  const errorFrames = frames.filter((f) => f.type === "error");
  assert.equal(errorFrames.length, 0, "signal 已 abort 时 onDone 抛错也不应写 error 帧");
  assert.equal(res.writableEnded, true, "res 必须 end()");
});

test("F6: no signal (backward compat) — normal flow writes chunks + done frame", async () => {
  const { res, frames } = createMockResponse();

  await streamToSSE(res, chunksFrom([{ content: "甲" }, { content: "乙" }]), (full) => {
    return { fullContent: full };
  });

  const chunkContents = frames
    .filter((f) => f.type === "chunk")
    .map((f) => f.content);
  assert.deepEqual(chunkContents, ["甲", "乙"]);
  const doneFrames = frames.filter((f) => f.type === "done");
  assert.equal(doneFrames.length, 1);
  assert.equal(doneFrames[0].fullContent, "甲乙");
  assert.equal(res.writableEnded, true);
});
