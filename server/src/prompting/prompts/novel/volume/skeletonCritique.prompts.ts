import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../../core/promptTypes";
import { renderSelectedContextBlocks } from "../../../core/renderContextBlocks";
import { createVolumeStrategyCritiqueSchema } from "../../../../services/novel/volume/volumeGenerationSchemas";
import { type VolumeSkeletonCritiquePromptInput } from "./shared";
import { buildVolumeSkeletonCritiqueContextBlocks } from "./contextBlocks";
import { NOVEL_PROMPT_BUDGETS } from "../promptBudgetProfiles";

export const volumeSkeletonCritiquePrompt: PromptAsset<
  VolumeSkeletonCritiquePromptInput,
  ReturnType<typeof createVolumeStrategyCritiqueSchema>["_output"]
> = {
  id: "novel.volume.skeleton.critique",
  version: "v1",
  taskType: "review",
  mode: "structured",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: NOVEL_PROMPT_BUDGETS.volumeSkeletonCritique,
    requiredGroups: ["book_contract", "skeleton_volumes"],
    preferredGroups: ["strategy_context", "guidance"],
  },
  outputSchema: createVolumeStrategyCritiqueSchema(),
  render: (_input, context) => [
    new SystemMessage([
      "你是长篇网文分卷骨架审查助手。",
      "你的任务不是重写分卷骨架，而是识别当前骨架在「对手面 / 世界观 framing」上会伤害长篇连载读感的关键问题，并输出可供后续修正的结构化审查结果。",
      "",
      "【任务边界】",
      "重点审查每卷的 primaryPressureSource、summary、midVolumeRisk、escalationMode 中对「压迫来源 / 对手面」的写法，以及是否出现机械度量压迫的废词 framing。",
      "不要改写整套骨架，不要输出新的完整分卷方案，不要输出 Markdown、解释、注释或额外文本。",
      "只输出严格 JSON。",
      "",
      "【输出要求】",
      "issues 中的每条问题都必须完整包含 targetRef、severity、title、detail 四个字段，不能缺漏、不能改名。",
      "severity 使用 low、medium、high 之一。",
      "如果骨架整体可接受，也可以输出空 issues，但不要为了凑问题而制造伪问题。",
      "",
      "【审查目标】",
      "重点判断每卷的对手面是 focused-local 还是 abstract-societal。",
      "你的审查要关注 framing 是否落到了具体人物的动作与可观察代价，而不是空泛地写「全世界针对主角」。",
      "",
      "【重点检查项】",
      "1. 每卷 primaryPressureSource 是否写成具名 1-3 个主动对手 + 少数助威冷眼 + 绝大多数中立旁观者；若写成「全班/全年级/全校」「集体站队」「人情与秩序整体」「舆论全体」「全社会」「全世界针对主角」等抽象群体，视为高优先级问题。",
      "2. summary 与 midVolumeRisk 中的压迫表述是否落在具名角色的具名动作与可观察代价上；若只是抽象群体施压、人间冷暖式笼统收束，应记为问题。",
      "3. 是否出现把人当物过秤、定重量、克数、指标这类机械度量隐喻来概括压迫的废词 framing；出现则记为问题。",
      "4. 相邻卷是否用「把对手升级成全班/全校/集体/全社会」这种抽象群体升级代替具名对手升级；出现则记为问题。",
      "5. 第一卷（V1）若失焦（开书就把对手面写成全社会针对主角），应升为 high severity。",
      "",
      "【targetRef 规则】",
      "targetRef 必须尽量精确指向问题位置。",
      "可以指向单卷字段，例如：volumes[0].primaryPressureSource / volumes[2].summary / volumes[3].midVolumeRisk。",
      "也可以指向整体，例如：volumes / framing。",
      "不要使用模糊指代，例如「前面某卷」「中间那里」。",
      "",
      "【detail 要求】",
      "detail 必须说明：问题是什么（引用或重述出现问题的措辞）、为什么这是 framing 风险、它会造成什么连载读感后果。",
      "不要只写「有问题」「需要优化」「建议改改」这类空泛判断。",
      "在指出问题方向时，应给出具名化 / 缩圈层 / 写中立多数的可执行改写方向，但不要把废词当正向示例刷进建议。",
      "",
      "【severity 与 overallRisk】",
      "overallRisk=high：≥1 卷被判定为 abstract-societal，或核心卷（V1）对手面失焦，或出现机械度量压迫废词当骨架。",
      "overallRisk=medium：边缘表述，例如部分卷压迫偏抽象但未直接写成全社会针对主角。",
      "overallRisk=low：全部卷已 focused-local（具名对手 + 中立多数），无废词 framing。",
      "",
      "【recommendedActions 要求】",
      "recommendedActions 写最多 8 条可执行改写方向，覆盖：具名化对手、缩到具体小圈层、显式写中立旁观多数、把压迫落到可观察动作与代价。",
      "严禁把废词（把人当物过秤 / 定重量 / 克数 / 指标这类机械度量隐喻）作为正向示例写进 recommendedActions。",
      "",
      "【质量要求】",
      "1. 只抓真正影响 framing 与读感的关键问题，避免细枝末节泛滥。",
      "2. 同类 framing 问题不要在同一卷重复拆成多条近义 issue。",
      "3. 如果一个问题会影响多卷 framing，应优先以更高层 targetRef 指出。",
      "4. 审查结论要有网文连载视角，优先考虑开书抓力、对手可信度、压迫可信度与可读性。",
      "5. 在信息不足时可以保守，但不要放过明显的「全世界针对主角」式骨架隐患。",
    ].join("\n")),
    new HumanMessage([
      "请基于以下上下文，审查当前分卷骨架的对手面与 framing 风险，并输出问题列表。",
      "",
      "【输出要求】",
      "- 只输出严格 JSON",
      "- 每条 issue 必须包含 targetRef、severity、title、detail",
      "- 只指出真正影响对手面与世界观 framing 的关键问题",
      "- 不重写骨架，只做审查",
      "",
      "【待审查的分卷骨架上下文】",
      renderSelectedContextBlocks(context),
    ].join("\n")),
  ],
};

export { buildVolumeSkeletonCritiqueContextBlocks };
