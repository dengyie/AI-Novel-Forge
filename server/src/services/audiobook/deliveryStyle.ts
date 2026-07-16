/**
 * 段级语境表演：归一化 / 校验 / 编译 / 合并桶 / 合成注入。
 * SoT: docs/plans/audiobook-segment-delivery-style-plan.md §5.2
 *
 * 失败策略：normalize 非法 → null；永不抛到整章旁白。
 */

import {
  isDeliveryStyleMode,
  type AudiobookDialogueSegment,
  type AudiobookSegmentDelivery,
  type AudiobookTtsMode,
  type DeliveryIntensity,
  type DeliveryPitchMove,
  type DeliveryRate,
  type DeliveryStyleMode,
  type DeliveryVocalEffort,
} from "@ai-novel/shared/types/audiobook";

export const STABILITY_GUARD =
  "保持该角色声线与身份一致，吐字清楚，不要模仿旁白腔，不要唱歌，不要串戏到其他角色。";

export const DELIVERY_LINE_MAX = 120;
export const BASE_STYLE_PREFER_MAX = 120;
export const MIMO_USER_MAX = 280;

const INTENSITIES = new Set<DeliveryIntensity>(["low", "mid", "high"]);
const EFFORTS = new Set<DeliveryVocalEffort>([
  "whisper",
  "soft",
  "normal",
  "raised",
  "strained",
]);
const RATES = new Set<DeliveryRate>(["slow", "measured", "normal", "fast", "rushed"]);
const PITCHES = new Set<DeliveryPitchMove>(["lowered", "stable", "lifted", "cracked"]);

/** 空话 / 无效表演词表 */
const EMPTY_PHRASE_RE =
  /有感情|生动|自然|请朗读|情绪到位|丰富|很好地|饱满|动人|感人|请用|带感情|充满感情|情感丰富|语气自然|声情并茂/;

/** intensity≠high 时 strip 的过戏词 */
const OVERACT_RE = /嘶吼|哭喊|崩溃|撕心裂肺|声嘶力竭|歇斯底里|鬼哭狼嚎|痛哭失声|大吼大叫/;

const EFFORT_WORDS: Record<DeliveryVocalEffort, string> = {
  whisper: "气声耳语",
  soft: "压低音量",
  normal: "正常音量",
  raised: "略抬音量",
  strained: "咬紧发力",
};

const RATE_WORDS: Record<DeliveryRate, string> = {
  slow: "偏慢",
  measured: "沉稳",
  normal: "中等",
  fast: "偏快",
  rushed: "急促",
};

const PITCH_WORDS: Record<DeliveryPitchMove, string> = {
  lowered: "音高压低",
  stable: "音高平稳",
  lifted: "音高上扬",
  cracked: "音高微裂",
};

/** emotion 族：用于 mergeKey 桶，避免近义情绪拆碎 chunk */
const EMOTION_FAMILY_RULES: Array<{ family: string; needles: string[] }> = [
  { family: "anger", needles: ["怒", "愤", "恼", "火", "恨", "怨"] },
  { family: "fear", needles: ["惧", "慌", "恐", "怕", "惊", "怯"] },
  { family: "sad", needles: ["悲", "哀", "伤", "郁", "痛", "丧", "凄"] },
  { family: "joy", needles: ["喜", "乐", "欢", "兴", "悦", "甜"] },
  { family: "tender", needles: ["柔", "温", "怜", "亲", "软"] },
  { family: "cold", needles: ["冷", "淡", "疏", "漠", "硬"] },
  { family: "tense", needles: ["紧", "压", "克制", "压抑", "紧绷"] },
  { family: "calm", needles: ["静", "平", "稳", "淡定", "从容"] },
  { family: "shame", needles: ["羞", "愧", "耻", "窘"] },
  { family: "disgust", needles: ["厌", "恶", "嫌", "腻"] },
];

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function clip(value: string, max: number): string {
  const t = value.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function readString(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return clip(t, max);
}

function readStringArray(raw: unknown, maxItems: number, itemMax: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = clip(item, itemMax);
    if (!t) continue;
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function readEnum<T extends string>(raw: unknown, allowed: Set<T>, fallback: T): T {
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase() as T;
    if (allowed.has(t)) return t;
  }
  return fallback;
}

function readOptionalEnum<T extends string>(
  raw: unknown,
  allowed: Set<T>,
): T | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase() as T;
  return allowed.has(t) ? t : null;
}

