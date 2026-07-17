# 有声书工作台 · 体验与 UI 统一优化

> 状态：开发文档定稿 **v1.1**（已实现 · 待交付/merge · Readiness 终态 toast 原生）· 2026-07-17  
> 修订：v1.1 吸收文档深度 review——overview 查询模型与禁 N 次 assess、Badge 优先级栈、A2 必做锚点、移动 fixed 生成条参照系、A-lite 降级、queryKeys 接线事实、缓存/鉴权/toast 冻结。  
> 来源：生产 tip `main/pxed@17d83151` 后的全栈流程 + 工作台 + UI 统一性 review  
> 前置已交付：voice readiness、design-prompt soft-target、listen-usability P0、segment delivery（UI 默认 `characters`）、任务折叠交付、角色分簇规划、固定试听资产（preview 指纹）  
> 产品 SoT：Obsidian `ainovel 小说转有声书 产品形态` · 边界：`docs/wiki/workflows/novel-audiobook-boundary.md`  
> 生产：pxed + `ainovel.mangoq.ccwu.cc`（本 milestone **默认不 merge/deploy**，用户另令）

---


## 实现记录（本分支）

- 分支：`feat/audiobook-workbench-ux`
- Phase 1：`POST /novels/audiobook/workspace-overview` + `buildAudiobookWorkspaceOverview`（bulk、`skipRefAudioProbe`、max 50、静默省略）；Badge `resolveAudiobookWorkspaceBadges`；选书页接线
- Phase 2：项目页三锚点；面板 `#ab-prepare/#ab-create/#ab-tasks`；规划默认折叠；移动 fixed CTA（`4.25rem+safe-area`）；toast 主路径；`queryKeys.novels.audiobookTasks` 统一 invalidate；**ReadinessSection 原生终态 toast**（§4.2.5），panel 仅 message 明细
- Phase 3：server/client 单测 + shared/server/client typecheck 通过；阶段 checklist 勾选；**默认不 merge/deploy**
- Review 修复：`loadLatestTasksByNovel` 用 `ROW_NUMBER` 每本 latest 1 条（禁无界 `audiobookTask.findMany`）；选书 overview error/truncated UI；`audiobookWorkspaceOverviewPrefix`；reprocess invalidate overview；`#ab-tasks` `pb-28 lg:pb-4`。PR 卫生：分支含 qfp `a6e849c`（≈ main `cea2c0c` 同内容不同 hash），merge 前建议 rebase onto main 以只保留 UX 提交

## 0. 执行契约（Codex）

```text
Milestone：有声书工作台体验与 UI 统一优化
目标：
  1) 选书页可感知「就绪 / 在跑 / 可交付」，减少多书往返
  2) 项目页信息架构可扫读：准备 → 生成 → 任务，主 CTA 可达
  3) 交互语言与全站统一（toast + queryKeys 接线）；壳与 comic 工作台同级而不改合成协议

P0/P1 范围：
  - 选书列表轻量态势 API（单次批量读库 + 纯函数摘要 + 每本 latest task；可 A-lite 降级）
  - Badge 优先级栈（主态 1 枚 + 辅态 ≤2）
  - 项目页三段 IA + 页顶三锚点（两端必做）
  - 移动 fixed 生成条（与 MobileSiteShell 底栏同款 offset）；桌面可不 sticky
  - toast 为主；任务列表接线已有 queryKeys.novels.audiobookTasks
  - 规划默认折叠降权；去掉项目页厚套 Card
  - 必要单测（含 overview 禁 N assess 意图）+ typecheck + 手动走查
  - 本增量 production-code-quality-review

不做的 P2/P3：
  - 改 TTS / annotate / SoT fingerprint / delivery 编译 / multi-backend 开关
  - 按「本章 speaker」收窄 voice 门禁（仍全书角色卡，产品债另立）
  - 独立 VoiceAsset 表、全局音色中心、新 TaskKind、SSE
  - 漫画级完整 Tabs 多轨
  - NovelAudiobookPanel 无关大搬家（允许按 section 抽文件）
  - IntersectionObserver 高亮步骤（P2，不挡 A2）
  - 桌面 sticky 生成条（P2）
  - clone 自动、旁白 design/clone、响度 loudnorm、发音词典
  - 自动 merge / pxed cutover / Obsidian 运维大改（交付时另令）
  - 改 bootstrap 契约（overview 独立接口，不扩展 workspace bootstrap 载荷）

Manual-required：
  - 桌面 + 移动：选书态势、三锚点、移动 fixed 生成条 vs 底栏、任务折叠听播
  - 叠态：缺音色+任务 running；succeeded 后又 running；failed；0 角色仅旁白
  - 从项目页返回列表后 overview 刷新
  - 真机听感不在本 milestone（沿用 listen-usability Manual）

阶段上限：3
阶段拆分：
  1) overview API（轻量批量）+ Badge 映射纯函数 + Workspace 列表 UI + 单测
  2) 项目页三段+锚点+规划折叠+toast+queryKeys 接线+去厚 Card+移动 fixed 生成条
  3) 走查补洞 + 审查 + 文档交叉链；停止

验收：§8
停止：P0/P1 完成；或 overview 在目标环境无法轻量验收且 A-lite 已落地并注明缺口 → 《需人工关注报告》
```

