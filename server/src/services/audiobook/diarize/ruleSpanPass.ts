/**
 * 确定性 Rule Span Pass：引号 / 说话语境 / 打字·消息 UI。
 * 不替代 LLM；供 coverage 门禁、L1 assembly、LLM 约束输入。
 */

export type RuleSpanKind =
  | "quote"
  | "typed"
  | "chat"
  | "on_screen"
  | "phone"
  | "speech_attr";

export interface RuleSpan {
  id: string;
  kind: RuleSpanKind;
  /** 半开区间 [start, end) 基于 normalize 后全文 */
  start: number;
  end: number;
  text: string;
  /** 候选说话人（speech_attr / 邻近） */
  speakerHint?: string | null;
  /** 该 quote 是否应出声（typed/chat/on_screen 包裹则为 false） */
  shouldSpeak: boolean;
  channelHint?: string | null;
}

export interface RuleSpanPassResult {
  normalizedContent: string;
  spans: RuleSpan[];
  quoteSpanCount: number;
  spokenQuoteSpanCount: number;
}

const QUOTE_PAIRS: Array<{ open: string; close: string }> = [
  { open: "「", close: "」" },
  { open: "『", close: "』" },
  { open: "“", close: "”" },
  { open: "\"", close: "\"" },
];

/** 打字/输入通道 */
const TYPED_RE =
  /(?:打字|输入|键入|敲下|打出|编辑框|对话框里打|在手机上打|拇指.*(?:敲|打|输)|屏幕上打)/u;

/** 聊天/消息气泡 */
const CHAT_RE =
  /(?:微信|QQ|短信|消息|气泡|聊天记录|对话框|弹窗消息|系统消息|发来一条|发了条|收到一条)/u;

/** 屏幕/告示 */
const ON_SCREEN_RE =
  /(?:屏幕上|告示|字幕|弹窗|界面显示|显示器|投影|PPT|提示框)/u;

/** 电话 */
const PHONE_RE =
  /(?:电话|听筒|那头|那端|接通|挂断|来电)/u;

/** 说话归属：X说/道/问 …「 */
const SPEECH_ATTR_BEFORE =
  /([一-鿿·]{1,12}?)(?:有些|略|轻|冷|笑着|低声|大声)?(?:说|道|问|喊|叫|答|回|斥|骂|嘲|嘀咕|嘟囔|冷笑|笑道|问道|说道)[道着]?[：:\s「"“]*$/u;

const SPEECH_ATTR_AFTER =
  /^[」"”]?\s*([一-鿿·]{1,12}?)(?:有些|略|轻|冷|笑着|低声)?(?:说|道|问|喊|叫|答)[道着]?/u;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function windowBefore(text: string, index: number, size = 36): string {
  return text.slice(Math.max(0, index - size), index);
}

function windowAfter(text: string, index: number, size = 28): string {
  return text.slice(index, Math.min(text.length, index + size));
}

/**
 * 通道判定只看引号**前**的近邻（同句/同行优先），禁止用 after 全文窗口，
 * 否则后文「打字/微信」会污染前面的对白 quote。
 */
function detectChannelAround(
  content: string,
  start: number,
  end: number,
): { kind: RuleSpanKind; shouldSpeak: boolean; channelHint: string | null; speakerHint: string | null } {
  const before = windowBefore(content, start, 48);
  // 仅取 after 很短，且用于「X说」后置归属，不做 typed/chat 判定
  const after = windowAfter(content, end, 16);
  // 同行前缀：从最近换行到引号
  const lineStart = Math.max(0, before.lastIndexOf("\n") + 1);
  const sameLineBefore = before.slice(lineStart);

  // 通道词优先看同行，其次 before 窗口（仍不含 after）
  const channelCtx = sameLineBefore.length >= 2 ? sameLineBefore : before;

  if (TYPED_RE.test(channelCtx)) {
    return { kind: "typed", shouldSpeak: false, channelHint: "typed", speakerHint: null };
  }
  if (CHAT_RE.test(channelCtx)) {
    return { kind: "chat", shouldSpeak: false, channelHint: "chat", speakerHint: null };
  }
  if (ON_SCREEN_RE.test(channelCtx)) {
    return { kind: "on_screen", shouldSpeak: false, channelHint: "on_screen", speakerHint: null };
  }
  if (PHONE_RE.test(channelCtx)) {
    const m = channelCtx.match(SPEECH_ATTR_BEFORE);
    return {
      kind: "phone",
      shouldSpeak: true,
      channelHint: "phone",
      speakerHint: m?.[1]?.trim() || null,
    };
  }

  const beforeAttr = before.match(SPEECH_ATTR_BEFORE);
  if (beforeAttr?.[1]) {
    return {
      kind: "quote",
      shouldSpeak: true,
      channelHint: "speech",
      speakerHint: beforeAttr[1].trim(),
    };
  }
  const afterAttr = after.match(SPEECH_ATTR_AFTER);
  if (afterAttr?.[1]) {
    return {
      kind: "quote",
      shouldSpeak: true,
      channelHint: "speech",
      speakerHint: afterAttr[1].trim(),
    };
  }

  return { kind: "quote", shouldSpeak: true, channelHint: "quote", speakerHint: null };
}

/**
 * 扫描成对引号；同对可嵌套简单处理（找最近 close）。
 */
export function runRuleSpanPass(content: string): RuleSpanPassResult {
  const normalizedContent = normalizeContent(content);
  const spans: RuleSpan[] = [];
  let seq = 0;

  for (const { open, close } of QUOTE_PAIRS) {
    let i = 0;
    while (i < normalizedContent.length) {
      const startOpen = normalizedContent.indexOf(open, i);
      if (startOpen < 0) break;
      const innerStart = startOpen + open.length;
      const closeAt = normalizedContent.indexOf(close, innerStart);
      if (closeAt < 0) {
        i = innerStart;
        continue;
      }
      const inner = normalizedContent.slice(innerStart, closeAt);
      // 跳过空/过短无字
      if (inner.trim().length === 0) {
        i = closeAt + close.length;
        continue;
      }
      // 避免把「」与 "" 重复覆盖同一区间：若已有 span 覆盖同 start，跳过
      const already = spans.some(
        (s) => s.start === innerStart && s.end === closeAt,
      );
      if (already) {
        i = closeAt + close.length;
        continue;
      }

      const channel = detectChannelAround(normalizedContent, startOpen, closeAt + close.length);
      const id = `qs${seq++}`;
      spans.push({
        id,
        kind: channel.kind === "quote" ? "quote" : channel.kind,
        start: innerStart,
        end: closeAt,
        text: inner,
        speakerHint: channel.speakerHint,
        shouldSpeak: channel.shouldSpeak,
        channelHint: channel.channelHint,
      });
      i = closeAt + close.length;
    }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const quoteLike = spans.filter((s) =>
    s.kind === "quote" || s.kind === "typed" || s.kind === "chat"
    || s.kind === "on_screen" || s.kind === "phone"
  );
  const spoken = quoteLike.filter((s) => s.shouldSpeak);

  return {
    normalizedContent,
    spans,
    quoteSpanCount: quoteLike.length,
    spokenQuoteSpanCount: spoken.length,
  };
}