/**
 * 非法/空 → null；永不抛。
 * Core 缺省补默认；Extended 有值才保留。
 */
export function normalizeDelivery(raw: unknown): AudiobookSegmentDelivery | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const primaryEmotion = readString(obj.primaryEmotion, 24);
  const surfaceTone = readString(obj.surfaceTone, 32);
  const intent = readString(obj.intent, 40);

  // 至少要有情绪核或表面语气之一，否则视为无有效表演
  if (!primaryEmotion && !surfaceTone) {
    return null;
  }

  const intensity = readEnum(obj.intensity, INTENSITIES, "mid");
  const vocalEffort = readEnum(obj.vocalEffort, EFFORTS, "normal");
  const rate = readEnum(obj.rate, RATES, "normal");

  const delivery: AudiobookSegmentDelivery = {
    primaryEmotion: primaryEmotion || surfaceTone || "克制",
    intensity,
    surfaceTone: surfaceTone || primaryEmotion || "平稳",
    intent: intent || "把话说清楚",
    vocalEffort,
    rate,
  };

  const maskOrLeak = readString(obj.maskOrLeak, 32);
  if (maskOrLeak) delivery.maskOrLeak = maskOrLeak;

  const secondaryTraits = readStringArray(obj.secondaryTraits, 3, 24);
  if (secondaryTraits.length > 0) {
    delivery.secondaryTraits = filterTraitsAgainstEmotion(
      secondaryTraits,
      delivery.primaryEmotion,
    );
  }

  const addresseeRelation = readString(obj.addresseeRelation, 24);
  if (addresseeRelation) delivery.addresseeRelation = addresseeRelation;

  const subtext = readString(obj.subtext, 40);
  if (subtext) delivery.subtext = subtext;

  const sceneSpace = readString(obj.sceneSpace, 32);
  if (sceneSpace) delivery.sceneSpace = sceneSpace;

  const scenePressure = readString(obj.scenePressure, 32);
  if (scenePressure && scenePressure !== sceneSpace) {
    delivery.scenePressure = scenePressure;
  }

  const pitchMove = readOptionalEnum(obj.pitchMove, PITCHES);
  if (pitchMove) delivery.pitchMove = pitchMove;

  const pauseBreath = readString(obj.pauseBreath, 32);
  if (pauseBreath) delivery.pauseBreath = pauseBreath;

  const articulation = readString(obj.articulation, 32);
  if (articulation) delivery.articulation = articulation;

  const nonverbalCue = readString(obj.nonverbalCue, 24);
  if (nonverbalCue) delivery.nonverbalCue = nonverbalCue;

  const continuityFrom = readString(obj.continuityFrom, 40);
  if (continuityFrom) delivery.continuityFrom = continuityFrom;

  const rawFactors = readStringArray(obj.rawFactors, 6, 24);
  if (rawFactors.length > 0) delivery.rawFactors = rawFactors;

  const deliveryLine = readString(obj.deliveryLine, DELIVERY_LINE_MAX);
  if (deliveryLine) delivery.deliveryLine = deliveryLine;

  return delivery;
}

function filterTraitsAgainstEmotion(traits: string[], emotion: string): string[] {
  const e = emotion.trim();
  return traits.filter((t) => {
    if (!t) return false;
    if (t === e) return false;
    // 同义撞车：trait 是 emotion 子串或反过来且长度接近
    if (e.includes(t) || t.includes(e)) return false;
    return true;
  });
}

