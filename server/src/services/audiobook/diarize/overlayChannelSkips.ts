/**
 * 在 LLM 或规则装配结果上叠加非口语通道：typed/chat/on_screen → skip。
 * 解决「LLM 仍把手机字标成旁白/角色」的问题。
 */

import type { AudiobookDialogueSegment } from "@ai-novel/shared/types/audiobook";
import { runRuleSpanPass, type RuleSpan } from "./ruleSpanPass";
import { defaultRenderPolicyForKind } from "./renderPolicy";

function norm(s: string): string {
  return s.replace(/\s+/g, "").trim();
}

function spanToSkipSegment(
  span: RuleSpan,
  template: AudiobookDialogueSegment,
  index: number,
): AudiobookDialogueSegment {
  const kind =
    span.kind === "typed" || span.kind === "chat" || span.kind === "on_screen"
      ? span.kind
      : "typed";
  return {
    ...template,
    index,
    speakerKind: "narrator",
    characterId: null,
    speakerLabel: kind === "typed" ? "打字" : kind === "chat" ? "消息" : "屏幕",
    text: span.text.replace(/\r\n/g, "\n").trim(),
    segmentKind: kind,
    renderPolicy: defaultRenderPolicyForKind(kind),
    channelHint: span.channelHint ?? kind,
    quoteSpanIds: [span.id],
    delivery: null,
    deliveryMergeKey: "none",
    speakerUnresolved: false,
    unresolvedSpeakerName: null,
    diarizeConfidence: 0.8,
  };
}

/** 在原文中定位 skip 正文（带/不带常见引号）。 */
function findSkipHit(raw: string, spanText: string): { hit: string; at: number } | null {
  const trimmed = spanText.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return null;
  const candidates = [
    trimmed,
    `「${trimmed}」`,
    `“${trimmed}”`,
    `"${trimmed}"`,
    `'${trimmed}'`,
    `『${trimmed}』`,
  ];
  let best: { hit: string; at: number } | null = null;
  for (const c of candidates) {
    const at = raw.indexOf(c);
    if (at >= 0 && (best == null || at < best.at)) {
      best = { hit: c, at };
    }
  }
  if (best) return best;

  // 归一化后包含：在 raw 上去空白对齐 needle（仅短 needle，避免误切）
  const needle = norm(trimmed);
  if (needle.length < 2) return null;
  const hay = norm(raw);
  const normAt = hay.indexOf(needle);
  if (normAt < 0) return null;

  // 将 norm 下标映射回 raw：顺序扫 raw 累计非空白
  let normIdx = 0;
  let rawStart = -1;
  let rawEnd = -1;
  for (let i = 0; i < raw.length; i += 1) {
    if (/\s/.test(raw[i]!)) continue;
    if (normIdx === normAt) rawStart = i;
    if (normIdx === normAt + needle.length - 1) {
      rawEnd = i + 1;
      break;
    }
    normIdx += 1;
  }
  if (rawStart < 0 || rawEnd < 0) return null;
  return { hit: raw.slice(rawStart, rawEnd), at: rawStart };
}

/**
 * 将 typed/chat/on_screen span 从可合成段中剥离为 skip 段。
 * - 段文本 ≈ span → 整段改 skip
 * - 段包含 span → 按命中切开
 * - 同一段可被多个 skip span 依次切开（每轮只消费一个 span 的一处命中）
 */
export function overlayChannelSkips(
  content: string,
  segments: AudiobookDialogueSegment[],
): AudiobookDialogueSegment[] {
  const pass = runRuleSpanPass(content);
  const skipSpans = pass.spans.filter(
    (s) => s.kind === "typed" || s.kind === "chat" || s.kind === "on_screen",
  );
  if (skipSpans.length === 0 || segments.length === 0) {
    return segments;
  }

  let result: AudiobookDialogueSegment[] = segments.map((s) => ({ ...s }));

  for (const span of skipSpans) {
    const needle = norm(span.text);
    if (!needle) continue;

    const next: AudiobookDialogueSegment[] = [];
    let consumed = false;

    for (const seg of result) {
      // 已是 skip 通道：不再二次切开
      if (seg.renderPolicy === "skip"
        && (seg.segmentKind === "typed" || seg.segmentKind === "chat" || seg.segmentKind === "on_screen")
      ) {
        next.push(seg);
        continue;
      }

      const hay = norm(seg.text);
      if (!hay || consumed) {
        next.push(seg);
        continue;
      }

      // 整段就是该 span（归一化相等，或 span 几乎占满整段）
      const almostWhole =
        hay === needle
        || (needle.length >= 2 && hay.includes(needle) && needle.length / hay.length >= 0.85);
      if (almostWhole) {
        next.push(spanToSkipSegment(span, seg, next.length));
        consumed = true;
        continue;
      }

      if (!hay.includes(needle)) {
        next.push(seg);
        continue;
      }

      const hitInfo = findSkipHit(seg.text, span.text);
      if (hitInfo == null) {
        next.push(seg);
        continue;
      }

      const { hit, at: hitAt } = hitInfo;
      const raw = seg.text;
      const before = raw.slice(0, hitAt).trim();
      const after = raw.slice(hitAt + hit.length).trim();
      if (before) {
        next.push({
          ...seg,
          index: next.length,
          text: before,
        });
      }
      next.push(spanToSkipSegment(span, seg, next.length));
      if (after) {
        next.push({
          ...seg,
          index: next.length,
          text: after,
          delivery: null,
          deliveryMergeKey: "none",
        });
      }
      consumed = true;
    }

    result = next;
  }

  return result.map((s, i) => ({ ...s, index: i }));
}
