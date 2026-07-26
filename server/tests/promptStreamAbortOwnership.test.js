const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "..");

test("aborting a text prompt stream does not leave an unhandled completion rejection", () => {
  const script = String.raw`
    const {
      setPromptRunnerLLMFactoryForTests,
      streamTextPrompt,
    } = require("./dist/prompting/core/promptRunner.js");
    const {
      styleRewritePrompt,
    } = require("./dist/prompting/prompts/style/style.prompts.js");

    setPromptRunnerLLMFactoryForTests(async () => ({
      stream: async () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise(() => undefined),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      }),
    }));

    (async () => {
      const controller = new AbortController();
      const handle = await streamTextPrompt({
        asset: styleRewritePrompt,
        promptInput: {
          styleBlock: "叙事紧凑",
          characterBlock: "动作表达情绪",
          antiAiBlock: "禁止解释性心理描写",
          content: "原文",
          issuesBlock: "问题",
        },
        options: {
          signal: controller.signal,
          timeoutMs: 5_000,
        },
      });

      const handledCompletion = handle.complete.catch(() => undefined);
      controller.abort(new Error("TEST_STREAM_ABORT"));
      await handledCompletion;
      await new Promise((resolve) => setTimeout(resolve, 20));
      setPromptRunnerLLMFactoryForTests();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 2;
    });
  `;

  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "-e", script],
    {
      cwd: serverRoot,
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.equal(
    child.status,
    0,
    [
      `child exited with status ${child.status}`,
      child.stdout,
      child.stderr,
    ].filter(Boolean).join("\n"),
  );
});