/**
 * 模型 deliveryLine 是否采用。失败 → 丢弃模型句，走 compileDeliveryLine。
 */
export function validateDeliveryLine(
  d: AudiobookSegmentDelivery,
  spokenText: string,
): boolean {
  const line = d.deliveryLine?.trim() ?? "";
  if (line.length < 12 || line.length > DELIVERY_LINE_MAX) {
    return false;
  }
  if (EMPTY_PHRASE_RE.test(line)) {
    return false;
  }
  if (hasLongOverlap(line, spokenText, 8)) {
    return false;
  }
  if (!weakEmotionRelated(line, d.primaryEmotion)) {
    return false;
  }
  if (!hasVocalOrToneCue(line, d)) {
    return false;
  }
  return true;
}

function stripForOverlap(value: string): string {
  // 去空白与常见中英文标点，避免「快点走，这里」vs「快点走这里」漏检复述
  return value
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）【】《》…—,\.!?;:'"()\-]/g, "");
}

function hasLongOverlap(line: string, spoken: string, minLen: number): boolean {
  const a = stripForOverlap(line);
  const b = stripForOverlap(spoken || "");
  if (a.length < minLen || b.length < minLen) return false;
  for (let i = 0; i <= b.length - minLen; i += 1) {
    const slice = b.slice(i, i + minLen);
    if (a.includes(slice)) return true;
  }
  return false;
}

function weakEmotionRelated(line: string, emotion: string): boolean {
  const e = emotion.trim();
  if (!e) return true;
  if (line.includes(e)) return true;
  // 族级命中
  const family = emotionFamily(e);
  if (family !== "other") {
    const rule = EMOTION_FAMILY_RULES.find((r) => r.family === family);
    if (rule && rule.needles.some((n) => line.includes(n))) {
      return true;
    }
  }
  // 表面相关：至少含 1 个情绪字
  for (const ch of e) {
    if (ch.length === 1 && /[一-鿿]/.test(ch) && line.includes(ch)) {
      return true;
    }
  }
  return false;
}

function hasVocalOrToneCue(line: string, d: AudiobookSegmentDelivery): boolean {
  if (d.surfaceTone && line.includes(d.surfaceTone)) return true;
  const cues = [
    EFFORT_WORDS[d.vocalEffort],
    RATE_WORDS[d.rate],
    "语速",
    "音量",
    "压低",
    "气声",
    "急促",
    "沉稳",
    "停顿",
    "咬字",
    "音高",
    "轻声",
    "抬声",
  ];
  if (d.pitchMove) cues.push(PITCH_WORDS[d.pitchMove]);
  if (d.pauseBreath) cues.push(d.pauseBreath);
  if (d.articulation) cues.push(d.articulation);
  return cues.some((c) => c && line.includes(c));
}

/**
 * 字段 → 可执行 deliveryLine（≤120）。
 */
export function compileDeliveryLine(d: AudiobookSegmentDelivery): string {
  const parts: string[] = [];

  const headBits: string[] = [];
  if (d.surfaceTone) headBits.push(`${d.surfaceTone}地`);
  if (d.primaryEmotion) {
    const intensityNote = d.intensity === "mid" ? "" : `（${d.intensity}）`;
    headBits.push(`${d.primaryEmotion}${intensityNote}`);
  }
  if (d.maskOrLeak) headBits.push(d.maskOrLeak);
  if (headBits.length > 0) {
    parts.push(headBits.join("，") + "。");
  }

  if (d.intent) {
    parts.push(`意图：${d.intent}。`);
  }
  if (d.subtext) {
    parts.push(d.subtext.endsWith("。") ? d.subtext : `${d.subtext}。`);
  }

  const voiceBits: string[] = [EFFORT_WORDS[d.vocalEffort], `语速${RATE_WORDS[d.rate]}`];
  if (d.pitchMove) voiceBits.push(PITCH_WORDS[d.pitchMove]);
  if (d.pauseBreath) voiceBits.push(d.pauseBreath);
  if (d.articulation) voiceBits.push(d.articulation);
  parts.push(`${voiceBits.join("、")}。`);

  if (d.sceneSpace || d.scenePressure) {
    const scene = [d.sceneSpace, d.scenePressure].filter(Boolean).join("，");
    parts.push(`${scene}。`);
  }
  if (d.addresseeRelation) {
    parts.push(`${d.addresseeRelation}。`);
  }
  if (d.continuityFrom) {
    parts.push(`${d.continuityFrom}。`);
  }
  if (d.nonverbalCue) {
    parts.push(`${d.nonverbalCue}。`);
  }
  if (d.secondaryTraits && d.secondaryTraits.length > 0) {
    parts.push(`兼：${d.secondaryTraits.join("、")}。`);
  }

  let line = parts.join("").replace(/。。+/g, "。");
  line = stripOveract(line, d.intensity);
  line = stripEmptyPhrases(line);
  return clip(line, DELIVERY_LINE_MAX);
}

