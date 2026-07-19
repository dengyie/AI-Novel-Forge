# 有声书工作台 · 音色与固定试听就绪自动化（Voice Readiness）

> 状态：开发文档定稿 **v2.2**（待实现 · 可编码）· 2026-07-16  
> 修订：v2 吸收文档自审（依赖方向、stale 可播、门禁范围、action 纯函数、job 状态机、阶段边界）；v2.1 补 workspace 单次读库、pure 入参、job items 初始化与终态唯一规则；**v2.2** 锁定 UI badge SoT、voice→preview item 状态机、apply id 映射、409 类型与 progress 伪代码对齐。  
> 范围：把「音色补齐 + 固定试听生成」收口到有声书工作台前置逻辑；成文/角色台不再是日常有声书准备的主路径。  
> 前置已交付：`docs/plans/character-voice-preview-asset-plan.md`（固定试听资产 `preview.wav` + 指纹；播放零 TTS）。  
> 生产：production + `example.com`；blob 仍在 `server/storage/voice-refs/...`（archive 挂载）。  
> 产品 SoT 同步：Obsidian `ainovel 小说转有声书 产品形态`。  
> **运行假设（本 milestone）**：有声书 API **单进程**（production supervisord 一个 `novel-server`）。内存 job 不做跨实例粘滞。

---

## 0. 执行契约（Codex）

```text
Milestone：有声书工作台音色/试听就绪自动化
目标：
  1) 有声书工作台成为有声书准备的单一控制面（规划音色、固化试听、就绪看板、启动任务）
  2) 固定试听可在工作台批量/单角色自动生成（复用角色卡 SoT 与 generateCharacterPreview 语义）
  3) precheck 产出 preview 报告；createTask 可选 requireReadyPreview
  4) 成文侧角色台保留单卡精修，非日常有声书准备必经 UI

P0/P1 范围：
  - 纯函数 characterVoiceReadiness（binding / action / summary）+ 与 precheck 对齐表
  - AudiobookVoiceReadinessService：assess / prepare / getJob / cancelJob（内存 job）
  - API：assess、prepare、job、cancel；bootstrap 挂 readiness 摘要（无服务环依赖）
  - Precheck.preview；CreateAudiobookTaskInput.requireReadyPreview（服务端）
  - 工作台 UI：就绪看板、一键就绪、job 轮询、单角色生成、stale 可播、require 勾选
  - 必要单测 + typecheck
  - 文案：生成/播放分离；去掉「只能去角色台生成」

不做的 P2/P3：
  - 独立 VoiceAsset 表 / 全局音色中心 / prisma 新表
  - prepare 并入 novel_audiobook 全书合成流水线
  - SSE/WebSocket；跨小说优先级队列；多实例 job 粘滞
  - clone 自动生成；旁白 design/clone；旁白固定试听
  - 删除角色台单角色生成；改写作管线；新 TaskKind
  - 按「本章标注 speaker」收窄 voice/preview 门禁（仍扫全书角色卡，与现 precheck 一致）
  - 批量自定义多样例句编辑器

Manual-required：
  - 生产：源世界级角色量一键就绪耗时与 CPA 限流观感
  - 浏览器：进度刷新、失败重试、require 勾选文案、与全书合成并行时的听感/限流

阶段上限：3
阶段拆分：
  1) 纯函数 + ReadinessService + 路由 + precheck.preview + create 服务端 requireReadyPreview + bootstrap 摘要 + 单测
  2) 工作台 UI 聚拢（看板 / 一键就绪 / job / 单角色生成 / 文案）；默认可抽 AudiobookVoiceReadinessSection.tsx
  3) UI 挂上 requireReadyPreview 勾选 + 测试补齐 + 质量审查 + 文档交叉链收口
验收：§11
停止：P0/P1 完成；或 CPA/内存导致 prepare 无法在现网可靠验收 → 《需人工关注报告》
```

---

## 1. 问题与产品动机

### 1.1 现状断层

| 能力 | 现状落点 | 问题 |
|------|----------|------|
| 音色规划 suggest/apply | 有声书台 + `AudiobookVoiceAssetService` | 与试听生成割裂 |
| 固定试听 generate | 角色资产 `CharacterVoiceEditor` 主路径；工作台只读播 | 日常准备被赶到「角色准备」 |
| 任务 precheck | 只校验音色绑定 | 不感知 preview；不能自动补齐 |
| 播放 | 磁盘 only | 正确，必须保留 |

### 1.2 产品一句话

**数据仍挂角色卡；编排与自动化上收有声书工作台。**

### 1.3 主用户路径（本 milestone 后）

```text
小说编辑页 → 有声书工作台
  ├─ 就绪摘要 + 角色表（音色 / 试听 / 建议动作）
  ├─ [补齐缺失音色] / [重新差异化] / [写入规划]（既有）
  ├─ [一键就绪] → prepare job（fill voice + generate preview）
  ├─ 单角色 [生成试听]（固化 API）
  ├─ [播放试听]：ready|stale 可播；missing 禁用
  ├─ [预检]：voice + preview 报告
  └─ [生成有声书]：voice 硬门禁；可选 requireReadyPreview
角色资产工作台：单卡精修 + 单条生成；提示批量到有声书台
```

---

## 2. 冻结决策