---

## 1. 问题与动机

### 1.1 Review 结论摘要

| 维度 | 结论 |
|------|------|
| 端到端能力 | **达标**（就绪→生成→标注/未匹配→SoT 合成→渐进听/m4b） |
| 工作台契约 | **能力符合**单一控制面；**体验有条件符合** |
| UI 统一 | **壳统一**（路由/侧栏/`max-w-4xl`）；**内容区偏密、缺分步感**，弱于 comic |

### 1.2 现状断层

| 能力 | 现状 | 问题 |
|------|------|------|
| 选书页 | 纯小说列表（title/status/简介） | 多书时不知谁能生成、谁在跑、谁可听 |
| 项目页 | 单 Card 长卷嵌大面板 | 首访滚到「生成」成本高 |
| 反馈 | 面板内 `message` 条 | 与全站 `toast` 不一致 |
| 规划 vs 就绪 | 规划区与一键就绪同权 | 误以为必须「写入规划」 |
| 任务 queryKey | 面板硬编码 `["novel-audiobook-tasks", id]` | **`queryKeys.novels.audiobookTasks` 已存在**，仅未接线 |
| 外壳 | Project 外层 Card + 内层多 block | 边框套边框 |

### 1.3 一句话目标

**不改合成协议的前提下，把有声书工作台做成「可扫读的同级工作台」：入口有态势、页内有步骤、主操作有锚点、反馈跟全站一致。**

---

## 2. 冻结决策

| # | 决策 | 说明 |
|---|------|------|
| D1 | **不改服务端合成语义** | annotate / delivery / SoT / precheck 硬门禁规则保持；仅 UI + **只读**态势 API |
| D2 | **选书态势只读、可降级** | 单本失败 → 该项 null/省略，不拖垮列表 |
| D3 | **态势字段最小化** | 禁止回传章节正文、完整 `readiness.items`、全量任务历史、音频 blob |
| D4 | **项目页不做完整 Tabs** | 三段视觉分区 + **页顶三锚点必做**；非 comic 多轨 |
| D5 | **主路径 CTA 顺序** | 一键就绪 →（可选规划）→ 旁白/范围 → 预检/生成 → 任务；规划默认折叠 |
| D6 | **toast 为主、message 为辅** | 见 §4.2.5；禁止同一事件双长文 |
| D7 | **queryKeys 接线** | 任务列表改用**已有** `queryKeys.novels.audiobookTasks`；overview 新增 key；invalidate 全路径对齐 |
| D8 | **移动生成条 = fixed + 底栏 offset** | 与 `MobileSiteShell` 同款 `bottom-[calc(4.25rem+env(safe-area-inset-bottom))]` 思路；**不**依赖 window scroll sticky。桌面可不做生成条 |
| D9 | **面板可抽子组件，禁止无关重构** | 允许按 section 拆文件；行为契约不变 |
| D10 | **全书 voice 门禁不本轮改** | 文案可提示「单章也需全书角色音色齐」 |
| D11 | **默认不部署** | merge/pxed 需用户明确交付指令 |
| D12 | **Overview 禁止 N 次 `assess()`** | 单次（或固定次数）批量读库 + `buildSummaryFromRows` / `aggregateVoiceReadinessSummary`；列表路径 **不** `probeRefAudioOk` 逐文件 |
| D13 | **可生成语义 = `voiceOk`** | 列表「可点进生成」跟 voice 硬门禁对齐；**不要**用 `readyForWorkbench`（含 preview）当主「可生成」 |
| D14 | **不扩展 workspace bootstrap** | overview 独立 `POST .../workspace-overview`；不把批量态势塞进 `GET .../workspace` |
| D15 | **A2 必做面** | 页顶三锚点（桌面+移动）+ 移动 fixed 生成条 = P1；IntersectionObserver / 桌面 sticky = P2 |

