const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

// E4：llm session log append 失败时（如 pxed errno -122 EDQUOT）降级到 stderr，
// 把 entry 关键字段（timestamp/event/method/provider/model/error/latencyMs）输出，
// 避免可观测性完全丢失（ch6 故障期间 llm.jsonl 写不进去，planner 调用全无记录）。
// 见 docs/optimizations/章节生成链路韧性-planner兜底与错误透传-开发优化文档.md §E4。
// 会让本测试失败的产品改动：删除降级输出、降级输出不含关键字段。

const { appendLlmSessionLog } = require("../dist/llm/sessionLogFile.js");

function makeError121Entry() {
  return {
    timestamp: "2026-08-17T13:00:00.000Z",
    event: "response",
    requestId: "req-e4-1",
    method: "invoke",
    provider: "openai",
    model: "gemini-3.7-flash-high",
    temperature: 0.4,
    maxTokens: null,
    timeoutMs: null,
    taskType: "planner",
    baseURL: null,
    promptMeta: { promptId: "planner.chapter.plan", promptVersion: "v1" },
    actualPromptTokens: 1200,
    latencyMs: 9917,
    payload: null,
    error: null,
  };
}

test("llm log append failure degrades key fields to stderr (E4)", (t) => {
  const originalWarn = console.warn;
  const originalAppend = fs.appendFileSync;
  const originalMkdir = fs.mkdirSync;

  const warnCalls = [];
  console.warn = (msg) => { warnCalls.push(String(msg)); };

  // 让 appendFileSync 抛 pxed 实测的 -122 错误。
  fs.appendFileSync = () => {
    const err = new Error("Unknown system error -122, close");
    err.code = "EDQUOT";
    throw err;
  };
  // mkdirSync 正常返回（隔离 mkdir 干扰）。
  fs.mkdirSync = () => undefined;

  // rotateLogFileIfNeeded 可能也调 fs，先确认它不抛——它读 statSync，目录不存在时可能抛。
  // 为隔离，让 statSync 也返回一个「不需要轮转」的形状。
  const originalStat = fs.statSync;
  fs.statSync = () => ({ size: 0, isFile: () => true });

  try {
    appendLlmSessionLog(makeError121Entry());
  } finally {
    fs.appendFileSync = originalAppend;
    fs.mkdirSync = originalMkdir;
    fs.statSync = originalStat;
    console.warn = originalWarn;
  }

  // 至少有一条 warn 含 "failed to append"。
  const failureWarn = warnCalls.find((m) => m.includes("failed to append"));
  assert.ok(failureWarn, `应有 append 失败 warn，实际 warnCalls=${JSON.stringify(warnCalls)}`);

  // E4 核心：降级输出须含 entry 关键字段，让运维至少知道哪个调用失败。
  // 把所有 warn 拼起来检查（降级可能分多条或一条长串）。
  const allWarns = warnCalls.join("\n");
  assert.ok(allWarns.includes("planner.chapter.plan") || allWarns.includes("planner"),
    `降级输出须含 promptId/taskType 线索，实际=${allWarns}`);
  assert.ok(allWarns.includes("gemini-3.7-flash-high"),
    `降级输出须含 model，实际=${allWarns}`);
});
