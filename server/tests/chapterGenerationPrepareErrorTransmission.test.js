const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../dist/app.js");
const { DefaultNovelApplicationServices } = require("../dist/services/novel/application/NovelApplicationServices.js");

// E2：planner/prepare 阶段失败时路由层返回结构化 JSON（含 failurePhase），
// 而非让请求拖到 CF 524 或返回无 phase 的 500。
// 背景（见 docs/optimizations/章节生成链路韧性-planner兜底与错误透传-开发优化文档.md §E2）：
// ch6 第二轮重写 8 次 524 全是 planner postValidate 抛错导致，公网表象 524 掩盖真根因。
// E1 兜底减少了 postValidate 失败，但兜底也失败 / planner invoke 网络 / context 加载等
// 仍会让 prepare 阶段抛错。E2 让这些错误带 failurePhase 透传到路由层，返回结构化 JSON。
// 铁律：不破「监管只监控不代写」——错误透传只改错误形态，不改内容创作逻辑。

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

test("generate route returns structured error with failurePhase=prepare when planner fails", async () => {
  const originalMethod = DefaultNovelApplicationServices.prototype.createChapterStream;
  const novelId = "novel-e2-prepare";
  const chapterId = "chapter-e2-prepare";

  // 模拟 prepare 阶段（planner postValidate / context 加载）失败。
  // 错误须带 chapterGenerationFailurePhase="prepare" 标记（E2 实现注入）。
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
    // E3 后头提前发：content-type 为 SSE（text/event-stream），prepare 失败走 SSE error frame。
    // 不得是 524（CF 表象），也不得是无 phase 的裸 500。
    assert.ok(response.status !== 524, `不得返回 524（CF 表象），实际=${response.status}`);
    assert.ok(response.headers.get("content-type")?.includes("text/event-stream"),
      `E3 后 prepare 失败须走 SSE error frame，实际 content-type=${response.headers.get("content-type")}`);
    const text = await response.text();
    assert.ok(text.includes("\"type\":\"error\""), `须含 error frame，实际=${text}`);
    assert.ok(text.includes("prepare"), `error frame 须含 failurePhase=prepare，实际=${text}`);
    assert.ok(text.includes("Planner output is missing objective"),
      `error frame 须含失败原因，实际=${text}`);
  } finally {
    DefaultNovelApplicationServices.prototype.createChapterStream = originalMethod;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("generate route keeps legacy 500 for non-prepare errors (不误标)", async () => {
  const originalMethod = DefaultNovelApplicationServices.prototype.createChapterStream;
  const novelId = "novel-e2-other";
  const chapterId = "chapter-e2-other";

  // 非 prepare 阶段错误（如 writer 阶段）不得被标 failurePhase=prepare。
  DefaultNovelApplicationServices.prototype.createChapterStream = async () => {
    throw new Error("writer stream crashed unexpectedly");
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
    // E3 后非 prepare 错误也走 SSE error frame（头已发），但不得带 failurePhase=prepare。
    const text = await response.text();
    assert.ok(!text.includes("prepare"),
      `非 prepare 错误不得误标 failurePhase=prepare，实际=${text}`);
    assert.ok(text.includes("writer stream crashed"),
      `非 prepare 错误须透传原始错误消息，实际=${text}`);
  } finally {
    DefaultNovelApplicationServices.prototype.createChapterStream = originalMethod;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