function stripOveract(line: string, intensity: DeliveryIntensity): string {
  if (intensity === "high") return line;
  return line.replace(OVERACT_RE, "").replace(/，{2,}/g, "，").replace(/。{2,}/g, "。");
}

function stripEmptyPhrases(line: string): string {
  return line.replace(EMPTY_PHRASE_RE, "").replace(/，{2,}/g, "，").replace(/。{2,}/g, "。").trim();
}

export function emotionFamily(primaryEmotion: string): string {
  const e = primaryEmotion.trim();
  if (!e) return "other";
  for (const rule of EMOTION_FAMILY_RULES) {
    if (rule.needles.some((n) => e.includes(n))) {
      return rule.family;
    }
  }
  return "other";
}

/**
 * 合并桶：emotion族|intensity|vocalEffort|rate
 * null delivery → "none"
 */
export function deliveryMergeKey(d: AudiobookSegmentDelivery | null | undefined): string {
  if (!d) return "none";
  return `${emotionFamily(d.primaryEmotion)}|${d.intensity}|${d.vocalEffort}|${d.rate}`;
}

/**
 * 取最终注入句：优先校验通过的模型句，否则 compile。
 */
export function resolveDeliveryLine(
  d: AudiobookSegmentDelivery,
  spokenText: string,
): string {
  if (d.deliveryLine && validateDeliveryLine(d, spokenText)) {
    return stripOveract(stripEmptyPhrases(clip(d.deliveryLine, DELIVERY_LINE_MAX)), d.intensity);
  }
  return compileDeliveryLine(d);
}

export interface ResolveSynthesizeInputResult {
  style?: string | null;
  designPrompt?: string | null;
}

export interface ResolveSynthesizeSegmentInput {
  ttsMode?: AudiobookTtsMode | string | null;
  baseStyle?: string | null;
  baseDesignPrompt?: string | null;
  style?: string | null;
  designPrompt?: string | null;
  delivery?: AudiobookSegmentDelivery | null;
  text?: string;
}

/**
 * 合成入口唯一解析：
 * - preset/clone：style = base + 本句表演 + guard；designPrompt 透传
 * - design：designPrompt = baseDesign + 表演指令 + guard；style 可审计
 * - off / 无 delivery：返回静态 base
 */
