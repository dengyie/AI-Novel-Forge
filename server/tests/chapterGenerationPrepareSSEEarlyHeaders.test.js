const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../dist/app.js");
const { DefaultNovelApplicationServices } = require("../dist/services/novel/application/NovelApplicationServices.js");

// E3：planner 阶段（prepareRuntimeChapter）耗时长时，路由层须立即发 SSE 头 + heartbeat，
// 让 CF Tunnel 收到首字节不超时（524）。背景见 §E3 开发优化文档：
// ch6 第二轮重写 8 次 524 全是 planner 同步阻塞期间 CF 100s 无首字节。
// E1 兜底减少了 planner 失败，E2 透传了 prepare 错误，但「planner 正常但慢」仍会 524。
// E3-minimal：路由层在 await runStep 前先 initSSE（发头 + 15s heartbeat ping），
// planner 期间 heartbeat 持续，CF 不超时。
// 铁律：不改内容创作逻辑，只改 SSE 头时序。

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

test("generate route flushes SSE headers before planner resolves (E3 early headers)", async () => {
  const originalMethod = DefaultNovelApplicationServices.prototype.createChapterStream;
  const novelId = "novel-e3-early";
  const chapterId = "chapter-e3-early";
  let resolvePlanner;
  const plannerStarted = new Promise((resolve) => { resolvePlanner = resolve; });

  // 模拟 planner 慢：createChapterStream 进入即标记 started，延迟返回 stream。
  // 路由层须在 createChapterStream resolve 之前就发出 SSE 头（首字节）。
  DefaultNovelApplicationServices.prototype.createChapterStream = async () => {
    resolvePlanner("started");
    // 让 planner 阻塞 300ms，模拟 prepare 慢。
    await new Promise((r) => setTimeout(r, 300));
    return {
      stream: (async function* () {
        yield { content: "正文" };
      })(),
      onDone: async (fullContent) => ({ fullContent }),
    };
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/novels/${novelId}/chapters/${chapterId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    assert.equal(response.headers.get("content-type"), "text/event-stream",
      "planner 慢时须立即返回 SSE 头，实际=${response.headers.get('content-type')}");
    assert.ok(text.includes("\"type\":\"chunk\""), "stream 须含 chunk");
    assert.ok(text.includes("\"type\":\"done\""), "stream 须含 done");
  } finally {
    DefaultNovelApplicationServices.prototype.createChapterStream = originalMethod;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("generate route emits SSE error frame with failurePhase when prepare fails after early headers (E3+E2)", async () => {
  const originalMethod = DefaultNovelApplicationServices.prototype.createChapterStream;
  const novelId = "novel-e3-fail";
  const chapterId = "chapter-e3-fail";

  // E3 提前发 SSE 头后，prepare 失败不能再写 JSON body，改写 SSE error frame 含 failurePhase。
  DefaultNovelApplicationServices.prototype.createChapterStream = async () => {
    const error = new Error("Planner output is missing objective.");
    Object.defineProperty(error, "chapterGenerationFailurePhase", {
      value: "prepare",
      configurable: true,
    });
    throw error;
  };

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/novels/${novelId}/chapters/${chapterId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    // 头已发（E3 提前 initSSE），content-type 应为 SSE。
    assert.equal(response.headers.get("content-type"), "text/event-stream",
      `E3 提前发头后 content-type 须为 SSE，实际=${response.headers.get("content-type")}`);
    // prepare 失败改用 SSE error frame 透传 failurePhase。
    assert.ok(text.includes("\"type\":\"error\""), `须含 error frame，实际=${text}`);
    assert.ok(text.includes("prepare"), `error frame 须含 failurePhase=prepare，实际=${text}`);
  } finally {
    DefaultNovelApplicationServices.prototype.createChapterStream = originalMethod;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