---

## 3. 领域与 API

### 3.1 选书态势

分层：

```text
列表页 ──POST overview──► 批量 DB + 纯函数摘要 + 每本 latest task（轻量、可略粗）
项目页 ──现有 assess/job/tasks──► 精确态（允许 clone ref 磁盘 probe）
```

#### 3.1.1 接口

```http
POST /api/novels/audiobook/workspace-overview
Content-Type: application/json

{ "novelIds": ["...", "..."] }
```

**约束：**

| 项 | 规则 |
|----|------|
| 上限 | `novelIds.length > 50` → **截断前 50**（稳定顺序：保持请求顺序），响应可带 `truncated: true` 或仅返回 50 条；**不**因超限整包 400 |
| 空数组 | `200` + `items: []` |
| 鉴权 | 请求 id ∩ 当前用户可读 novel；不可读 **静默省略**（不因单个越权 404 整包；防探测不回「无权限」明细） |
| 单本失败 | 该项不出现或 `readiness: null`，HTTP 仍 200 |
| 响应包 | 沿用站内 `ApiResponse<{ items: AudiobookWorkspaceNovelOverview[]; truncated?: boolean }>` |

#### 3.1.2 类型

```ts
type AudiobookWorkspaceNovelOverview = {
  novelId: string;
  /**
   * 列表级 readiness 摘要。
   * 与工作台 assess 同源聚合字段，但 clone ref **不做磁盘 probe**
   * （path 空 → 未配置；path 非空 → 视为 configured 候选，精确态进项目页再 probe）。
   * 评估失败则为 null。
   */
  readiness: {
    voiceOk: boolean;
    voiceConfigured: number;
    characterTotal: number;
    previewReady: number;
    previewMissing: number;
    previewStale: number;
    /** 仅作辅信息；列表主「可生成」看 voiceOk */
    readyForWorkbench: boolean;
    narratorValid: boolean;
  } | null;
  latestTask: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    progress: number;
    /** 仅当任务列表投影已有且廉价时填充；禁止为 overview 对 50 本做磁盘 stat */
    fullAudioReady?: boolean;
    m4bStatus?: string | null;
    updatedAt: string;
  } | null;
  /**
   * 内存 readiness job 是否 active。best-effort：
   * 进程重启 / 非本实例 → 可能 false，前端不得当错误。
   */
  activeReadinessJob: boolean;
};
```

#### 3.1.3 实现契约（编码 SoT）

**必须：**

1. **一次**（或 O(1) 次）批量加载 novels + characters 所需 TTS/preview **列字段**（`findMany` + `id in`），禁止：

   ```ts
   // 禁止
   for (const id of novelIds) await readinessService.assess(id)
   ```

2. 内存调用已有：

   - `buildCharacterReadinessItem` / 等价行构建时，列表路径 **`refAudioOk` 不 probe**：clone 且 path 非空可按「绑定存在」处理，或与纯函数约定 `refAudioOk: true` 跳过 fs；与项目页 assess 允许 **略不一致**（文档与 UI 不保证列表=详情逐 bit 相同）。
   - `aggregateVoiceReadinessSummary`（或 `buildSummaryFromRows` 若可注入「列表模式」）。

3. **latest task**：按 `novelId in` **一次**查询任务表，应用层每 novel 取 `updatedAt` 最新 1 条；复用 `AudiobookTaskService` 已有 list 投影字段。  
   - 若投影 **无** 廉价 `fullAudioReady`：列表「可听」用 `status === "succeeded"` 弱提示，**禁止** overview 内对每本 full-book 路径 `stat`。

4. `activeReadinessJob`：读本进程 `AudiobookVoiceReadinessService` 活跃 map；无则 false。

5. 单测必须覆盖：**给定 K 本 id，assess/findUnique-per-id 调用次数为 0**（或 mock 断言 bulk API 只打一次 DB 入口）。

