const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OPPONENT_LINE_VIOLATION_TERMS,
  detectOpponentLineViolation,
  stripNegatedOpponentDeclarations,
  assessChapterExecutionContractShape,
} = require("../../shared/dist/types/chapterTaskSheetQuality.js");

// ---- 纯函数层: detectOpponentLineViolation ----

test("detectOpponentLineViolation flags 全班集体站队 abstract-societal phrasing", () => {
  const hit = detectOpponentLineViolation("全班同学一起站出来反对主角的计划。");
  assert.equal(hit.violated, true);
  assert.ok(hit.matched.includes("全班"));
  // 集体站队 要求字面连续出现「集体站队」才命中;此处文本「全班」单独命中已足够触发
  assert.ok(hit.matched.length > 0);
});

test("detectOpponentLineViolation flags 集体站队 + 舆论全体 specific terms", () => {
  const hit = detectOpponentLineViolation(
    "他们组织集体站队,舆论全体针对主角。",
  );
  assert.equal(hit.violated, true);
  assert.ok(hit.matched.includes("集体站队"));
  assert.ok(hit.matched.includes("舆论全体"));
});

test("detectOpponentLineViolation flags 钉认知句 读者应理解 / 主题是", () => {
  const hit = detectOpponentLineViolation(
    "读者应理解这一章的深意,主题是孤独。",
  );
  assert.equal(hit.violated, true);
  assert.ok(hit.matched.includes("读者应理解"));
  assert.ok(hit.matched.includes("主题是"));
});

test("detectOpponentLineViolation does not flag specific-named-opponent writing", () => {
  // 具体对手个体表述: 不命中抽象化整面词
  assert.equal(detectOpponentLineViolation("黄振一个人压住主角,不许他出声。").violated, false);
  assert.equal(detectOpponentLineViolation("三个邻班学生围过来,其中一个推了主角。").violated, false);
  assert.equal(detectOpponentLineViolation("邻班学生甲乙丙三人站住。").violated, false);
});

test("detectOpponentLineViolation handles empty / null / undefined safely", () => {
  assert.deepEqual(detectOpponentLineViolation(""), { violated: false, matched: [] });
  assert.deepEqual(detectOpponentLineViolation(null), { violated: false, matched: [] });
  assert.deepEqual(detectOpponentLineViolation(undefined), { violated: false, matched: [] });
});

test("OPPONENT_LINE_VIOLATION_TERMS covers vault §2 locked opponent-line set", () => {
  const terms = [...OPPONENT_LINE_VIOLATION_TERMS];
  for (const required of [
    "全班", "全校", "全年级", "集体站队", "舆论全体",
    "人情秩序", "秩序说教", "读者应理解", "主题是",
  ]) {
    assert.ok(terms.includes(required), `对手面词表缺 ${required}`);
  }
});

// ---- 接线层: assessChapterExecutionContractShape 集成 ----

function buildPassingCandidate(overrides) {
  return {
    novelId: "novel-test",
    chapterId: "chapter-1",
    chapterOrder: 1,
    title: "第1章",
    summary: "开局压迫",
    purpose: "建立黄振对主角的具体压制。",
    exclusiveEvent: "主角被黄振堵在楼梯口。",
    endingState: "主角决定就地试探底线。",
    nextChapterEntryState: "主角观察黄振次日的反应。",
    conflictLevel: 70,
    revealLevel: 10,
    targetWordCount: 3000,
    mustAvoid: "不要直接连赢,不要暴露主角真实身份。",
    payoffRefs: [],
    taskSheet: [
      "场景: 楼梯口对峙。",
      "在场: 主角、黄振、两三个路人。",
      "主角选择: 是低头走人,还是当场顶回去。",
      "现场压力: 黄振靠墙,主角被逼到扶手边。",
      "禁止: 主角不出手,黄振不大声。",
    ].join("\n"),
    sceneCards: JSON.stringify({
      targetWordCount: 3000,
      lengthBudget: {
        targetWordCount: 3000,
        softMinWordCount: 2550,
        softMaxWordCount: 3450,
        hardMaxWordCount: 3750,
      },
      scenes: [
        { key: "s1", title: "对峙", purpose: "建立压迫",
          mustAdvance: ["黄振现身"], mustPreserve: ["主角不暴露"],
          entryState: "主角下楼", exitState: "主角停下",
          forbiddenExpansion: ["不要写赢"], targetWordCount: 1500 },
        { key: "s2", title: "选择", purpose: "试探",
          mustAdvance: ["主角出声"], mustPreserve: ["不崩人设"],
          entryState: "主角停下", exitState: "主角决定",
          forbiddenExpansion: ["不要直接赢"], targetWordCount: 1500 },
      ],
    }),
    ...overrides,
  };
}

test("assessChapterExecutionContractShape blocks on opponent_line_violation when taskSheet uses 全班集体站队", () => {
  const candidate = buildPassingCandidate({
    taskSheet: "场景: 操场冲突。主角面对全班集体站队的舆论压力,黄振在前面。",
  });
  const result = assessChapterExecutionContractShape(candidate, { settingQualityMode: "enforce" });
  const opponentIssue = result.issues.find((issue) => issue.id === "opponent_line_violation");
  assert.ok(opponentIssue, "应产出 opponent_line_violation issue");
  assert.equal(opponentIssue.severity, "high");
  assert.equal(opponentIssue.target, "task_sheet");
  // high issue → canEnterExecution=false → 进现有 retry 闭环
  assert.equal(result.canEnterExecution, false);
  assert.ok(opponentIssue.summary.includes("全班"));
});

