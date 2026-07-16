const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProseQualityAuditReport,
  detectProseQuality,
} = require("../dist/services/novel/runtime/proseQuality/ProseQualityDetector.js");

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

function severitiesByCode(report, code) {
  return report.findings
    .filter((finding) => finding.code === code)
    .map((finding) => finding.severity);
}

test("detectProseQuality detects deterministic prose degradation signals", () => {
  const longParagraph = `${"潮声压在城墙外，灯火一层层熄灭，守夜人握紧刀柄。".repeat(12)}。`;
  const report = detectProseQuality([
    "他不是害怕，而是终于明白自己已经没有退路。",
    "门后传来声音——很轻，却像刀锋一样贴着耳骨……",
    "他停下。他抬头。他看门。他推开。他进去。他沉默。",
    longParagraph,
    "同一句话在墙上反复浮现。",
    "同一句话在墙上反复浮现。",
    "作为AI语言模型，我无法继续生成这一章。",
    "（此处省略）",
    "本章的任务单要求章尾钩子更强。",
    "更远处的灯火仍在晃动，像一条没有收束的路",
  ].join("\n"));

  assert.ok(report.hasBlockingFindings);
  const codeSet = new Set(codes(report));
  for (const expected of [
    "prose_negative_flip",
    "prose_period_stutter",
    "prose_long_paragraph",
    "prose_verbatim_repeat",
    "prose_truncation",
    "prose_ai_self_reference",
    "prose_placeholder_leak",
    "prose_engineering_term_leak",
  ]) {
    assert.ok(codeSet.has(expected), `missing ${expected}`);
  }
  assert.ok(severitiesByCode(report, "prose_long_paragraph").includes("medium"));
  // 破折号/省略号改为密度 pass：稀疏时可不记；若记则不得 high/critical。
  const dashSeverities = severitiesByCode(report, "prose_dash_or_ellipsis");
  assert.equal(dashSeverities.includes("high"), false);
  assert.equal(dashSeverities.includes("critical"), false);
  assert.ok(severitiesByCode(report, "prose_ai_self_reference").includes("critical"));
});

test("detectProseQuality keeps common false positives out of blocking findings", () => {
  const report = detectProseQuality([
    "他终于明白，这不是黑就是白的问题，而是每个人都要付出代价。",
    "「作为AI，我会保护你。」银色傀儡抬起头，眼底亮起蓝光。",
    "> 不是冷漠，而是克制。",
    "她在纸上写下完整答案，然后把灯熄灭。",
  ].join("\n"));

  assert.equal(codes(report).includes("prose_negative_flip"), false);
  assert.equal(codes(report).includes("prose_ai_self_reference"), false);
  assert.equal(report.hasBlockingFindings, false);
});


test("sparse Chinese dash and ellipsis density is ignored or non-blocking", () => {
  // 少量合法 ——/……：密度低于 ignore 阈值时可不记 finding；即使记也不得 hard-block。
  const sparse = detectProseQuality([
    "他停顿了一下……随后抬起头。",
    "门后传来声音——很轻，却像刀锋一样贴着耳骨。",
    "她把信折好，放进抽屉，转身离开。",
    "街灯一盏盏亮起，脚步声渐渐远去。",
    "风从巷口灌进来，衣角轻轻扬起。",
  ].join("\n"));
  assert.equal(sparse.hasBlockingFindings, false);
  const sparseDash = severitiesByCode(sparse, "prose_dash_or_ellipsis");
  assert.ok(sparseDash.every((severity) => severity === "low" || severity === "medium"));
  assert.equal(sparseDash.includes("high"), false);
  assert.equal(sparseDash.includes("critical"), false);
});

test("high dash/ellipsis density yields medium debt without hard block", () => {
  const denseBody = Array.from({ length: 12 }, (_, i) => (
    `他停顿——又一次……第${i + 1}次机械停顿——继续往前……`
  )).join("\n");
  const report = detectProseQuality(denseBody);
  assert.ok(codes(report).includes("prose_dash_or_ellipsis"));
  const dashSeverities = severitiesByCode(report, "prose_dash_or_ellipsis");
  assert.ok(dashSeverities.length >= 1);
  assert.ok(dashSeverities.every((severity) => severity === "medium" || severity === "low"));
  assert.equal(dashSeverities.includes("high"), false);
  assert.equal(dashSeverities.includes("critical"), false);
  // 仅有标点密度时不得 hasBlockingFindings
  const onlyDashBlocking = report.findings
    .filter((finding) => finding.severity === "high" || finding.severity === "critical")
    .map((finding) => finding.code);
  assert.equal(onlyDashBlocking.includes("prose_dash_or_ellipsis"), false);
});

test("single natural Chinese negative flip does not block chapter acceptance", () => {
  // 「不是 A，而是 B」网文常见对比；降 medium 后不得 hard-block
  const report = detectProseQuality([
    "他不是害怕，而是终于明白自己已经没有退路。",
    "她把刀收回鞘中，转身走进雨里。",
  ].join("\n"));

  assert.ok(codes(report).includes("prose_negative_flip"));
  const flipSeverities = severitiesByCode(report, "prose_negative_flip");
  assert.ok(flipSeverities.length >= 1);
  assert.ok(flipSeverities.every((severity) => severity === "medium"));
  assert.equal(report.hasBlockingFindings, false);
});

