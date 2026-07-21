import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { briefSummary, extractFacts } from "../novel/novelP0Utils";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { stateSnapshotPrompt } from "../../prompting/prompts/state/state.prompts";

export interface StateServiceOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  skipPayoffLedgerSync?: boolean;
}

interface CharacterStateOutput {
  characterId?: string;
  characterName?: string;
  currentGoal?: string;
  emotion?: string;
  stressLevel?: number;
  secretExposure?: string;
  knownFacts?: string[];
  misbeliefs?: string[];
  summary?: string;
}

interface RelationStateOutput {
  sourceCharacterId?: string;
  sourceCharacterName?: string;
  targetCharacterId?: string;
  targetCharacterName?: string;
  trustScore?: number;
  intimacyScore?: number;
  conflictScore?: number;
  dependencyScore?: number;
  summary?: string;
}

interface InformationStateOutput {
  holderType?: string;
  holderRefId?: string | null;
  holderRefName?: string | null;
  fact?: string;
  status?: string;
  summary?: string;
}

interface ForeshadowStateOutput {
  title?: string;
  summary?: string;
  status?: string;
  setupChapterId?: string;
  payoffChapterId?: string | null;
}

export interface SnapshotExtractionOutput {
  summary?: string;
  characterStates?: CharacterStateOutput[];
  relationStates?: RelationStateOutput[];
  informationStates?: InformationStateOutput[];
  foreshadowStates?: ForeshadowStateOutput[];
}

export interface StateSnapshotExtractionInput {
  novelId: string;
  chapter: { id: string; title: string; order: number; expectation: string | null };
  content: string;
  characters: Array<{ id: string; name: string; currentGoal: string | null; currentState: string | null; role: string }>;
  summaryRow: { summary: string; keyEvents: string | null; characterStates: string | null; hook: string | null } | null;
  factRows: Array<{ category: string; content: string }>;
  timelineRows: Array<{ characterId: string; content: string }>;
  // previousSnapshot 字段与 StateService.getLatestSnapshotBeforeChapter 返回形状对齐：
  // 携带完整上一章快照，extract 侧负责把角色/关系/信息/伏笔紧凑文本注入 prompt，
  // 让 LLM 能「继承未变化状态 + 提取本章增量」，避免每章快照丢前章信息态/伏笔。
  previousSnapshot: {
    summary?: string | null;
    characterStates?: Array<{ characterId?: string | null; summary?: string | null }>;
    relationStates?: Array<{ sourceCharacterId?: string | null; targetCharacterId?: string | null; summary?: string | null }>;
    // holderRefId 是 Character.id 外键，而非名字；InformationState 表无 holderRefName 列。
    informationStates?: Array<{ holderType?: string | null; holderRefId?: string | null; fact?: string | null; status?: string | null; summary?: string | null }>;
    foreshadowStates?: Array<{ title?: string | null; status?: string | null; summary?: string | null }>;
  } | null;
  options: StateServiceOptions;
}

export async function extractSnapshotWithAI(input: StateSnapshotExtractionInput): Promise<SnapshotExtractionOutput> {
  const chapterFacts = input.factRows.length > 0
    ? input.factRows.map((item) => `${item.category}: ${item.content}`).join("\n")
    : extractFacts(input.content).map((item) => `${item.category}: ${item.content}`).join("\n");
  const timelineBlock = input.timelineRows
    .map((item) => {
      const character = input.characters.find((entry) => entry.id === item.characterId);
      return `${character?.name ?? item.characterId}: ${item.content}`;
    })
    .join("\n");
  const previousSummary = buildPreviousSnapshotText(input.previousSnapshot);
  try {
    const result = await runStructuredPrompt({
      asset: stateSnapshotPrompt,
      promptInput: {
        novelId: input.novelId,
        chapterOrder: input.chapter.order,
        chapterTitle: input.chapter.title,
        chapterGoal: input.chapter.expectation ?? "无",
        charactersText: input.characters.map((item) => `- ${item.id} | ${item.name} | ${item.role} | goal=${item.currentGoal ?? ""} | state=${item.currentState ?? ""}`).join("\n"),
        summaryText: input.summaryRow?.summary ?? briefSummary(input.content),
        factsText: chapterFacts || "无",
        timelineText: timelineBlock || "无",
        previousSummary,
        content: input.content,
      },
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature ?? 0.2,
      },
    });
    const parsed = result.output;
    return parsed as SnapshotExtractionOutput;
  } catch {
    return buildFallbackSnapshot(input);
  }
}