export function resolveSynthesizeInput(
  segment: ResolveSynthesizeSegmentInput,
  options?: { deliveryStyleMode?: DeliveryStyleMode | null },
): ResolveSynthesizeInputResult {
  const mode = (segment.ttsMode?.trim() || "preset") as string;
  const baseStyle = (segment.baseStyle ?? segment.style ?? "").trim() || null;
  const baseDesign =
    (segment.baseDesignPrompt ?? (mode === "design" ? segment.designPrompt : null) ?? "")
      .trim() || null;

  // 仅显式 off 时忽略已落库的 delivery；缺省/characters/all 均按字段存在与否注入。
  // 任务默认 off 的门禁在 annotate/applyDelivery，不在合成再 fail-open 剥字段。
  const delivery =
    options?.deliveryStyleMode === "off" ? null : segment.delivery ?? null;

  if (!delivery) {
    if (mode === "design") {
      return {
        style: baseStyle,
        designPrompt: baseDesign,
      };
    }
    return {
      style: baseStyle,
      designPrompt: segment.designPrompt ?? null,
    };
  }

  const line = resolveDeliveryLine(delivery, segment.text ?? "");

  if (mode === "design") {
    const designPrompt = buildDesignUser(baseDesign, line);
    return {
      style: baseStyle,
      designPrompt,
    };
  }

  // preset / clone
  const style = buildPresetCloneUser(baseStyle, line);
  return {
    style,
    designPrompt: segment.designPrompt ?? baseDesign,
  };
}

function buildPresetCloneUser(baseStyle: string | null, line: string): string {
  const base = clip(baseStyle || "", BASE_STYLE_PREFER_MAX);
  const performance = clip(`本句表演：${line}`, DELIVERY_LINE_MAX + 6);
  const guard = STABILITY_GUARD;
  // base 优先，再表演，再 guard；总长 ≤280
  let out = [base, performance, guard].filter(Boolean).join("\n");
  if (out.length <= MIMO_USER_MAX) {
    return out;
  }
  // 先压表演
  const budgetForLine = Math.max(
    24,
    MIMO_USER_MAX - base.length - guard.length - 16,
  );
  const shortPerf = clip(`本句表演：${line}`, budgetForLine);
  out = [base, shortPerf, guard].filter(Boolean).join("\n");
  if (out.length <= MIMO_USER_MAX) {
    return out;
  }
  // 再压 base
  const budgetForBase = Math.max(
    16,
    MIMO_USER_MAX - shortPerf.length - guard.length - 4,
  );
  return [clip(base, budgetForBase), shortPerf, guard].filter(Boolean).join("\n");
}

function buildDesignUser(baseDesign: string | null, line: string): string {
  const base = (baseDesign || "").trim();
  const performance = `表演指令：${clip(line, DELIVERY_LINE_MAX)}`;
  const guard = STABILITY_GUARD;
  let out = [base, performance, guard].filter(Boolean).join("\n\n");
  if (out.length <= MIMO_USER_MAX) {
    return out;
  }
  // design 也限制 280：优先保 base 前段 + 表演 + guard
  const budgetForBase = Math.max(
    40,
    MIMO_USER_MAX - performance.length - guard.length - 8,
  );
  return [clip(base, budgetForBase), performance, guard].filter(Boolean).join("\n\n");
}

/**
 * 解析 createTask / env 的 deliveryStyleMode；非法 → off。
 * 优先级：显式入参 > env > 代码默认 off
 */
export function resolveDeliveryStyleMode(
  explicit?: string | null,
  envValue?: string | null,
): DeliveryStyleMode {
  if (explicit && isDeliveryStyleMode(explicit.trim())) {
    return explicit.trim() as DeliveryStyleMode;
  }
  const fromEnv = (envValue ?? process.env.AUDIOBOOK_DELIVERY_STYLE_MODE ?? "").trim();
  if (fromEnv && isDeliveryStyleMode(fromEnv)) {
    return fromEnv as DeliveryStyleMode;
  }
  return "off";
}

/**
 * 该段是否应尝试保留/请求 delivery（按 mode + speakerKind）。
 */
export function shouldApplyDelivery(
  mode: DeliveryStyleMode,
  speakerKind: "narrator" | "character",
): boolean {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return speakerKind === "character";
}

/**
 * 布局指纹部件（供 Pipeline 与单测共用）。
 * D11：必须含 style + designPrompt。
 */
export function fingerprintStyleParts(segment: {
  style?: string | null;
  designPrompt?: string | null;
}): { style: string; designPrompt: string } {
  return {
    style: segment.style ?? "",
    designPrompt: segment.designPrompt ?? "",
  };
}