| # | 决策 | 说明 |
|---|------|------|
| D1 | **SoT 不变** | `Character` 音色/试听字段；`storage/voice-refs/{novelId}/{characterId}/preview.wav` |
| D2 | **生成语义不变** | 凡固化试听最终只调 `AudiobookVoiceAssetService.generateCharacterPreview`；禁止 workbench 直写 base64 |
| D3 | **播放语义不变** | 播放零上游 TTS；**`missing` 禁播；`ready`/`stale` 可播**（stale 提示过期，不禁用播放） |
| D4 | **工作台可写音色** | suggest/apply 仍由有声书台；角色台精修同表后写者赢 |
| D5 | **一键就绪默认** | `fillMissingVoice=true`（onlyMissing + overwrite=false）；`generatePreview=true`；`regenerateStale=true`；`ready` skip |
| D6 | **clone 不自动** | planner 不写 clone；`mode===clone` 且无有效 ref → `manual_clone`；prepare 跳过并记 failed/skipped |
| D7 | **任务硬门禁** | create 仍只硬拦 **voice**（`precheck.ok`）；`requireReadyPreview?: boolean` 默认 false；true 时看 `precheck.preview.ok` |
| D8 | **门禁扫描范围 = 全书角色卡** | 与现 `AudiobookPrecheckService.missingVoices` **一致**：不按任务章节收窄。单章合成仍要求全书角色音色齐（已知过严，**本 milestone 不修**，写入产品说明） |
| D9 | **prepare = 进程内异步 job** | HTTP 立即返回 job；TTS **全局串行并发=1**；进程重启 job 丢失（可接受） |
| D10 | **不新建 TaskKind / 不建表** | job 仅内存 Map |
| D11 | **无 bootstrap→ReadinessService 依赖** | 见 §4.1；摘要只经 **纯函数模块** 或 ReadinessService.assess，禁止 VoiceAsset→Readiness 环 |
| D12 | **脏表单** | 批量只读 DB；角色台脏门禁保留 |
| D13 | **样例句** | 批量默认 `DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT`；可选 job 级 `previewText`；指纹规则见 §3.5 |
| D14 | **幂等** | ready 且指纹匹配 → skip；generate atomic 覆盖 wav |
| D15 | **成文隔离** | 写作 pipeline / export / novel_workflow **零** TTS readiness 引用 |
| D16 | **单进程** | job 与 active 锁仅本进程有效；文档与运维假设一致 |
| D17 | **409 类型不改全局 ApiResponse** | `code` 只放在 `data`；专用 `AudiobookVoiceReadinessJobActiveErrorData`；见 §3.1 |
| D18 | **UI 试听/动作徽章 SoT = readiness** | 工作台角色表与摘要条以 `readiness.items` / bootstrap.`readiness` 为准；`characters[].voicePreviewStatus` 仅作 bootstrap 兼容字段，**不**驱动工作台主 UI 决策（见 §8.0） |
| D19 | **job item 中间态不闪回** | voice 阶段成功后若仍将跑 preview，item **保持 running**（phase 可切 preview）；禁止 voice 成功后先标 succeeded 再被 preview 改回 running（见 §5.4） |
| D20 | **apply 映射** | apply 结果只按 characterId 回写 **已存在** 的 job.items；未知 id **忽略**（日志 debug 即可）；不得因 suggest 多出 id 新建 items 行 |

---

## 3. 领域模型

### 3.1 类型（写入 `shared/types/audiobook.ts`）

```ts
/** 与 precheck 对齐的音色绑定状态（见 §3.4 对照表） */
export type CharacterVoiceBindingStatus = "configured" | "missing" | "invalid";

/** 已有 */ // export type CharacterVoicePreviewStatus = "missing" | "ready" | "stale";

/**
 * 建议动作 — 必须可在无 IO / 无 planner 结果下由纯函数推出（§3.6）。
 * prepare 失败不会回写为另一 action 枚举；失败只出现在 job item.error。
 */
export type CharacterVoiceReadinessAction =
  | "none"              // configured && preview ready
  | "apply_plan"        // missing && mode 为 preset|design（或非法 mode 已归 invalid）
  | "generate_preview"  // configured && preview missing|stale
  | "manual_clone"      // missing|invalid 且 mode===clone（缺 ref / 坏文件在 invalid 时也给 manual_clone）
  | "fix_invalid";      // invalid 且非 clone 文件类（坏 preset 名、非法 ttsMode 等）

export interface CharacterVoiceReadinessItem {
  characterId: string;
  characterName: string;
  castRole?: string | null;
  gender?: string | null;
  voiceBindingStatus: CharacterVoiceBindingStatus;
  ttsMode: AudiobookTtsMode;
  ttsVoice?: string | null;
  /** 人类可读短句，如「preset/茉莉」「design」「clone·缺文件」 */
  voiceDetailLabel: string;
  previewStatus: CharacterVoicePreviewStatus;
  previewGeneratedAt?: string | null;
  action: CharacterVoiceReadinessAction;
  /** voiceBindingStatus !== "configured" */
  blocksTask: boolean;
  /** configured && previewStatus !== "ready" */
  blocksReadyPreview: boolean;
  reason?: string | null;
}

export interface AudiobookVoiceReadinessSummary {
  novelId: string;
  characterTotal: number;
  voiceConfigured: number;
  voiceMissing: number;
  voiceInvalid: number;
  previewReady: number;
  previewStale: number;
  previewMissing: number;
  /** voiceMissing===0 && voiceInvalid===0 && narrator.valid */
  voiceOk: boolean;
  /** 见 §3.3；无 configured 角色时 true */
  previewOk: boolean;
  /** voiceOk && previewOk */
  readyForWorkbench: boolean;
  narrator: AudiobookNarratorConfig & { valid: boolean };
  items: CharacterVoiceReadinessItem[];
  warnings: string[];
  blockingErrors: string[];
}

export interface AudiobookVoiceReadinessAssessInput {
  /** 空 = 全书角色 */
  characterIds?: string[];
}

export interface AudiobookVoiceReadinessPrepareInput {
  characterIds?: string[];
  /** 默认 true */
  fillMissingVoice?: boolean;
  /** 默认 true */
  generatePreview?: boolean;
  /** 默认 true：stale 也生成；false 只补 missing */
  regenerateStale?: boolean;
  /** 默认 "auto" */
  planStrategy?: AudiobookVoicePlanStrategy;
  /** 可选；全 job 统一样例句，写入 ttsPreviewSampleText */
  previewText?: string;
}

export type AudiobookVoiceReadinessJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AudiobookVoiceReadinessJobItemStatus =
  | "pending"
  | "running"
  | "skipped"
  | "succeeded"
  | "failed";

export interface AudiobookVoiceReadinessJobItem {
  characterId: string;
  characterName: string;
  status: AudiobookVoiceReadinessJobItemStatus;
  /** 该 item 主要步骤（展示用） */
  phase: "voice" | "preview" | "idle";
  error?: string | null;
  previewStatusAfter?: CharacterVoicePreviewStatus | null;
}

export interface AudiobookVoiceReadinessJob {
  id: string; // crypto.randomUUID()
  novelId: string;
  status: AudiobookVoiceReadinessJobStatus;
  /** 0–100，见 §5.3 */
  progress: number;
  currentCharacterId?: string | null;
  currentCharacterName?: string | null;
  currentLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequested: boolean;
  options: {
    fillMissingVoice: boolean;
    generatePreview: boolean;
    regenerateStale: boolean;
    planStrategy: AudiobookVoicePlanStrategy;
    characterIds?: string[];
    previewText?: string;
  };
  items: AudiobookVoiceReadinessJobItem[];
  summary?: {
    appliedVoice: number;
    generatedPreview: number;
    skipped: number;
    failed: number;
  } | null;
  lastError?: string | null;
}

/** POST prepare 成功 */
export interface AudiobookVoiceReadinessPrepareResult {
  job: AudiobookVoiceReadinessJob;
}

/**
 * POST prepare 409 响应（冻结形状，勿再「二选一」）：
 * {
 *   success: false,
 *   error: "该小说已有进行中的音色就绪任务，请等待或取消后再试。",
 *   data: { code: "READINESS_JOB_ACTIVE", activeJobId: string }
 * }
 *
 * 类型（D17）：
 * - 全局 `ApiResponse<T>` 已有 `data?: T` + `error?: string`，**禁止**为 409 改动
 *   `shared/types/api.ts`（不新增顶层 `code`）。
 * - 在 `shared/types/audiobook.ts` 定义专用错误 data：
 *     export interface AudiobookVoiceReadinessJobActiveErrorData {
 *       code: "READINESS_JOB_ACTIVE";
 *       activeJobId: string;
 *     }
 *   客户端将 409 body 断言为 `ApiResponse<AudiobookVoiceReadinessJobActiveErrorData>`。
 * - 路由实现：`res.status(409).json({ success:false, error: "...", data: { code, activeJobId } })`。
 * - 客户端：优先 `data?.activeJobId`；用 `data?.code === "READINESS_JOB_ACTIVE"` 分支。
 */
```

