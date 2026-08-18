const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterWriterPrompt,
} = require("../dist/prompting/prompts/novel/chapterWriter.prompts.js");

function renderSystem(input) {
  const messages = chapterWriterPrompt.render({
    novelTitle: "测试书",
    chapterOrder: 6,
    chapterTitle: "第6章 真同意",
    ...input,
  }, { blocks: [] });
  return String(messages[0].content ?? messages[0].text ?? "");
}

test("writer prompt ranks chapter boundary above word count", () => {
  const sys = renderSystem({ mode: "draft", targetWordCount: 12000, minWordCount: 10200, maxWordCount: 15000 });

  // 边界必须显式压过篇幅：出现「边界优先于篇幅」类指令
  assert.match(
    sys,
    /结束态|边界.{0,30}(优先|不得.*越|高过|先于).{0,30}(篇幅|字数|长度)|(篇幅|字数|长度).{0,30}(不得|不能|不可).{0,30}(越过|超出|突破).{0,30}(结束态|边界)/,
    "prompt must state length must not override chapter end-state boundary",
  );
});

test("writer prompt forbids padding past the chapter end-state to hit word count", () => {
  const sys = renderSystem({ mode: "draft", targetWordCount: 12000, minWordCount: 10200, maxWordCount: 15000 });

  // 必须允许「戏核完整即收束」，禁止为凑字数开启新场景/新时间
  assert.match(
    sys,
    /(戏核|核心|任务).{0,20}(完成|成立|完整).{0,30}(即可|便可|可以).{0,10}(收束|收尾|结束)/,
    "prompt must permit natural close once the chapter mission is complete",
  );
});

test("continue mode steers toward the boundary instead of pushing past it", () => {
  const sys = renderSystem({ mode: "continue", targetWordCount: 12000, minWordCount: 10200, maxWordCount: 15000, missingWordGap: 4000 });

  // continue 模式不得只喊「补足字数」，必须同时要求向本章结束态收束、不开启新场景
  assert.match(
    sys,
    /(不得|不要|禁止).{0,30}(开启|新增|引入).{0,20}(新场景|新时空|新的时间|下一场)/,
    "continue mode must forbid opening new scenes beyond the chapter boundary",
  );
});