#### 3.1.4 降级：A-lite（替代旧方案 B）

若批量 readiness 在目标环境仍过重/超时：

| 级别 | 列表展示 | 阶段 1 是否算交付 |
|------|----------|-------------------|
| **A（目标）** | voice 摘要 + preview 计数 + latestTask + activeJob | 完整 A1 |
| **A-lite** | **仅** latestTask（+ 可选 activeJob）；音色进项目页再看 | A1 降为「任务三态必达；音色态 best-effort 标注缺口」 |
| ~~旧 B~~ | 列表无态势、只做项目页条 | **禁止**作为阶段 1 完成定义（项目页已有 readiness） |

A-lite 落地时：Manual-required 记「列表无音色摘要」；停止条件允许有条件可交付。

### 3.2 类型与 client 落点

| 位置 | 内容 |
|------|------|
| `shared/types/audiobook.ts` | `AudiobookWorkspaceNovelOverview` 及 request/response |
| `client/src/api/novel/audiobook.ts` | `postAudiobookWorkspaceOverview` |
| `client/src/api/queryKeys.ts` | `audiobookWorkspaceOverview: (key: string) => ...`；**任务**用已有 `audiobookTasks` |
| 服务端 | `novelAudiobookRoutes` + thin overview 函数/service（可放 `audiobook` 目录，**不**改 Pipeline） |

**queryKey 建议：**

- Overview：`["novels", "audiobook-workspace-overview", page, debouncedKeyword]`  
  或 `hash(stableJoin(sortedIds))`——若用 ids，**必须稳定排序**后再 join，避免顺序抖动双缓存。  
- `staleTime`：15_000～30_000（与 readiness 同级）。  
- 项目页 create/cancel/就绪终态 / 返回 Workspace 时：`invalidateQueries` overview + tasks。

### 3.3 明确不新增

- 不为态势新建表 / 物化视图  
- 不把 preview.wav / 标注 / items[] 拉到列表  
- 不扩展 `GET .../workspace` bootstrap 载荷塞批量态势  

---

## 4. UI 规格

### 4.1 `AudiobookWorkspacePage`（选书）

保持：`max-w-4xl`、搜索、分页、打开有声书 / 编辑小说。

小说列表 `success` 后，用当前页 `items.map(i => i.id)` 调 overview（可与 list 并行：list 先出骨架，overview 到了填 badge）。

#### 4.1.1 Badge 优先级栈（编码 SoT）

**主态：仅 1 枚**（高优先在前，命中即停）：

| 优先级 | 条件 | 文案 | variant |
|--------|------|------|---------|
| 1 | `latestTask.status` ∈ `queued` \| `running` | `生成中 {progress}%` | default |
| 2 | `activeReadinessJob === true` | `就绪中` | secondary |
| 3 | `readiness != null && !readiness.voiceOk` | `缺音色` | destructive |
| 4 | `latestTask.status === "failed"` | `上次失败` | destructive |
| 5 | `latestTask` 且（`fullAudioReady === true` **或**（无该字段且 `status === "succeeded"`）） | `可听/可下` | outline |
| 6 | `readiness != null && readiness.voiceOk` | `待生成` | secondary |
| 7 | `readiness === null` 且无 latestTask | `态势暂不可用` | outline |
| 8 | 仅有 latestTask 其它终态等 | 按 5/6 兜底 | — |

**辅态：最多 2 枚**（主态已是缺音色时可不再重复 voice）：

- `音色 {voiceConfigured}/{characterTotal}`（readiness 非 null）  
- `试听 ready {n}` 或 `试听缺 {previewMissing}`（有缺失时优先展示缺）

**纯函数**：建议 `resolveAudiobookWorkspaceBadges(overview) -> { primary, secondary[] }`，单测覆盖叠态：

- 缺音色 + running → 主态生成中  
- succeeded + 新 running → 生成中  
- failed  
- readiness null + 无任务  
- voiceOk + 无任务 → 待生成  
- 0 角色 characterTotal=0 voiceOk=true  

**可生成**：主按钮不 disabled；缺音色仅 badge 提示（进项目页硬拦）。列表 **不** 发起一键就绪。

### 4.2 `AudiobookProjectPage` + 面板（项目）

#### 4.2.1 外壳