`CreateAudiobookTaskInput` 增加：

```ts
requireReadyPreview?: boolean; // 默认 false
```

`AudiobookPrecheckResult` 增加：

```ts
preview: {
  ready: number;
  stale: number;
  missing: number; // 仅 voiceBindingStatus===configured 的角色
  ok: boolean;     // 同 readiness.previewOk 算法
  items: Array<{
    characterId: string;
    characterName: string;
    previewStatus: CharacterVoicePreviewStatus;
    reason?: string | null;
  }>; // 可只含非 ready 的 configured 角色，或全量；实现选「非 ready 列表 + 计数」，避免巨大 payload
};
```

`AudiobookWorkspaceBootstrap` 增加（**可选字段**，始终由 bootstrap 填充）：

```ts
readiness?: {
  voiceOk: boolean;
  previewOk: boolean;
  readyForWorkbench: boolean;
  voiceConfigured: number;
  voiceMissing: number;
  voiceInvalid: number;
  previewReady: number;
  previewStale: number;
  previewMissing: number;
  characterTotal: number;
  narratorValid: boolean;
  /** 最多 12 条 action!==none */
  attentionItems: Array<{
    characterId: string;
    characterName: string;
    action: CharacterVoiceReadinessAction;
    previewStatus: CharacterVoicePreviewStatus;
    voiceBindingStatus: CharacterVoiceBindingStatus;
  }>;
  /**
   * 若本进程存在该 novel 的 queued|running readiness job，带上 id 便于 UI 恢复轮询。
   * 重启后恒为 null。
   */
  activeReadinessJobId?: string | null;
};
```

### 3.2 删除的噪声 API

- **不提供** `includeUnconfiguredInPreviewDenom`（v1 死参数，已删）。

### 3.3 计数与布尔（实现必须一致）

```text
items = 评估出的角色列表（可被 characterIds 过滤）

voiceConfigured = count(binding === configured)
voiceMissing    = count(binding === missing)
voiceInvalid    = count(binding === invalid)
characterTotal  = items.length

configuredSet = items where binding === configured

previewReady   = count(configuredSet where preview === ready)
previewStale   = count(configuredSet where preview === stale)
previewMissing = count(configuredSet where preview === missing)
// 未配置音色的角色：不计入上述三个 preview 计数

previewOk =
  if configuredSet.length === 0: true
  else: previewStale === 0 && previewMissing === 0
  // 即全部 configured 均为 ready

voiceOk = voiceMissing === 0 && voiceInvalid === 0 && narrator.valid

readyForWorkbench = voiceOk && previewOk

blocksTask(item)          = item.voiceBindingStatus !== "configured"
blocksReadyPreview(item)  = item.voiceBindingStatus === "configured"
                            && item.previewStatus !== "ready"
```

旁白：`valid = isMimoTtsPresetVoice(voice)`；旁白 **无** preview 资产。

### 3.4 binding 与现 precheck 对照表（锁死）

评估输入：角色行 + `fs` 对 clone path / preview path（preview path 状态仍走 `resolveCharacterVoicePreviewStatus`）。

| 情况 | precheck 今日行为 | `voiceBindingStatus` | `action`（再叠加 preview，§3.6） |
|------|-------------------|----------------------|----------------------------------|
| mode 缺省/preset，ttsVoice 空 | missingVoices | `missing` | → apply_plan |
| preset，voice 非白名单 | blockingErrors | `invalid` | → fix_invalid |
| design，prompt 空 | missingVoices | `missing` | → apply_plan |
| clone，path 空 | missingVoices | `missing` | → manual_clone |
| clone，path 非法/`..`/不存在/非文件 | blockingErrors | `invalid` | → manual_clone |
| mode 字符串非法（非三态） | blockingErrors | `invalid` | → fix_invalid |
| 字段齐且 preset 合法 / design 非空 / clone 文件可读 | 进 characterVoices | `configured` | 看 preview |
| 0 角色 | warning，ok 仍可为 true | — | previewOk=true |

说明：现 precheck 的 `characterIsConfigured` **不**把非法 preset 算 missing；非法走 blockingErrors。readiness **必须**同样拆开 missing vs invalid，且 `voiceOk` 在 invalid 时为 false，与 `precheck.ok===false` 同向。

实现：`characterVoiceReadiness.ts` **纯函数不碰 fs**。IO 层先算好布尔再传入：