/**
 * 把上一章完整状态快照（摘要 + 角色/关系/信息/伏笔）压缩成一段紧凑文本注入 prompt。
 * 目的：让 LLM 在抽取本章快照时能「继承未变化状态 + 提取本章增量」——否则每章
 * 快照只凭 summary 一句话继承前章，信息态/伏笔/关系会逐章漂移丢失。
 *
 * 预算控制：各类目截断条数 & 单条长度，防止长链写作时 previous 块吃掉正文 token。
 */
function buildPreviousSnapshotText(
  snapshot: StateSnapshotExtractionInput["previousSnapshot"],
): string {
  if (!snapshot) {
    return "上一状态快照：无";
  }
  const MAX_LINE = 120;
  const clip = (value: string | null | undefined): string => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }
    return normalized.length > MAX_LINE ? `${normalized.slice(0, MAX_LINE)}…` : normalized;
  };
  const sections: string[] = [];
  const summaryText = clip(snapshot.summary);
  if (summaryText) {
    sections.push(`摘要：${summaryText}`);
  }
  const characterLines = (snapshot.characterStates ?? [])
    .map((item) => clip(item.summary))
    .filter(Boolean)
    .slice(0, 8);
  if (characterLines.length > 0) {
    sections.push(`角色：\n${characterLines.map((line) => `- ${line}`).join("\n")}`);
  }
  const relationLines = (snapshot.relationStates ?? [])
    .map((item) => clip(item.summary))
    .filter(Boolean)
    .slice(0, 6);
  if (relationLines.length > 0) {
    sections.push(`关系：\n${relationLines.map((line) => `- ${line}`).join("\n")}`);
  }
  const infoLines = (snapshot.informationStates ?? [])
    .map((item) => {
      const holder = item.holderType || "reader";
      const fact = clip(item.fact) || clip(item.summary);
      if (!fact) {
        return "";
      }
      const status = item.status ? `(${item.status})` : "";
      return `${holder}${status}：${fact}`;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (infoLines.length > 0) {
    sections.push(`信息：\n${infoLines.map((line) => `- ${line}`).join("\n")}`);
  }
  const foreshadowLines = (snapshot.foreshadowStates ?? [])
    .map((item) => {
      const title = clip(item.title);
      if (!title) {
        return "";
      }
      const status = item.status ? `(${item.status})` : "";
      const detail = clip(item.summary);
      return detail ? `${title}${status}：${detail}` : `${title}${status}`;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (foreshadowLines.length > 0) {
    sections.push(`伏笔：\n${foreshadowLines.map((line) => `- ${line}`).join("\n")}`);
  }
  if (sections.length === 0) {
    return "上一状态快照：无";
  }
  return [
    "上一状态快照（用于继承未变化状态 + 提取本章增量，未提及条目请沿用）：",
    sections.join("\n\n"),
  ].join("\n");
}

function buildFallbackSnapshot(input: Pick<
  StateSnapshotExtractionInput,
  "chapter" | "content" | "characters" | "summaryRow" | "factRows" | "timelineRows"
>): SnapshotExtractionOutput {
  const summary = input.summaryRow?.summary ?? briefSummary(input.content);
  const facts = input.factRows.length > 0 ? input.factRows : extractFacts(input.content);
  const characterStates = input.characters.map((character) => {
    const timeline = input.timelineRows.filter((item) => item.characterId === character.id).map((item) => item.content);
    const relevantFacts = facts.filter((item) => item.content.includes(character.name)).map((item) => item.content);
    return {
      characterId: character.id,
      currentGoal: character.currentGoal ?? undefined,
      emotion: relevantFacts[0] ?? character.currentState ?? undefined,
      stressLevel: relevantFacts.length > 0 ? 60 : 40,
      secretExposure: "unknown",
      knownFacts: relevantFacts.slice(0, 3),
      misbeliefs: [],
      summary: [timeline[0], relevantFacts[0], character.currentState].filter(Boolean).join("；") || `${character.name}在第${input.chapter.order}章继续推进主线。`,
    };
  });
  const relationStates = input.characters.slice(0, 4).flatMap((source) => {
    return input.characters
      .filter((target) => target.id !== source.id && input.content.includes(source.name) && input.content.includes(target.name))
      .slice(0, 2)
      .map((target) => ({
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        trustScore: 50,
        intimacyScore: 40,
        conflictScore: 50,
        dependencyScore: 35,
        summary: `${source.name}与${target.name}在本章发生直接互动。`,
      }));
  });
  const informationStates = facts.slice(0, 6).map((item) => ({
    holderType: "reader",
    fact: item.content,
    status: "known",
    summary: item.category,
  }));
  const foreshadowStates = input.summaryRow?.hook?.trim()
    ? [{
        title: input.summaryRow.hook,
        summary: input.summaryRow.hook,
        status: "setup",
      }]
    : [];
  return {
    summary,
    characterStates,
    relationStates,
    informationStates,
    foreshadowStates,
  };
}
