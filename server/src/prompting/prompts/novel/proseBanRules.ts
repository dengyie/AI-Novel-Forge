/**
 * 事中生成侧固定的正文 prose 禁项集合。
 *
 * 背景：prose 规则（prose_system_hud / prose_dash_or_ellipsis / prose_negative_flip
 * / 禁词·废弃术语族）目前主要在 review / qualityLoop 的 Post-processing 评估器
 * （ProseQualityDetector.ts）里事后检查——LLM 生成时看不到这些规则，生成完才被拦。
 * 本节把高频反复触发的 prose 禁项做成**全局固定注入**的 prompt 约束，随每次生成
 * 自动拼入【禁止事项】区块，让生成端从一开始就不犯。评估器保持原样作事后兜底。
 *
 * 维护：增删规则只需改 PROSE_BAN_RULES 数组，renderProseBanBlock 会自动拼进 prompt。
 */
export const PROSE_BAN_RULES: readonly string[] = [
  // prose_system_hud：系统 HUD / 伪状态面板 / 游戏化界面
  "禁止在正文里出现系统 HUD、伪状态面板或游戏化界面描述：不得用全角【】/半角［］括号包裹的键值、字段或状态块（如【HP：100/100】【等级:12】【任务目标：击杀】【冷却中：3秒】【进度条】【技能树】【属性点】等形式），也不得把系统/状态栏/任务栏/进度条/血量/蓝量/经验值/冷却时间等写成可呈现给读者的界面文本。这类信息必须改写成角色可感知的视觉、听觉、触觉或他人口述（例如他看到屏幕跳出红字、听到短促的报错音、闸口指示灯转红），而不是铺排面板原文。",
  // prose_dash_or_ellipsis：破折号 / 省略号滥用表达停顿或犹豫
  "禁止滥用破折号（——）和省略号（……）表达停顿、犹豫或情绪的堆叠；正文里的停顿应优先用动作、句读、人物反应或省略不写的自然节奏带出。只有当确有叙事需要时才零星使用，不得连续、成段地以破折号或省略号制造悬停感。",
  // prose_negative_flip：否定式排比堆砌（不是 A，也不是 B，只是 C）
  "禁止连续使用「没有X，也没有Y，只是Z」或「不是A，而是B」式的否定式排比句堆叠主题；不要用一串否定句式来概念化地解释情绪或处境。需要表达失落、转变或判断时，改为具体动作、感官细节或角色自己的直觉反应。",
  // 禁词 / 废弃术语族：sot_banned_term + styleTone 禁词 + 工程/创作术语泄漏
  "禁止使用 SoT 禁词、世界观与风格 Tone 明确废弃的术语族，以及写作/工程向的元叙述词（细纲、情节点、任务单、目标情绪、功能兑付、验收检查、must_hit_now、scene card、系统提示词、修复指令 等）：这些词即使以「角色在说」的方式复述也不得进入正文，一律改成世界观内可感知的动作、信息或对话。",
];

/**
 * 渲染固定 prose 禁项区块文本（用于拼入生成 prompt 的【禁止事项】）。
 * 每项一行「- …」，前端排版友好；空规则被过滤。
 */
export function renderProseBanBlock(): string {
  const cmd = Array.from(
    PROSE_BAN_RULES.map((rule) => rule.trim()).filter((rule) => rule.length > 0),
  );
  if (cmd.length === 0) {
    return "";
  }
  return `【正文 prose 禁项】\n${cmd.map((rule) => `- ${rule}`).join("\n")}`;
}