test("assessChapterExecutionContractShape does NOT flag opponent terms declared only in mustAvoid", () => {
  // mustAvoid 是「否定声明域」(整段都用来声明「不要写什么」),并非「正文实际写成的内容」。
  // mustAvoid 里写「不要写舆论全体针对」是作者正确声明禁项,守卫不应在此自我触发——
  // 否则任何正确复述自身禁项的 taskSheet 都会被误命 retry 死循环(生产 cmrr9kpa3 ch1 之 bug)。
  const candidate = buildPassingCandidate({
    mustAvoid: "不要写舆论全体针对主角的单方面叙事;不写全班集体站队;禁人情秩序说教。",
  });
  const result = assessChapterExecutionContractShape(candidate, { settingQualityMode: "enforce" });
  const opponentIssue = result.issues.find((issue) => issue.id === "opponent_line_violation");
  assert.equal(opponentIssue, undefined, "mustAvoid 声明的禁词不应被对手面守卫误命");
  // canEnterExecution 在仅 mustAvoid 含禁词、正文不含时不应因 opponent_line_violation 为 false
  assert.equal(
    result.issues.some((i) => i.id === "opponent_line_violation"),
    false,
  );
});

test("stripNegatedOpponentDeclarations strips 【禁止】-section restated banned terms", () => {
  // 正文是良好具体对手描写;【禁止】段复述禁词是声明,不是违规范文
  const taskSheet = [
    "【本章独占事件】赵明远把失误甩到何屿头上;何屿澄清被堵死。",
    "【现场压力】周凯补一句,林晓推打印件,无人接何屿半句。",
    "【禁止】禁止全班/全校/集体站队或抽象舆论全体针对;禁读者应理解/主题是等钉认知句。",
  ].join("\n");
  const stripped = stripNegatedOpponentDeclarations(taskSheet);
  // 剥后只剩正文,不含任何对手面禁词
  const hit = detectOpponentLineViolation(stripped);
  assert.equal(hit.violated, false, "禁止声明区的禁词应被 strip 掉, 不应残留命中");
  assert.deepEqual(hit.matched, []);
  // 正文痕迹要保留 仍能被读出是「赵明远/周凯/林晓」具体对手
  assert.ok(stripped.includes("赵明远"), "正文具体对手描写不应被 strip 误伤");
});

test("stripNegatedOpponentDeclarations preserves legit 陈述式 violations written in body", () => {
  // 真违规范文:把全班集体站队当正文直接写出来 + 句末钉认知句
  const taskSheet = [
    "【本章独占事件】主角上台汇报,全班集体站队声讨他,舆论全体针对他施压。",
    "【现场压力】全班盯着他不说话,主题是弱肉强食。",
  ].join("\n");
  const stripped = stripNegatedOpponentDeclarations(taskSheet);
  const hit = detectOpponentLineViolation(stripped);
  assert.equal(hit.violated, true, "正文实际写出的整面表述必须仍被守卫命中");
  assert.ok(hit.matched.includes("全班"));
  assert.ok(hit.matched.includes("集体站队"));
  assert.ok(hit.matched.includes("舆论全体"));
  assert.ok(hit.matched.includes("主题是"));
});

test("assessChapterExecutionContractShape passes taskSheet that only restates banned terms in 【禁止】", () => {
  // 正文=具体对手;【禁止】段复述禁词=声明。守卫应剥禁止段后干净放行(对手面维度)。
  const candidate = buildPassingCandidate({
    taskSheet: [
      "【本章独占事件】赵明远公开把失误甩到何屿头上,何屿澄清被材料与话术堵死。",
      "【在场人物】何屿;赵明远;助威冷眼者周凯、林晓各有一句可观察动作。",
      "【现场压力】赵明远指尖点到何屿名字;周凯补一句对接质问;林晓把打印件推到何屿前。",
      "【禁止】禁止全班/全校/集体站队或舆论全体针对;禁人情秩序说教;禁读者应理解/主题是钉认知句。",
    ].join("\n"),
  });
  const result = assessChapterExecutionContractShape(candidate, { settingQualityMode: "enforce" });
  const opponentIssue = result.issues.find((issue) => issue.id === "opponent_line_violation");
  assert.equal(opponentIssue, undefined, "仅在禁止声明里复述禁词不应触发对手面守卫");
});

test("assessChapterExecutionContractShape passes specific-opponent writing without opponent_line_violation", () => {
  // 具体对手个体: 黄振 + 三两路人, 不命中对手面词表
  const candidate = buildPassingCandidate();
  const result = assessChapterExecutionContractShape(candidate, { settingQualityMode: "enforce" });
  const opponentIssue = result.issues.find((issue) => issue.id === "opponent_line_violation");
  assert.equal(opponentIssue, undefined, "具体对手写作不应触发对手面守卫");
});
