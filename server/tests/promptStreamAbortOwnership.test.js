const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const serverRoot = path.resolve(__dirname, "..");

test("aborting prompt capture interrupts a provider iterator that ignores AbortSignal", async () => {
  const {
    capturePromptStream,
  } = require("../dist/prompting/streaming/PromptStreamCapture.js");
  const controller = new AbortController();
  let iteratorReturnCalls = 0;
  let nextStartedResolve;
  const nextStarted = new Promise((resolve) => {
    nextStartedResolve = resolve;
  });
  const rawStream = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          nextStartedResolve();
          return new Promise(() => undefined);
        },
        async return() {
          iteratorReturnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const captured = capturePromptStream(rawStream, {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  const handledCompletion = captured.completion.catch(() => undefined);
  const drain = (async () => {
    for await (const _chunk of captured.stream) {
      // The provider never yields; abort must terminate this loop.
    }
  })();

  await nextStarted;
  controller.abort(new Error("TEST_PROVIDER_IGNORES_ABORT"));
  const outcome = await Promise.race([
    drain.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timed_out" }), 150)),
  ]);
  await handledCompletion;

  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.error.message, /TEST_PROVIDER_IGNORES_ABORT/);
  assert.equal(iteratorReturnCalls, 1);
});

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