```ts
resolveVoiceBindingStatus(input: {
  ttsMode?: string | null;
  ttsVoice?: string | null;
  ttsDesignPrompt?: string | null;
  ttsRefAudioPath?: string | null;
  /** clone 且 path 非空时：调用方 fs 探测结果；非 clone 传 null */
  refAudioOk: boolean | null;
}): { status: CharacterVoiceBindingStatus; reason?: string }
```

`AudiobookPrecheckService` **应**调用同一纯函数生成 missing/invalid（推荐防漂移），**不得** import `AudiobookVoiceReadinessService`。

### 3.5 指纹与 sampleText（与现码一致）

现码：`buildCharacterVoicePreviewFingerprint(config, sampleText)`，`sampleText` 参与哈希。

**assess / getCharacterPreview 共用规则**：

```text
sampleForFingerprint =
  (character.ttsPreviewSampleText?.trim() || DEFAULT_CHARACTER_VOICE_PREVIEW_TEXT)
currentFingerprint = build(..., sampleForFingerprint)
status = resolveCharacterVoicePreviewStatus({ audioPath, fingerprint, currentFingerprint })
```

**禁止**：assess 时无视库内 `ttsPreviewSampleText`、一律用 DEFAULT 导致误判 stale/ready。

**prepare 传入 `previewText`**：generate 使用该文案写入 `ttsPreviewSampleText`；完成后 fingerprint 含新文案；下一轮 assess 自然 ready。

### 3.6 `action` 纯函数（单测锁死）

```text
function resolveAction(binding, mode, preview):
  if binding === "invalid":
    return mode === "clone" ? "manual_clone" : "fix_invalid"
  if binding === "missing":
    return mode === "clone" ? "manual_clone" : "apply_plan"
  // configured
  if preview === "ready": return "none"
  return "generate_preview"   // missing | stale
```

- **不**根据 planner 是否成功分支。  
- prepare 中 plan/apply 失败 → job item `failed` + error，**不**把 summary.action 改写成 configure_voice 枚举（UI 用 error 文案即可）。  
- v1 删除独立的 `configure_voice` 枚举，避免与 apply_plan 语义重叠。

### 3.7 与 Precheck / createTask

```text
precheck(input):
  既有 voice / 章节 / 旁白逻辑（优先复用 binding 纯函数）
  + 对 configured 角色算 preview 计数与 preview.ok
  + precheck.ok 仍 = missingVoices空 && blockingErrors空
    （preview 不进入 precheck.ok）

createTask(input):
  r = precheck(input)
  if !r.ok → 400
  if input.requireReadyPreview && !r.preview.ok → 400
    文案：列出非 ready 的 configured 角色名（最多 8 个 +「等 N 人」）
```

**范围重申（D8）**：`requireReadyPreview` 与 voice 门禁一样扫 **全书角色卡**（在 assess 未传 characterIds 时），**不**按 scope 章节过滤。产品文案需写明，避免用户以为「只检本章」。

---

## 4. 架构（代码层钉死）

### 4.1 模块边界与依赖方向

```text
                    NovelAudiobookPanel
                            │
                            ▼
                  novelAudiobookRoutes
                     │        │        │
         ┌───────────┘        │        └───────────┐
         ▼                    ▼                    ▼
 ReadinessService      VoiceAssetService     PrecheckService
 assess/prepare/job    suggest/apply/gen     precheck(+preview)
         │                    │                    │
         └──────────┬─────────┴────────┬───────────┘
                    ▼                  ▼
         characterVoiceReadiness.ts   characterVoicePreview.ts
              （纯：binding/action/summary 输入结构）
                    │                  │
                    └────────┬─────────┘
                             ▼
                      prisma / fs / Mimo TTS
```

**强制规则**：

| 从 → 到 | 允许？ |
|---------|--------|
| ReadinessService → VoiceAssetService | ✅（prepare 调 suggest/apply/generate） |
| ReadinessService → characterVoiceReadiness / characterVoicePreview | ✅ |
| VoiceAssetService → characterVoicePreview / planner | ✅（已有） |
| VoiceAssetService → **ReadinessService** | ❌ **禁止** |
| PrecheckService → characterVoiceReadiness（pure）+ characterVoicePreview | ✅ |
| PrecheckService → ReadinessService | ❌ |
| getWorkspaceBootstrap（service 方法） | ❌ 不得调 ReadinessService；只返回角色/章节核心字段 |
| novelAudiobookRoutes GET workspace | ✅ 唯一组装点：core + readiness 摘要 |

**Bootstrap 组装（解环，冻结）**：

```text
路由 GET workspace（唯一允许组合处）：
  1. bootstrapCore = voiceAsset.getWorkspaceBootstrap(novelId)
     // 可继续附 characters[].voicePreviewStatus（兼容旧消费方 / 角色台）
  2. summary = readinessService.buildSummaryFromRows({
       novelId,
       narratorVoice: bootstrapCore.audiobookNarratorVoice,
       narratorStyle: bootstrapCore.audiobookNarratorStyle,
       characters: bootstrapCore.characters,  // 同一次查询结果，禁止再查 characters
     })
     // clone 文件探测：buildSummaryFromRows 内可 fs；纯 binding 只收 refAudioOk
     // previewStatus：buildSummaryFromRows 用 fingerprint 规则 §3.5 重算；
     //   与 characters[].voicePreviewStatus 可能瞬时一致，但 **工作台以 summary 为准（D18）**
  3. activeJobId = readinessService.getActiveJobId(novelId) // 内存，可 null
  4. return { ...bootstrapCore, readiness: toBootstrapReadiness(summary, activeJobId) }

禁止：
  - VoiceAsset 内部 import ReadinessService
  - workspace 路由再调 assess(novelId) 导致第二趟 characters 全表查询（默认路径禁止；
    assess(novelId) 仅给 GET /voice-readiness 与 prepare 内部使用）
  - UI 用 characters[].voicePreviewStatus 覆盖 readiness.items[].previewStatus 做徽章/按钮
```

ReadinessService API：

- `assess(novelId, input?)` — 自读 DB（给独立 GET）  
- `buildSummaryFromRows(...)` — workspace / 已有 rows 复用  
- `getActiveJobId(novelId)` — 内存

### 4.2 文件清单