- 去掉「开发说明」厚 Card 套整面板：页头 1～2 句说明 + 面板铺在 `space-y-6`。  
- 保留：返回工作台、标题、章数/角色数 Badge、打开小说编辑。  
- 可选一句：`单章任务也需全书角色音色齐（硬门禁）`。

#### 4.2.2 三段 IA + 锚点（P1 必做）

| Section id | 标题 | 内容 |
|------------|------|------|
| `#ab-prepare` | 1. 准备音色与试听 | ReadinessSection + **默认折叠**「音色规划（高级）」 |
| `#ab-create` | 2. 旁白与生成 | 旁白、范围、requireReadyPreview、deliveryStyle、预检/生成 |
| `#ab-tasks` | 3. 任务与交付 | 最近任务、在线听/下载、标注 |

页顶 **步骤条（链接）必做**：

```text
[准备] — [生成] — [任务]
```

- `click` → `element.scrollIntoView({ behavior: "smooth", block: "start" })`  
- **不要求** IntersectionObserver 高亮（P2）  
- 满足 A2：从页顶点「生成」一次到达 `#ab-create` 主按钮区域  

#### 4.2.3 规划区权重

- 默认 `<details>` **收起**；summary：`一键就绪已覆盖缺音色；分簇重规划时展开`  
- 一键就绪 = default；规划内按钮 = outline  
- 可发现性：走查确认高级区存在即可；`sessionStorage` 记住展开 = P3  

#### 4.2.4 移动 fixed 生成条（P1）

**何时显示（移动视口）：**

- `#ab-create` 内主「生成有声书」按钮滚出可见区（`IntersectionObserver` 仅用于显隐，失败则 **常显** fixed 条，避免不可达）  
- 或简化：**移动端始终显示** fixed 条（实现更稳，优先采纳若 Observer 复杂）

**形态：**

```text
[门禁短徽标]  [预检]  [生成有声书]
```

**定位（编码 SoT）：**

- `position: fixed; inset-x: 0; z-index` 低于更多层、高于内容  
- `bottom: calc(4.25rem + env(safe-area-inset-bottom))`（与 MobileSiteShell 更多层/底栏同系；实现时对照 `MobileSiteShell.tsx` 现网数值微调）  
- 内容区不额外双计 `mobile-safe-bottom` 导致巨空白：fixed 条高度用 `padding-bottom` 垫在 `#ab-create` 或 panel 末尾一次即可  
- **桌面（lg+）：默认不渲染** fixed 条（D15）；靠锚点满足 A2  

门禁：与 `voiceGateBlocked` / `previewGateBlocked` 同逻辑。

#### 4.2.5 Toast（冻结）

| 事件 | toast | message 条 |
|------|--------|------------|
| create 成功 | success 短标题 | 可选同句或清空 |
| create / cancel / 规划写入失败 | error | 可空 |
| precheck 失败 | error 摘要 | 可写长明细 |
| precheck 通过 | success 短句 | 可写章数/试听软提示 |
| 一键就绪终态 | success/error + 一行 summary | **不要**再贴同等长文；`onMessage` 可改短或只 toast |
| 就绪 job 丢失 | error/警告 | 一句 |

**冻结**：**终态以 toast 为准**；`onMessage` 仅补长明细或调试态，禁止双份完整成功文案。

### 4.3 与 comic 对齐清单

| 项 | 做法 |
|----|------|
| 页框 | `mx-auto max-w-4xl space-y-6 px-4 py-6` |
| 标题 | `text-2xl font-semibold` + Headphones |
| 色块 | 交付 `primary/5`；准备 `muted/20` |
| 反馈 | toast 对齐 comic/drama |
| 不强制 | 新建向导、多格式卡片 |

---

## 5. 客户端 / 服务端落点

| 文件 | 变更 |
|------|------|
| `shared/types/audiobook.ts` | overview 类型 |
| `server/.../novelAudiobookRoutes.ts` | POST workspace-overview |
| `server/src/services/audiobook/*` | overview 聚合（bulk + 纯函数；**不**改 Pipeline） |
| `client/src/api/novel/audiobook.ts` | client |
| `client/src/api/queryKeys.ts` | overview key；tasks 已存在 |
| `AudiobookWorkspacePage.tsx` | overview query + badges |
| `AudiobookProjectPage.tsx` | 去厚 Card；步骤锚点容器 |
| `NovelAudiobookPanel.tsx` | section id；规划折叠；toast；**tasks → queryKeys.novels.audiobookTasks**；移动 fixed 条；可选拆文件 |
| `AudiobookVoiceReadinessSection.tsx` | 终态 toast 策略对齐 §4.2.5 |
| 可选 | `audiobookWorkspaceBadges.ts` 纯函数 + 单测 |

