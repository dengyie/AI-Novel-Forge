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

/**
 * 将 typed/chat/on_screen span 从可合成段中剥离为 skip 段。
 * - 段文本 ≈ span → 整段改 skip
 * - 段包含 span → 尝试按「…」切开（简单 split）
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
      const hay = norm(seg.text);
      if (!hay || consumed) {
        next.push(seg);
        continue;
      }

      // 整段就是该 span（或几乎）
      if (hay === needle || (needle.length >= 2 && hay === needle)) {
        next.push(spanToSkipSegment(span, seg, next.length));
        consumed = true;
        continue;
      }

      // 段内包含 span 原文（带引号或不带）
      const raw = seg.text;
      const candidates = [
        span.text,
        `「${span.text}」`,
        `“${span.text}”`,
        `"${span.text}"`,
      ];
      let hit: string | null = null;
      let hitAt = -1;
      for (const c of candidates) {
        const at = raw.indexOf(c);
        if (at >= 0) {
          hit = c;
          hitAt = at;
          break;
        }
      }
      if (hit == null || hitAt < 0) {
        next.push(seg);
        continue;
      }

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