| 路径 | 动作 | 职责 |
|------|------|------|
| `shared/types/audiobook.ts` | 改 | §3.1 类型；precheck/create/bootstrap 扩展 |
| `server/src/services/audiobook/characterVoiceReadiness.ts` | **新建** | pure：binding、action、aggregate summary、voiceDetailLabel |
| `server/src/services/audiobook/AudiobookVoiceReadinessService.ts` | **新建** | assess / buildSummaryFromRows / prepare / getJob / cancel / 队列 |
| `server/src/services/audiobook/AudiobookVoiceAssetService.ts` | 小改或不动 | bootstrap **可不改**；若改也只加字段由路由填 |
| `server/src/services/audiobook/AudiobookPrecheckService.ts` | 改 | preview 段；binding 对齐 pure |
| `server/src/services/audiobook/AudiobookTaskService.ts` | 改 | requireReadyPreview |
| `server/src/modules/novel/production/http/novelAudiobookRoutes.ts` | 改 | readiness 路由 + workspace 组装 readiness |
| `client/src/api/novel/audiobook.ts` | 改 | API |
| `client/src/api/queryKeys.ts` | 改 | keys |
| `client/src/pages/novels/components/NovelAudiobookPanel.tsx` | 改 | 接入 |
| `client/src/pages/novels/components/AudiobookVoiceReadinessSection.tsx` | **建议新建** | 摘要条+操作+表+job（降 Panel 膨胀） |
| `client/src/pages/novels/components/CharacterVoiceEditor.tsx` | 小改 | 批量提示文案 |
| `server/tests/characterVoiceReadiness.test.js` | **新建** | pure 用例 |
| `docs/plans/character-voice-preview-asset-plan.md` | 已链 | 保持交叉链 |

**禁止**：prisma 新表；`workers/*` 新进程；第二套 preview 路径。

### 4.3 单例

```ts
export const audiobookVoiceReadinessService = new AudiobookVoiceReadinessService();
```

与其它 `audiobook*Service` 一致。

### 4.4 Job 身份与存储

- `id = crypto.randomUUID()`  
- 结构：
  - `jobs: Map<jobId, Job>`  
  - `activeByNovel: Map<novelId, jobId>`（仅 queued|running）  
  - `queue: jobId[]` + `processing: boolean`（全局单一 runner）  
- **TTL**：job 进入终态后保留 **60 分钟** 供 poll；超时删除。queued/running 不按 TTL 杀（靠 cancel）。  
- **容量**：Map 超过 200 条时删最旧终态 job。  
- **重启**：全空；UI 404 → 清 local jobId。

---

## 5. ReadinessService 行为规格

### 5.1 assess

1. 读 novel 旁白 + characters（字段同现 bootstrap，含 preview 四字段）。  
2. 可选 `characterIds` 过滤。  
3. 每角色：binding（含 clone fs）、fingerprint（§3.5）、preview status、action（§3.6）。  
4. 聚合 summary；**不**调 TTS。

### 5.2 prepare

1. 若 `activeByNovel` 已有该 novel 的 queued|running → **抛业务冲突**，路由映射 **409** + `READINESS_JOB_ACTIVE` + `activeJobId`。  
2. 规范化 options 默认值。  
3. 建 job：`id=randomUUID()`，`status=queued`，`cancelRequested=false`。  
4. **立即**用当前 `assess(novelId, { characterIds })` 快照初始化 `items`：  
   每角一条 `{ characterId, characterName, status:"pending", phase:"idle" }`  
   （禁止等 running 才第一次出现列表，否则首屏 poll 空白）。  
5. 入队，立即返回 `{ job }`（含 items 快照）。

### 5.3 执行器与 progress

**全局**一个 runner（与 `AudiobookTaskService` 队列 **互不 await 阻塞**，可并行跑 → CPA 争用，UI/日志 warning 即可）。

Progress 公式（冻结）：

```text
phases:
  voicePhaseEnabled  = options.fillMissingVoice
  previewPhaseEnabled = options.generatePreview

weightVoice   = voicePhaseEnabled ? 15 : 0
weightPreview = previewPhaseEnabled ? 85 : (voicePhaseEnabled ? 85 : 0)
// 若仅 fill voice：voice 完成后 progress=100
// 若两阶段都关：立即 succeeded progress=100（noop job）

voice 阶段：0→weightVoice（suggest/apply 整段视为一次；完成时 progress=weightVoice）
preview 阶段：对 targets[i] 完成后
  progress = weightVoice + round( (i+1)/targets.length * weightPreview )
无 targets：preview 阶段结束 progress=100
```

### 5.4 Item 生命周期（含 D19/D20）

```text
// items 在 prepare 建 job 时已初始化（§5.2），runner 只更新不重建；
// 若 scope 与 items 不一致（不应发生），ensureItemsForScope 仅补缺失 id，不删已有。

fillMissingVoice:
  currentLabel = "规划并写入缺失音色"
  suggest(onlyMissing, strategy, characterIds = scope 内仍 missing)
  apply(overwrite=false)
  对每个 apply 结果（D20）：
    仅当 characterId ∈ job.items：
      applied 且后续仍将 generatePreview：
        item.status = "running"     // D19：禁止先 succeeded 再闪回
        item.phase  = "voice"       // 随后 preview 阶段改为 phase=preview，status 仍 running
      applied 且不会跑 preview（generatePreview=false 或该角无需 preview）：
        item.status = "succeeded"
        item.phase  = "voice"
      skipped → item.status="skipped", phase="voice"（reason 可写 error/reason）
      failed  → item.status="failed",  phase="voice", error=...
    characterId ∉ job.items → 忽略（debug log），不扩容 items
  re-read DB（prepare 内部评估用）

generatePreview:
  snap = assess(novelId, { characterIds: scopeIds })
  targets = configured && (missing || (stale && regenerateStale))
  不在 targets 且仍 pending|running（仅 voice 已完成等待 preview 的保持 running 进入本段）：
    configured+ready → item skipped（若仍 pending）；若已 voice-running 且 preview 无需做 → succeeded
  binding 仍 missing/invalid → skipped（clone 人工：skipped + reason manual）或 failed
  for t in targets:  // 严格串行
    if cancelRequested: 剩余 pending → skipped；job.status=cancelled；break
    item.phase = "preview"
    item.status = "running"   // 可从 pending 或 voice 阶段的 running 进入，禁止中间 succeeded 闪烁
    currentLabel = `生成试听：${name}`
    try generateCharacterPreview(..., { text: options.previewText })
      → item.status=succeeded, previewStatusAfter=ready
    catch → item.status=failed, error=slice(msg,200)
```