/**
 * 旁白 mode=all 轻量叙述句（§7.3）；不抢角色、不演戏。
 */
export function compileNarratorDeliveryLine(d: AudiobookSegmentDelivery): string {
  const rateWord = RATE_WORDS[d.rate] || "中等";
  const tone = d.surfaceTone || "平稳";
  const emotion = d.primaryEmotion || "克制";
  const intensity = d.intensity || "mid";
  const line = `${tone}，${emotion}（${intensity}），语速${rateWord}；像有声书旁白，不抢角色，不演戏。`;
  return clip(stripEmptyPhrases(stripOveract(line, intensity)), DELIVERY_LINE_MAX);
}

function buildNarratorUser(baseStyle: string | null, line: string): string {
  const base = clip(baseStyle || "", BASE_STYLE_PREFER_MAX);
  const performance = clip(`本句叙述：${line}`, DELIVERY_LINE_MAX + 6);
  let out = [base, performance].filter(Boolean).join("\n");
  if (out.length <= MIMO_USER_MAX) return out;
  const budget = Math.max(24, MIMO_USER_MAX - base.length - 4);
  return [base, clip(performance, budget)].filter(Boolean).join("\n");
}

export function applyDeliveryToSegment(
  segment: AudiobookDialogueSegment,
  rawDelivery: unknown,
  options: {
    deliveryStyleMode: DeliveryStyleMode;
    baseStyle?: string | null;
    baseDesignPrompt?: string | null;
  },
): AudiobookDialogueSegment {
  const baseStyle = (options.baseStyle ?? segment.style ?? null) || null;
  const baseDesignPrompt =
    (options.baseDesignPrompt ?? segment.designPrompt ?? null) || null;

  const apply = shouldApplyDelivery(options.deliveryStyleMode, segment.speakerKind);
  const delivery = apply ? normalizeDelivery(rawDelivery) : null;
  const mergeKey = deliveryMergeKey(delivery);

  // 旁白 all：轻量「本句叙述」通道，不用角色「本句表演」模板
  if (delivery && segment.speakerKind === "narrator") {
    const line = delivery.deliveryLine && validateDeliveryLine(delivery, segment.text)
      ? stripOveract(stripEmptyPhrases(clip(delivery.deliveryLine, DELIVERY_LINE_MAX)), delivery.intensity)
      : compileNarratorDeliveryLine(delivery);
    return {
      ...segment,
      baseStyle,
      baseDesignPrompt,
      delivery,
      deliveryMergeKey: mergeKey,
      style: buildNarratorUser(baseStyle, line),
      designPrompt: baseDesignPrompt,
    };
  }

  const resolved = resolveSynthesizeInput(
    {
      ttsMode: segment.ttsMode,
      baseStyle,
      baseDesignPrompt,
      style: baseStyle,
      designPrompt: baseDesignPrompt,
      delivery,
      text: segment.text,
    },
    { deliveryStyleMode: options.deliveryStyleMode },
  );

  return {
    ...segment,
    baseStyle,
    baseDesignPrompt,
    delivery,
    deliveryMergeKey: mergeKey,
    style: resolved.style ?? baseStyle,
    designPrompt: resolved.designPrompt ?? baseDesignPrompt,
  };
}

/**
 * D8：按 characterId 顺序，空 continuityFrom 时补「承接上句（{emotion}）」。
 * 补全后重新 resolve style/design，使注入句含承接。旁白跳过。
 */