**禁止改：** `AudiobookPipelineService` / `deliveryStyle.ts` / `audiobookVoicePlanner` soft-target / multi-backend env 语义。

---

## 6. 阶段拆分

### 阶段 1 — 选书态势

```text
阶段编号：1
阶段目标：列表可感知任务与（目标）音色摘要
对应 P0/P1：overview + Badge 栈
可验证结果：当前页 N 本有主态 badge；叠态符合优先级；bulk 非 N assess
预计修改：shared、routes、overview 聚合、WorkspacePage、queryKeys、badge 纯函数单测
```

完成定义：

- [x] POST overview：截断 50、空 ids、鉴权省略、单本失败不整包挂  
- [x] **实现为 bulk**；测试断言无 per-id `assess`  
- [x] 列表 Badge 优先级单测  
- [x] 完整 A 或文档化 A-lite  
- [x] typecheck + 相关 test 绿  

### 阶段 2 — 项目页 IA + 交互统一

```text
阶段编号：2
阶段目标：三段可扫读 + 锚点 A2 + toast + queryKeys 接线 + 规划降权 + 移动 fixed 条
对应 P0/P1：IA / D15 / toast / D7 / D5 / D8
可验证结果：三点锚点可达生成区；移动 fixed 可点预检/生成；tasks key 统一；规划默认收起
预计修改：ProjectPage、NovelAudiobookPanel（±拆文件）、ReadinessSection toast
```

完成定义：

- [x] `#ab-prepare` / `#ab-create` / `#ab-tasks` + 页顶三链接  
- [x] 规划默认折叠  
- [x] toast 覆盖 §4.2.5（ReadinessSection 原生 + panel 创建/预检/取消）  
- [x] `queryKeys.novels.audiobookTasks` 替换硬编码，invalidate 不回归  
- [x] 移动 fixed 生成条（桌面可不渲染）  
- [x] 外层厚 Card 去掉或改薄  
- [x] **不要求** Observer 高亮、桌面 sticky  

### 阶段 3 — 走查、测试、审查、收口

```text
阶段编号：3
阶段目标：验收 + 审查 + 交叉链；停止
对应 P0/P1：质量门禁
预计修改：测试补洞、审查 fix、本文件状态、boundary 一行
```

完成定义：

- [x] §8 勾选（含 A-lite 时的有条件说明；浏览器走查 Manual-required）  
- [x] production-code-quality-review  
- [x] 阻断修复 ≤3 轮  
- [x] 总结停止；不自动部署 / 不开下一 milestone  

---

## 7. 测试计划

### 7.1 自动化

| 用例 | 意图 |
|------|------|
| overview 空 ids | `[]` 200 |
| overview >50 | 截断 50，不 400 整包 |
| 混入无权限 id | 仅返回可读项 |
| 无任务 novel | `latestTask: null` |
| **bulk** | mock：无 N 次 per-novel assess/findUnique 角色全表循环入口 |
| Badge 优先级 | 叠态表 §4.1.1 |
| 回归 | 现有 audiobook server tests 全绿 |

### 7.2 手动走查

1. 桌面：≥2 本 badge；进项目后与列表大体一致（clone probe 允许列表更宽）  
2. 三锚点跳转；折叠规划后一键就绪仍可用  
3. 缺音色：生成 disabled + 徽标  
4. 创建任务：toast + 任务区 + 默认展开策略  
5. 移动：fixed 条不被底栏挡住；可点预检/生成  
6. 任务 running：折叠保活听播  
7. 叠态：缺音色+running；failed；0 角色  
8. 项目页返回列表：overview 刷新或 stale 可接受窗口内更新  

---

## 8. 验收标准