**item 状态机（单角色，合法转移）**：

```text
pending → running (voice|preview)
pending → skipped | failed
running → running   // 仅允许 phase: voice → preview（D19）
running → succeeded | failed | skipped
终态：succeeded | failed | skipped（不可再开）
```

**终态（job 级唯一规则，实现与单测只认这个）**：

```text
counters 在 run 结束时汇总：
  appliedVoice, generatedPreview, failed, skipped
  // failed/skipped 按 item 终态计数；同一角色只计一次（以 item 最终 status 为准）

attemptedVoiceApply = fillMissingVoice 阶段 suggest.items.length > 0
attemptedPreview    = generatePreview 阶段 targets.length > 0

if cancelRequested:
  status = cancelled
else if failed > 0 && appliedVoice === 0 && generatedPreview === 0
         && (attemptedVoiceApply || attemptedPreview):
  // 有尝试但零成功
  status = failed
else:
  // 含：noop（无 missing 无 target）；partial success（failed>0 但有成功）
  status = succeeded

progress 终态一律 100
```

noop（全 ready 且 fill 无 missing）：`succeeded`，summary 全 0，`attempted*` 可为 false。

### 5.5 cancel

- 设 `cancelRequested=true`。  
- **不** abort 进行中的单次 HTTP TTS（与全书任务一致）。  
- 循环间隙停止；当前角色若已成功落盘则保留。

### 5.6 getJob

- Map 查找；无 → null → 路由 404。

---

## 6. 路由与 Zod

前缀：`/novels/:id/audiobook/...`（`:id` = novelId）。

```http
GET  /novels/:id/audiobook/voice-readiness
     Query: characterIds 可选
       - 支持重复 query：?characterIds=a&characterIds=b
       - 或单参数逗号：?characterIds=a,b
       - 实现两者都解析；去空、去重、上限 200
     → 200 ApiResponse<AudiobookVoiceReadinessSummary>

POST /novels/:id/audiobook/voice-readiness/prepare
     Body: AudiobookVoiceReadinessPrepareInput
     → 200 { job }
     → 409 READINESS_JOB_ACTIVE + activeJobId

GET  /novels/:id/audiobook/voice-readiness/jobs/:jobId
     → 200 job | 404

POST /novels/:id/audiobook/voice-readiness/jobs/:jobId/cancel
     → 200 job | 404
     校验 job.novelId === :id

GET  /novels/:id/audiobook/workspace
     → bootstrapCore + readiness 摘要（路由组装，§4.1）
```

单角色 generate **保持**：

```http
POST /novels/:id/characters/:charId/voice-preview/generate
```

Zod prepareBody：

```ts
z.object({
  characterIds: z.array(z.string().trim().min(1)).max(200).optional(),
  fillMissingVoice: z.boolean().optional(),
  generatePreview: z.boolean().optional(),
  regenerateStale: z.boolean().optional(),
  planStrategy: z.enum(["auto", "preset_only", "prefer_design"]).optional(),
  previewText: z.string().trim().min(1).max(200).optional(),
})
```

createTaskBody 增：`requireReadyPreview: z.boolean().optional()`。

---

## 7. 客户端

```ts
getAudiobookVoiceReadiness(novelId, { characterIds?: string[] })
prepareAudiobookVoiceReadiness(novelId, body)
getAudiobookVoiceReadinessJob(novelId, jobId)
cancelAudiobookVoiceReadinessJob(novelId, jobId)
```

React Query：

- `audiobookVoiceReadiness(novelId)`  
- `audiobookVoiceReadinessJob(novelId, jobId)`：`queued|running` 时 `refetchInterval: 1500`  
- 终态：invalidate workspace、readiness、相关 preview keys  
- 409：读 `activeJobId`，改为 poll 该 job  
- 404 job：清 state，提示「就绪任务已丢失（服务重启），请重新一键就绪」

**jobId 持久化**：`sessionStorage` key `ainovel.voiceReadinessJob.{novelId}`，刷新可恢复；终态或 404 删除。

---

## 8. UI 规格

### 8.0 数据源（D18 · 冻结）

| UI 元素 | 权威数据源 | 禁止 |
|---------|------------|------|
| 就绪摘要条数字 / voiceOk / previewOk | `bootstrap.readiness` 或 `GET voice-readiness` | 自行从 characters 重算覆盖 |
| 角色表「试听」徽章 | `readiness.items[].previewStatus` | `characters[].voicePreviewStatus` 作主徽章 |
| 角色表「建议动作」 | `readiness.items[].action` | 客户端本地 if 树重推 action（除非纯展示映射文案） |
| 播放 enable | readiness item 的 previewStatus（ready\|stale） | bootstrap 旧字段单独判定 |
| job 进度行 | `GET .../jobs/:id` 的 items/progress | 用 bootstrap 猜 job 状态 |
| 单角色生成成功后 | invalidate readiness + workspace keys 后以上为准 | 只 patch characters[].voicePreviewStatus |

兼容：`characters[].voicePreviewStatus` 可继续返回，供角色资产台/其它旧入口；**有声书工作台主路径忽略它**。

### 8.1 布局顺序

1. 页头：本台负责音色规划、固定试听就绪、合成任务  
2. 就绪摘要条（数字 + 旁白 valid）— 数据源 §8.0  
3. 操作行：补齐/重平衡/写入规划 | **一键就绪** | 取消就绪（active 时）  
4. 角色表（合并现有列表，或 `AudiobookVoiceReadinessSection`）：名 / 音色 / 试听 / 建议动作 / 生成试听 / 播放  
5. 规划草稿区（ephemeral 保留）  
6. 旁白 + 范围 + 预检 + **「要求试听就绪后再生成」checkbox** + 创建任务  

### 8.2 播放 / 生成按钮

