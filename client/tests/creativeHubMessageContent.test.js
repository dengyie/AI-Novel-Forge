import test from "node:test";
import assert from "node:assert/strict";
import {
  getMessageContent,
  normalizeLangChainMessageContent,
  safeConvertLangChainMessages,
} from "../src/pages/creativeHub/lib/creativeHubMessageContent.ts";

test("normalizeLangChainMessageContent accepts string and array only", () => {
  assert.equal(normalizeLangChainMessageContent("hi"), "hi");
  assert.deepEqual(normalizeLangChainMessageContent([{ type: "text", text: "a" }]), [
    { type: "text", text: "a" },
  ]);
  assert.equal(normalizeLangChainMessageContent(null), "");
  assert.equal(normalizeLangChainMessageContent(undefined), "");
  assert.equal(normalizeLangChainMessageContent(12), "");
  assert.equal(normalizeLangChainMessageContent({ foo: 1 }), "");
});

test("getMessageContent tolerates missing or broken content/attachments", () => {
  assert.equal(getMessageContent({}), "");
  assert.equal(getMessageContent({ content: undefined }), "");
  assert.equal(getMessageContent({ content: null }), "");
  assert.equal(getMessageContent({ content: "hi" }), "hi");
  assert.equal(getMessageContent({ content: [{ type: "text", text: "a" }] }), "a");
  assert.equal(getMessageContent({ content: "x", attachments: null }), "x");
  assert.equal(getMessageContent({ content: "x", attachments: [{ content: null }] }), "x");
  assert.deepEqual(
    getMessageContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  );
});

test("safeConvertLangChainMessages does not throw on null/invalid content", () => {
  const cases = [
    { type: "human", id: "h1", content: null },
    { type: "human", id: "h2", content: undefined },
    { type: "ai", id: "a1", content: null },
    { type: "ai", id: "a2", content: 123 },
    { type: "human", id: "h3", content: { bad: true } },
  ];

  for (const message of cases) {
    assert.doesNotThrow(() => {
      const converted = safeConvertLangChainMessages(message);
      assert.ok(converted);
      assert.ok(converted.role === "user" || converted.role === "assistant" || converted.role === "system");
    }, `should convert ${JSON.stringify(message)}`);
  }

  const ok = safeConvertLangChainMessages({
    type: "human",
    id: "ok",
    content: "hello",
  });
  assert.equal(ok.role, "user");
  assert.deepEqual(ok.content, [{ type: "text", text: "hello" }]);
});
