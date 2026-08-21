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

test("ending state is a lock: character/prop/location may not move past it for hook appeal", () => {
  const sys = renderSystem({ mode: "draft" });

  // 收尾框架必须把「本章结束态」抬为不可背离的位置锁：结尾写到哪，人物/物件/地点就停在哪，
  // 不得为了让结尾更有钩子而把角色/物品挪出结束态（ch5 反复把「何屿带金属片逃离」当作钩子、
  // 越过了「何屿退守设备间、金属片在陆深/地上」的结束态）。
  // 断言唯一性：必须同时出现①结束态=位置锁 ②为钩子不得挪走结束态内人物/物件 ③结束态由 chapter_boundary 决定。
  assert.match(
    sys,
    /结束态.{0,60}(位置锁|位置锁定|锁定)/,
    "prompt must name the end-state a position lock",
  );
  assert.match(
    sys,
    /(为了|为).{0,20}(结尾|钩子).{0,40}(挪走|带离|放走|移动|带走|违背|背离|离开).{0,10}(结束态|在场)/,
    "prompt must forbid moving end-state characters/props for hook appeal",
  );
});

test("ending state lock is channeled: refers to the boundary/end-state, not any hardcoded content", () => {
  const sys = renderSystem({ mode: "draft" });

  // 铁律必须是「通道化」的——只约束「结束态不可背离」，具体是谁/在哪留给章节上下文决定；
  // 不得出现把某本书某章的具体剧情写进通用 writer（硬编码污染，跨书泄漏）。
  assert.match(
    sys,
    /本章结束态|结束态/,
    "ending-state lock must reference the channeled boundary, not hardcode book content",
  );
  assert.doesNotMatch(
    sys,
    /何屿|陆深|金属片|设备间|P5/,
    "generic writer prompt must NOT hardcode 神通者 ch5 content (channeled, not book-literal)",
  );
});