| previewStatus（来自 readiness item） | 播放 | 单角色生成试听 |
|---------------|------|----------------|
| missing | 禁用 | 若 binding=configured 则可用 |
| ready | 可用 | 可用（重新生成） |
| stale | **可用**（播旧版）+ 文案「配置已变，建议重新生成」 | 可用 |

### 8.3 一键就绪 confirm

```text
将为缺失音色自动规划写入，并为缺失/过期试听串行生成固定音频（可能较久）。
已就绪角色跳过。clone 需人工上传参考音频的角色会跳过。
与正在运行的全书合成任务可能争用 TTS 配额。
是否继续？
```

### 8.4 必改文案

- ❌「固定试听只在角色资产工作台生成；本台仅播放」  
- ✅「固定试听可在本台一键/单角色生成并写入角色卡；角色台可精修单卡」

### 8.5 CharacterVoiceEditor

保留三按钮；增加 muted：「批量准备请到「有声书」工作台使用「一键就绪」。」

### 8.6 require 勾选说明（旁注）

```text
开启后：全书角色卡均需试听 ready（与音色门禁相同，按全书角色而非仅本章）。缺/过期将无法创建任务。
```

---

## 9. 错误与可观测

| 场景 | 行为 |
|------|------|
| TTS 4xx/5xx | item failed，继续；不 fail-open 写 ready |
| 写盘失败 | 同 generate 现有错误 |
| 409 | UI 接 activeJobId |
| job 404 | 清 state，允许重跑 |
| require 未齐 | 400 中文名单 |
| 与全书合成并行 | job start `console.warn` 可选；不互斥 |

日志：job start/end + novelId + summary 计数；**禁止** base64。

---

## 10. 测试

### 10.1 服务端 pure（必须）

`server/tests/characterVoiceReadiness.test.js`：

1. missing preset → binding missing, action apply_plan  
2. bad preset name → invalid, fix_invalid  
3. clone 无 path → missing, manual_clone  
4. clone 文件不存在（probe false）→ invalid, manual_clone  
5. configured + no audio → generate_preview  
6. fingerprint mismatch → stale → generate_preview  
7. ready → none；previewOk true  
8. 0 configured → previewOk true, readyForWorkbench 取决于 voiceOk/narrator  
9. summary 计数混合 fixture  

### 10.2 服务端集成（尽量）

- mock generate：串行 skip ready；cancel 后剩余 skipped  
- 同 novel 二次 prepare → 冲突  

### 10.3 客户端

- 徽章/按钮 enable：stale 可播；missing 不可播。  
- 数据源：徽章读 readiness item，不读 `characters[].voicePreviewStatus`（D18）。  
- 409：解析 `data.activeJobId` + `data.code`，不依赖全局 `ApiResponse.code`。

### 10.4 服务端 job item（推荐）

1. voice applied 且将跑 preview：中间 poll 见 `running`+`phase=voice`，随后 `running`+`phase=preview`，**无** intermediate `succeeded`。  
2. apply 返回未知 characterId：items 长度不变。  
3. 二次 prepare：409 + `data.code=READINESS_JOB_ACTIVE`。

### 10.5 手工

一键 → 二次 noop → 改配 stale 可播 → 再生 ready → 默认 create 不拦 stale → 勾选 require 拦截 →（可选）重启后 404。

### 10.6 静态门禁

`grep generateCharacterPreview` 引用仅限 asset / readiness / routes。

---

## 11. 总验收

1. 仅用有声书台：缺音色样书一键就绪 → tts 写入 + preview.wav + ready。  
2. 就绪后连续播放 **零** synthesize（仅 audio GET）。  
3. stale **可播**旧版；再生后 ready。  
4. 不进角色准备也能完成准备。  
5. precheck.preview 正确；默认 create 不因 stale 失败；require=true 可读拦截（全书角色语义）。  
6. 运行中二次 prepare → 409 + 可 poll 原 job。  
7. 纯函数单测 + typecheck。  
8. 写作链无新 TTS 点。  
9. VoiceAsset **不** import ReadinessService；workspace 由路由组装 readiness。

---

## 12. 阶段规格

### 阶段 1 — 模型 + 服务 + API

```text
阶段目标：curl 闭环 assess/prepare/job；precheck.preview；create 服务端 require；workspace 带 readiness
不做：Panel 大改（可用最小 smoke 客户端）
提交：feat(phase-1): audiobook voice readiness assess+prepare api
```

### 阶段 2 — 工作台 UI

```text
阶段目标：一键就绪/看板/单角色生成/文案/job 轮询/sessionStorage
默认抽 AudiobookVoiceReadinessSection.tsx
提交：feat(phase-2): audiobook workbench owns voice readiness ux
```

### 阶段 3 — UI 门禁勾选 + 测试审查

```text
阶段目标：checkbox requireReadyPreview 接线；补测；production-code-quality-review；交叉链
服务端门禁已在阶段 1，本阶段不重做 API
提交：feat(phase-3): readiness require-preview ui + tests
```

每阶段：验证 → 审查 → 原子 commit（≤3）。

---

## 13. 与旧决策修订表

| 旧（固定资产 milestone） | 新 |
|--------------------------|-----|
| 主操作台 = 角色资产台 | 主操作台 = **有声书工作台** |
| 工作台不在线生成 | 工作台 **批量+单角色固化生成** |
| 批量 = P2 | 批量 = 本里程碑 P0/P1 |
| precheck 只 voice | + preview 报告与可选硬拦 |

不修订：指纹算法、路径、media-access、generate 基于已保存配置、播放只读磁盘、全书角色 voice 门禁范围。

---

## 14. 风险

| 风险 | 缓解 |
|------|------|
| 角色多耗时长 | 串行 + 进度；confirm 提示 |
| CPA 限流 | 单角色失败继续；可重跑 |
| 与全书 TTS 争用 | 不互斥；warning；Manual |
| 内存 job 丢失 | 404 文案；sessionStorage 清 |
| 全书门禁过严 | D8 明示；P2 再做 scope 收窄 |
| Panel 膨胀 | 默认抽 Section |

---

## 15. 反模式（打回）