| # | 标准 | 级别 |
|---|------|------|
| A1 | 选书页：完整 A 下能区分主态栈中至少「缺音色 / 待生成或可听 / 生成中」；A-lite 下任务相关主态必达并文档记音色缺口 | P1 |
| A2 | 页顶点「生成」或移动 fixed「生成」→ 无需通读长卷即可触发创建（门禁允许时） | P1 |
| A3 | 新建任务成功/失败有 toast | P1 |
| A4 | 音色规划默认收起或不抢主 CTA | P1 |
| A5 | 任务 query 使用 `queryKeys.novels.audiobookTasks`；invalidate 路径不回归 | P1 |
| A6 | 不改变 delivery 默认 `characters`、requireReadyPreview 默认 false、voice 硬门禁 | P0 回归 |
| A7 | overview 路径无 N 次 assess；相关单测 + typecheck 绿 | P1 |
| A8 | 代码审查无未修复 P0/P1 阻断 | P1 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
|------|------|
| overview 重评估/超时 | D12 bulk；列表不 probe；超时 A-lite |
| 列表 voice 与详情 clone 不一致 | 文档允许；进页以 assess 为准 |
| fixed 条挡底栏/双 padding | 对照 MobileSiteShell 数值；走查 |
| 拆 panel 回归听播 | 行为对照 + 手动路径 6 |
| 误以为改听感 | 说明「仅 UX」 |

回滚：前端两页 + panel；overview 只读可留。

---

## 10. Backlog（不进本 milestone）

- 按章 speaker 收窄 precheck  
- FALLBACK 生产 env  
- 完整 Tabs 多轨  
- 删除 message 条  
- 选书页一键就绪  
- TaskCenter 深链 novel_audiobook  
- 角色表虚拟滚动  
- IntersectionObserver 步骤高亮  
- 桌面 sticky 生成条  
- sessionStorage 记住规划展开  

---

## 11. 文档交叉链

| 文档 | 关系 |
|------|------|
| `audiobook-workbench-voice-readiness-plan.md` | 就绪 SoT；列表只消费摘要字段 |
| `character-voice-preview-asset-plan.md` | preview 指纹；列表 preview 计数依赖其字段 |
| `audiobook-listen-usability-p0-plan.md` | 默认 characters / unresolved；本计划不改 |
| `audiobook-segment-delivery-style-plan.md` | 表演协议；本计划不改 |
| `docs/wiki/workflows/novel-audiobook-boundary.md` | 完成后补「工作台 UX / overview」一句 |
| Obsidian 产品形态 | 用户令交付时再同步入口态势 + 三段 IA |

---

## 12. 建议 Git 节奏

```text
feat(phase-1): audiobook workspace overview bulk badges
feat(phase-2): audiobook project IA anchors toast queryKeys
fix(phase-3): audiobook workbench ux review blockers
test(phase-3): audiobook workbench ux acceptance
docs(phase-3): mark ux plan done + boundary cross-link
```

每阶段 1～3 commit；**禁止**夹带 pipeline/planner/delivery 语义改动。

---

## 13. 停止条件

满足即输出《项目交付总结》或《需人工关注报告》并 **停止**：

1. §8 P0/P1 验收通过（含 A-lite 有条件可交付说明）  
2. 阶段用尽（3）  
3. 阻断项 3 次修复仍失败  
4. overview 无法轻量验收且 A-lite 已落地并记缺口  

**不得**因 Tabs 做全 / 收窄门禁 / 开 FALLBACK / Observer 美化自动开下一阶段。

---

## 14. v1.0 → v1.1 变更摘要

| 项 | v1.0 | v1.1 |
|----|------|------|
| overview 实现 | 模糊复用 assess | **禁 N assess**；bulk + `buildSummaryFromRows` 系；列表不 probe |
| 降级 | 方案 B 掏空阶段 1 | **A-lite**（任务态必达） |
| Badge | 并列条件 | **优先级栈** + 失败态；可生成=`voiceOk` |
| A2 | 步骤条/sticky 可选冲突 | **锚点两端必做** + 移动 fixed；Observer/桌面 sticky=P2 |
| sticky | 安全区含糊 | **fixed + 底栏 4.25rem/safe-area**；滚容器事实写入 |
| queryKeys | 像新设计 | **接线已有 `audiobookTasks`** |
| bootstrap | 阶段文案写扩展 | **D14 不扩展 bootstrap** |
| toast | 二选一未选 | 终态 toast 为准 |
| 缓存/鉴权/>50 | 缺 | staleTime、invalidate、静默省略、截断 50 |
| activeJob | 当稳定信号 | **best-effort** |
| fullAudioReady | 假定有 | 廉价才填；否则 succeeded 弱提示 |