export function fillContinuityFrom(
  segments: AudiobookDialogueSegment[],
  options?: { deliveryStyleMode?: DeliveryStyleMode | null },
): AudiobookDialogueSegment[] {
  const lastEmotionByCharacter = new Map<string, string>();
  const mode = options?.deliveryStyleMode ?? null;
  return segments.map((seg) => {
    if (seg.speakerKind !== "character" || !seg.characterId || !seg.delivery) {
      return seg;
    }
    const prevEmotion = lastEmotionByCharacter.get(seg.characterId);
    lastEmotionByCharacter.set(seg.characterId, seg.delivery.primaryEmotion);
    if (seg.delivery.continuityFrom?.trim() || !prevEmotion) {
      return seg;
    }
    const continuityFrom = clip(`承接上句（${prevEmotion}）`, 40);
    const delivery = { ...seg.delivery, continuityFrom };
    const resolved = resolveSynthesizeInput(
      {
        ttsMode: seg.ttsMode,
        baseStyle: seg.baseStyle ?? seg.style,
        baseDesignPrompt: seg.baseDesignPrompt ?? seg.designPrompt,
        style: seg.baseStyle ?? seg.style,
        designPrompt: seg.baseDesignPrompt ?? seg.designPrompt,
        delivery,
        text: seg.text,
      },
      mode != null ? { deliveryStyleMode: mode } : undefined,
    );
    return {
      ...seg,
      delivery,
      style: resolved.style ?? seg.style,
      designPrompt: resolved.designPrompt ?? seg.designPrompt,
    };
  });
}

export interface DeliveryChapterStatsInput {
  segments: AudiobookDialogueSegment[];
  /** 模型 raw delivery 是否曾尝试（按段 index 对齐可选；无则仅统计最终 delivery） */
  peeledCount?: number;
  chunkJobCount?: number;
}

/**
 * 章级 delivery 指标。
 * 采用率：有角色段时只算角色（旁白 all 不抬高/扭曲角色率）；全旁白章才用旁白分母。
 */
export function computeDeliveryChapterStats(
  segments: AudiobookDialogueSegment[],
  options?: { peeledCount?: number; chunkJobCount?: number },
): {
  segmentCount: number;
  characterSegmentCount: number;
  narratorSegmentCount: number;
  deliveryApplied: number;
  characterDeliveryApplied: number;
  narratorDeliveryApplied: number;
  deliveryPeeled: number;
  deliveryApplyRate: number;
  avgResolvedUserLen: number;
  mergeChunkMultiplier: number | null;
} {
  const segmentCount = segments.length;
  let characterSegmentCount = 0;
  let narratorSegmentCount = 0;
  let characterDeliveryApplied = 0;
  let narratorDeliveryApplied = 0;
  let userLenSum = 0;
  for (const seg of segments) {
    if (seg.speakerKind === "character") {
      characterSegmentCount += 1;
      if (seg.delivery) characterDeliveryApplied += 1;
    } else {
      narratorSegmentCount += 1;
      if (seg.delivery) narratorDeliveryApplied += 1;
    }
    const user =
      (seg.ttsMode === "design" ? seg.designPrompt : seg.style) || "";
    userLenSum += user.length;
  }
  const deliveryApplied = characterDeliveryApplied + narratorDeliveryApplied;
  const deliveryPeeled = Math.max(0, options?.peeledCount ?? 0);
  let deliveryApplyRate = 0;
  if (characterSegmentCount > 0) {
    deliveryApplyRate = characterDeliveryApplied / characterSegmentCount;
  } else if (narratorSegmentCount > 0) {
    deliveryApplyRate = narratorDeliveryApplied / narratorSegmentCount;
  }
  const avgResolvedUserLen = segmentCount > 0 ? userLenSum / segmentCount : 0;
  const mergeChunkMultiplier =
    typeof options?.chunkJobCount === "number" && segmentCount > 0
      ? options.chunkJobCount / segmentCount
      : null;
  return {
    segmentCount,
    characterSegmentCount,
    narratorSegmentCount,
    deliveryApplied,
    characterDeliveryApplied,
    narratorDeliveryApplied,
    deliveryPeeled,
    deliveryApplyRate: Number(deliveryApplyRate.toFixed(4)),
    avgResolvedUserLen: Number(avgResolvedUserLen.toFixed(1)),
    mergeChunkMultiplier:
      mergeChunkMultiplier == null ? null : Number(mergeChunkMultiplier.toFixed(3)),
  };
}