test("buildProseQualityAuditReport maps findings into mode_fit runtime audit issues", () => {
  const report = detectProseQuality("作为AI语言模型，我无法继续生成这一章。后来他只能望着未完成的门");
  const auditReport = buildProseQualityAuditReport({
    novelId: "novel-1",
    chapterId: "chapter-1",
    report,
    now: new Date("2026-07-06T00:00:00.000Z"),
  });

  assert.ok(auditReport);
  assert.equal(auditReport.auditType, "mode_fit");
  assert.equal(auditReport.issues.length >= 1, true);
  assert.equal(auditReport.issues[0].status, "open");
  assert.equal(auditReport.issues[0].auditType, "mode_fit");
  assert.match(auditReport.issues[0].code, /^prose_/);
  assert.equal(auditReport.createdAt, "2026-07-06T00:00:00.000Z");
});

test("detectProseQuality flags sot_banned_term and sot_must_avoid_leak as high blockers", () => {
  const report = detectProseQuality(
    [
      "他推开门，看见了禁忌语：源核熔断。",
      "房间里还有一个叫作内部代号X的装置。",
    ].join("\n"),
    {
      bannedTerms: ["源核熔断"],
      mustAvoidTerms: ["内部代号X"],
    },
  );
  assert.ok(codes(report).includes("sot_banned_term"));
  assert.ok(codes(report).includes("sot_must_avoid_leak"));
  assert.equal(report.hasBlockingFindings, true);
  assert.ok(severitiesByCode(report, "sot_banned_term").includes("high"));
  assert.ok(severitiesByCode(report, "sot_must_avoid_leak").includes("high"));
});

test("detectProseQuality with empty SoT options keeps legacy prose-only behavior", () => {
  const clean = detectProseQuality("潮声压在城墙外，守夜人握紧刀柄。", {
    bannedTerms: [],
    mustAvoidTerms: [],
  });
  assert.equal(codes(clean).some((code) => code.startsWith("sot_")), false);
  assert.equal(clean.hasBlockingFindings, false);
});

test("detectProseQuality catches mustAvoid wrapped in book-title marks via normalize", () => {
  const report = detectProseQuality("他使用了禁忌术「裂空斩」。", {
    mustAvoidTerms: ["裂空斩"],
  });
  assert.ok(codes(report).includes("sot_must_avoid_leak"));
  assert.equal(report.hasBlockingFindings, true);
});

test("detectProseQuality flags true system HUD blocks as prose_system_hud", () => {
  const report = detectProseQuality([
    "门轴吱呀一声，他踏入锈蚀的舱室。",
    "【系统提示：检测到宿主异常，状态面板已开启】",
    "【HP：120/120　MP：40/80　冷却：3秒】",
    "他眉头一紧，却把视线移开。",
  ].join("\n"));

  assert.ok(codes(report).includes("prose_system_hud"), `codes=${codes(report).join(",")}`);
  assert.equal(report.hasBlockingFindings, true);
  const hudSeverities = severitiesByCode(report, "prose_system_hud");
  assert.ok(hudSeverities.length >= 1);
  assert.ok(hudSeverities.every((severity) => severity === "high" || severity === "critical"));
});

test("detectProseQuality multi HUD blocks elevate severity to critical", () => {
  const report = detectProseQuality([
    "【系统：任务更新】",
    "【状态：冷却中】",
    "【等级：12　经验：3300】",
    "他收起刀，没有再看那行字。",
  ].join("\n"));
  assert.ok(codes(report).includes("prose_system_hud"));
  assert.equal(report.hasBlockingFindings, true);
  assert.ok(severitiesByCode(report, "prose_system_hud").includes("critical"));
});

test("detectProseQuality ignores harmless fullwidth brackets as short names", () => {
  const report = detectProseQuality([
    "他自称【裂空】，旁人只当是绰号。",
    "地图上标着【北港】两个字。",
    "她把【旧钥】塞进他掌心，没有多说。",
    "他外号【等级】，同伴只当玩笑。",
    "她把那块【冷却】石塞回口袋。",
    "潮声压在城墙外，守夜人握紧刀柄。",
  ].join("\n"));

  assert.equal(codes(report).includes("prose_system_hud"), false, `codes=${codes(report).join(",")}`);
  assert.equal(report.hasBlockingFindings, false);
});

test("detectProseQuality still flags soft keyword + key-value HUD", () => {
  const report = detectProseQuality([
    "舱壁亮起一行字。",
    "【等级:12　冷却:3秒】",
    "他没再看那行字。",
  ].join("\n"));
  assert.ok(codes(report).includes("prose_system_hud"), `codes=${codes(report).join(",")}`);
});

test("detectProseQuality does not treat narrative without brackets as HUD", () => {
  const report = detectProseQuality([
    "系统里没有答案，他只能靠自己。",
    "状态很糟，冷却也谈不上，等级更是笑话。",
    "他推开门，走进雨里。",
  ].join("\n"));
  assert.equal(codes(report).includes("prose_system_hud"), false);
});