- VoiceAsset → ReadinessService 依赖  
- 写作 pipeline 触发 preview TTS  
- prepare 同步阻塞 HTTP 批量 TTS  
- 复制一套 fingerprint/路径  
- fail-open 标 ready  
- ephemeral base64 当就绪  
- 禁用 stale 播放  
- 把 readiness job 写入 AudiobookTask 行  
- 静默按章节收窄门禁却不改 D8  
- 为 409 给全局 `ApiResponse` 加顶层 `code`（违反 D17）  
- 工作台用 `characters[].voicePreviewStatus` 覆盖 readiness 徽章（违反 D18）  
- voice 成功先 `succeeded` 再被 preview 改 `running`（违反 D19）  
- apply 未知 id 扩写 items 或抛 500（违反 D20）  

---

## 16. 提交约定

```text
feat(phase-1): audiobook voice readiness assess+prepare api
feat(phase-2): audiobook workbench owns voice readiness ux
feat(phase-3): readiness require-preview ui + tests
test(phase-X): ...
docs(phase-X): ...
```

---

## 17. 伪代码（执行体，结构等价）

```ts
async function runJob(job: Job) {
  job.status = "running";
  job.startedAt = now();
  const opts = job.options;
  let appliedVoice = 0, generatedPreview = 0, skipped = 0, failed = 0;
  let attemptedVoiceApply = false;
  let attemptedPreview = false;

  ensureItemsForScope(job); // 仅补缺，不删已有；prepare 已种 pending

  if (opts.fillMissingVoice) {
    job.currentLabel = "规划并写入缺失音色";
    const suggest = await voiceAsset.suggest(job.novelId, {
      onlyMissing: true,
      strategy: opts.planStrategy,
      characterIds: job.options.characterIds,
    });
    attemptedVoiceApply = suggest.items.length > 0;
    if (attemptedVoiceApply) {
      const result = await voiceAsset.apply(job.novelId, {
        items: suggest.items.map(toApplyItem),
        overwrite: false,
      });
      appliedVoice += result.applied.length;
      // D20：仅 map 到已有 items；未知 id 忽略
      // D19：applied 且 opts.generatePreview → status=running, phase=voice（勿 succeeded）
      //      applied 且 !generatePreview → succeeded, phase=voice
    }
    // §5.3：voice 权重 15（若 preview 关则本段结束 progress=100）
    job.progress = opts.generatePreview ? 15 : 100;
  }

  if (opts.generatePreview && !job.cancelRequested) {
    const snap = await readiness.assess(job.novelId, {
      characterIds: job.options.characterIds,
    });
    const targets = snap.items.filter(
      (i) =>
        i.voiceBindingStatus === "configured" &&
        (i.previewStatus === "missing" ||
          (i.previewStatus === "stale" && opts.regenerateStale)),
    );
    attemptedPreview = targets.length > 0;
    // pending 且 configured+ready → skipped；仍 missing binding → skipped/manual
    for (let i = 0; i < targets.length; i++) {
      if (job.cancelRequested) break;
      const t = targets[i];
      job.currentCharacterId = t.characterId;
      job.currentLabel = `生成试听：${t.characterName}`;
      // D19：phase=preview; status=running（可从 voice-running 直接切换 phase）
      try {
        await voiceAsset.generateCharacterPreview(job.novelId, t.characterId, {
          text: opts.previewText,
        });
        generatedPreview++;
        mark(job, t.characterId, "succeeded", "ready");
      } catch (e) {
        failed++;
        mark(job, t.characterId, "failed", null, msg(e));
      }
      // §5.3 progress 公式
      const weightVoice = opts.fillMissingVoice ? 15 : 0;
      const weightPreview = 100 - weightVoice;
      job.progress = Math.min(
        100,
        weightVoice +
          Math.round(((i + 1) / Math.max(targets.length, 1)) * weightPreview),
      );
    }
  }

  // 终态唯一规则见 §5.4
  finalizeJobStatus(job, {
    appliedVoice,
    generatedPreview,
    failed,
    skipped,
    attemptedVoiceApply,
    attemptedPreview,
    cancelRequested: job.cancelRequested,
  });
  job.summary = { appliedVoice, generatedPreview, skipped, failed };
  job.finishedAt = now();
  job.progress = 100;
  clearActiveIfMatch(job);
}
```

---

## 18. 关联

- `docs/plans/character-voice-preview-asset-plan.md`  
- Obsidian：`ainovel 小说转有声书 产品形态`、`ainovel 文档索引`  
- 代码：`AudiobookVoiceAssetService`、`AudiobookPrecheckService`、`AudiobookTaskService`、`NovelAudiobookPanel`、`characterVoicePreview.ts`、`audiobookVoicePlanner.ts`（`isCharacterVoiceConfigured`）

---

## 19. 开发启动检查表

- [ ] 通读 §0–§6 + D17–D20 + §5.4 + §8.0，范围冻结  
- [ ] `characterVoiceReadiness.ts` + 单测  
- [ ] `AudiobookVoiceReadinessService` + 路由（workspace 路由组装）  
- [ ] precheck.preview + create require  
- [ ] 409 body = `ApiResponse<AudiobookVoiceReadinessJobActiveErrorData>`（不改 api.ts）  
- [ ] curl：assess → prepare → poll → preview ready  
- [ ] 阶段审查 → commit → 阶段 2  

**编码不得改口本文**；硬阻塞则先修订本文再改代码。

---

## 20. 文档裁决日志（v2.2）

| 残留点 | 裁决 | 落点 |
|--------|------|------|
| 双路 `voicePreviewStatus` vs readiness | 工作台徽章/动作/播放 **只认 readiness**；bootstrap 角色字段仅兼容 | D18 · §4.1 · §8.0 |
| voice→preview item 闪烁 | 仍需 preview 时 voice 成功保持 `running`，仅切 phase | D19 · §5.4 · §17 |
| suggest/apply 多出 id | 只更新已有 items；未知 id 忽略 | D20 · §5.4 · §17 |
| 409 与 `ApiResponse` | code 在 data；专用 error data 类型；不改 `shared/types/api.ts` | D17 · §3.1 |
| progress 伪代码与 §5.3 | 伪代码统一 weightVoice=15 / weightPreview=剩余 | §17 |
| prepare items 与 runner ensure | prepare 立即种 items；runner ensure 仅补缺 | §5.2 · §5.4 |

**文档结论：v2.2 通过，可进入编码（等用户明确开工）。**
