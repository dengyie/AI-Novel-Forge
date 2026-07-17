# 全站音色库运营与 AI 规划 — 开发计划（D–G）

> **status: active** · 2026-07-18  
> **基线 tip**：生产 / `origin/main` **`1b7078b`**（A/B/C + harden 已 live）  
> **前置 SoT**：`docs/plans/audiobook-sitewide-voice-library-research.md`  
> **产品**：Obsidian `ainovel 小说转有声书 产品形态` · 调研 `ainovel 全站音色库与AI规划-调研`  
> **运维 cutover**：vault `pxed ai-novel 部署与运维` §七点四十四（ABC）/ §七点四十五（harden）  
> **原则**：里程碑驱动；每里程碑 ≤3 阶段；禁 auto-approve seeds；禁客户端裸 `ttsRefAudioPath`；生产 `AUTH_ALLOW_OPEN` 下能力限制必须在 **service/HTTP**，不假设 token 门禁。

---

## 0. 现状（以 main@1b7078b 为准）

### 已交付

| 层 | 现状 |
|---|---|
| 库存储 | JSON registry `storage/voice-refs/global`；`primaryFile.path` 相对 voice-refs；文件锁 `mutateRegistry`；损坏 quarantine |
| Character | `ttsVoiceAssetId` + denormalize 绝对 `ttsRefAudioPath`（bind 时）；runtimeMigrations 幂等列 |
| API | `GET/POST .../novels/audiobook/voice-library*`：list/get/import-file/import-seed-pack/status/bind |
| 安全 harden | import/seed **禁** `approved`；`sourcePath`/`packRoot` allowlist；list limit/offset 有限；skipProbe 仍 `tryResolve(requireApproved)` |
| Planner B | `prefer_library`；suggest 仅注入 approved clone_ref；apply clone 只经 assetId + assertBindable |
| 工作台 C | `CharacterVoiceEditor` approved 库选择器；base64 覆盖清 assetId；`decideCharacterVoiceRefUpdate` 顺序 |
| 生产 | pxed **`1b7078b`**；公网 voice-library 200 **空库**（无 approved） |

### 缺口（本计划范围）

1. **库管理 UI**：运营侧 list/filter/import/seed/status/详情；不仅角色卡 picker  
2. **种子人耳 approve 闭环**：可听 preview → 批量/单个 draft→approved；**禁止**一键全库 auto-approve 无试听  
3. **真 LLM design rewrite**：design 文案质量与 redesign 入口（非规则模板拼装）  
4. **setStatus 二次门禁**：open 单租户下限制「谁能 approved」的运维面（env / confirm token / audit），不破坏现有人耳 PATCH 路径  

### 明确不做（本计划外 / P2+）

- marketplace / 公网音色商店  
- embedding 撞车推荐  
- 默认第二 TTS 引擎  
- 伪造 M1–M6 听感通过  
- forceResume 写书 / 自动 resume 生产  
- 改生产 `AUTH_ALLOW_OPEN=false`（单租户产品决策保留）

---

## 1. 里程碑拆分

| ID | 名称 | 目标用户能力 | 依赖 |
|---|---|---|---|
| **D** | 库管理台 + list UX | 运营在 SPA 内浏览/筛选/导入 draft、看详情；picker 分页/检索 | harden list offset |
| **E** | 种子人耳 approve | 导入 seed → 逐条试听 → 单条/勾选 approve；审计字段 | D 详情 + 现有 setStatus/wav |
| **F** | setStatus 运维门禁 | open 模式下 approved 需 `VOICE_LIBRARY_APPROVE_TOKEN` 或等价确认头；写 audit 日志 | E 的 approve 路径 |
| **G** | LLM design rewrite | design 模式角色可一键 redesign prompt（专用 Provider）；结果可预览再 apply | 现有 design 管线 + model routes |

**推荐实现顺序：D → E → F → G。**  
F 可与 E 同 PR 若阶段预算允许，但 **不得**在无 UI 试听前自动 approve。  
G 不阻塞 E/F 生产可用。

每里程碑默认 **≤3 阶段**；本文件只定契约与边界，实现时另开会话输出执行契约。

---

## 2. Milestone D — 库管理台 + list UX

### 2.1 目标

- 新增 **全站音色库管理页**（或有声书工作台二级页），覆盖运营动作，不塞进角色卡。  
- 角色卡 picker 补齐：**q + status=approved + limit/offset + total**（服务端已支持 offset）。

### 2.2 现状代码锚点（main）

| 区域 | 路径 |
|---|---|
| HTTP | `server/src/modules/novel/production/http/novelAudiobookRoutes.ts` `GET /audiobook/voice-library` |
| Service | `server/src/services/audiobook/voiceLibraryService.ts` `list/getById/importFromFile/importYuanworldSeedPack/setStatus` |
| Client API | `client` `listVoiceLibrary` / `getVoiceLibraryAsset` / `bindVoiceLibraryAsset`（角色卡用） |
| 角色卡 | `client/src/pages/novels/components/CharacterVoiceEditor.tsx` |
| 类型 | `shared/types/audiobook.ts` `VoiceAssetListQuery`（已有 limit/offset） |

### 2.3 阶段建议

1. **D1 API/Client 契约**：list 响应已有 `total`；client 封装 `offset/q/status/kind/tag`；管理页路由注册（只读 list/get 先）。  
2. **D2 管理页 UI**：表格/卡片 list + 筛选 + 分页；详情抽屉（meta/license/tags/path 相对路径展示，**不**暴露任意服务器绝对路径给可写表单）。  
3. **D3 导入入口**：UI 调 import-file / import-seed-pack（**无** approved 选项）；成功后跳 draft 列表。

### 2.4 验收

- 空库 / draft-only / approved 筛选正确  
- picker 与管理页共用 list API；NaN limit 不炸  
- 无客户端写 `ttsRefAudioPath`  
- 不引入 auto-approve

### 2.5 不做

- 在线编辑 WAV  
- 删除资产物理文件（可后续 soft archive only）

### 2.6 交付记录（2026-07-18）

| 项 | 状态 |
|---|---|
| D1 client `offset` + import-file / seed-pack 封装 | ✅ |
| D2 `/audiobook/voice-library` 管理页 list/filter/pagination/详情 | ✅ |
| D3 导入种子 + allowlist 路径 WAV（固定 draft，无 approved 控件） | ✅ |
| 工作台入口「全站音色库」 | ✅ |
| 角色卡 picker：`q` + 加载更多（limit 递增，offset=0） | ✅ |
| auto-approve / 客户端写 path | ❌ 未引入 |

---

## 3. Milestone E — 种子人耳 approve 闭环

### 3.1 目标

运营对 **draft clone_ref** 完成：听 → 判 → `PATCH status=approved`（单条优先；批量仅「已听过」勾选）。

### 3.2 现状锚点

- `voiceLibraryService.setStatus(id, "approved")`：已校验 wav + license  
- 种子 `docs/voice-packs/05-yuanworld-seed-from-mimo`；import 恒 draft  
- 角色试听：`AudiobookVoiceAssetService.generateCharacterPreview`（绑库后）  
- **缺口**：管理台对 **未绑角色** 的资产试听；无「听过」状态

### 3.3 设计决策（冻结）

| 决策 | 选择 | 理由 |
|---|---|---|
| 试听载体 | 服务端对 asset 生成 **库级 preview**（写入 `voice-refs/global/assets/{id}/preview.wav` 或 tmp），不强制先绑角色 | 人耳在 approve 前 |
| 批量 approve | 仅 UI 多选 + 每条仍调 setStatus；**禁止** `forceStatus=approved` 回潮 | harden 契约 |
| 听过标记 | registry 可选 `review.heardAt` / `review.heardBy`（轻量字段）或先用客户端 session 勾选 | 最小可用可先 session，再持久化 |
| 失败 | wav 非法 / 缺 license → 400，保持 draft | 已有 setStatus 门禁 |

### 3.4 阶段建议

1. **E1 库级 preview API**：`POST .../voice-library/:assetId/preview` + `GET` 音频（media token 复用现有模式）。  
2. **E2 管理台试听 + 单条 approve UI**：调 setStatus；错误 toast。  
3. **E3 可选 batch**：多选仅对 preview 成功项启用；单测 setStatus 路径不变。

### 3.5 验收

- 生产 seed import → 全 draft → 人耳后单条 approved 出现在 picker  
- **零** auto-approve 代码路径  
- Manual：真耳听 3 条种子再批

### 3.6 Manual-required

- 人耳听感（不可自动化通过）  
- 生产 seed 是否入库由运营决定（默认可不导入）

---

## 4. Milestone F — setStatus 运维门禁

### 4.1 目标

在 **保持 `AUTH_ALLOW_OPEN`** 的前提下，降低「任意公网 POST 把 draft 提权为 approved」的面。

### 4.2 方案（推荐）

| 项 | 约定 |
|---|---|
| Env | `VOICE_LIBRARY_APPROVE_TOKEN`（可选）。**未设置**：行为与现网一致（兼容单租户运维，文档标明风险）。**已设置**：`PATCH .../status` 且 `status=approved` 必须带 header `X-Voice-Library-Approve-Token: <token>`，否则 401/403。 |
| 范围 | 仅 **升到 approved**；draft/archived/deprecated 不要求 token（或同样要求，实现时二选一并写死） |
| 审计 | server 日志一行：`voice_library_status assetId=… from=… to=approved ok=1`（无 token 明文） |
| HTTP | 管理台 approve 按钮在 env 配置后要求填 token（sessionStorage，不进 git） |

### 4.3 现状锚点

- `server/src/middleware/auth.ts` open 模式  
- routes `PATCH /audiobook/voice-library/:assetId/status`  
- **不**改全局 auth，只在 voice library status 路由/service 分支

### 4.4 阶段建议

1. **F1** service/route 读 env + header 校验 + 单测（set/unset env）  
2. **F2** 管理台 token 输入与 403 提示  
3. **F3** vault/ops 记录生产是否设置 token（Manual）

### 4.5 验收

- 无 env：现网兼容  
- 有 env：无 header → 拒绝 approved；有 header → 与 setStatus 校验叠加  
- import 仍永远不能 approved

### 4.6 不做

- 完整 RBAC / 多用户账号体系  
- 把 token 写进前端 bundle

---

## 5. Milestone G — 真 LLM design rewrite

### 5.1 目标

对 **design 模式**角色（及可选库内 `design_prompt` 资产）提供 **专用 Provider** 的 redesign：输入角色卡字段 → 输出可审的 designPrompt → 人确认后写入。

### 5.2 现状锚点

- `audiobookVoicePlanner.ts` / design prompt 质量 v1.2（规则 + soft-target）  
- `AudiobookVoiceAssetService` Design→Clone  
- model routes / Provider 配置（CPA）  
- **缺口**：无独立「LLM redesign」HTTP + UI；planner 非对话式 rewrite

### 5.3 设计决策

| 决策 | 选择 |
|---|---|
| 触发 | 工作台角色卡「重写设计描述」+ 可选库管理对 design_prompt 资产 |
| 模型 | 复用现有 audiobook/voice 相关 route key（新建 `voice_design_rewrite` route，可指到 CPA 模型） |
| 输出 | 纯文本 designPrompt + 可选 tags；**不**直接改 ttsMode/clone |
| 安全 | 输出长度 cap；禁注入 path；人确认前不写库/角色 |
| 与 prefer_library | redesign **不**自动绑 clone；库推荐仍走 B |

### 5.4 阶段建议

1. **G1** server：prompt 模板 + Provider 调用 + 单测 mock  
2. **G2** `POST .../characters/:id/voice-design/rewrite` 返回候选；不落库  
3. **G3** 客户端预览 → 应用写入 `ttsDesignPrompt`

### 5.5 验收

- mock Provider 单测稳定  
- Manual：真模型一条 redesign 可听 design 试听  
- 失败不污染角色卡

### 5.6 不做

- 自动 Design→Clone 全自动无人审  
- 多模型辩论

---

## 6. 跨里程碑安全不变量（回归必测）

1. 客户端 **永不**提交任意可写 `ttsRefAudioPath`（仅 null / 服务端字段）。  
2. bind / plan apply clone / execute TTS：**恒** `requireApproved`。  
3. import / seed：**永不**落地 approved。  
4. `sourcePath` 仅 allowlist。  
5. registry 损坏 **不**静默空库。  
6. 列表 skipProbe：**不**盲信幽灵 assetId。  
7. **不** forceResume；**不**编造听感/真机结果。

单测锚点：`server/tests/voiceLibraryService.test.js`、`characterVoiceRefUpdate.test.js`、`audiobookWorkspaceOverview.test.js`、planner library tests。

---

## 7. 文档与部署

| 动作 | 位置 |
|---|---|
| 本计划 | `docs/plans/audiobook-voice-library-ops-and-ai-plan.md`（本文） |
| SoT 摘要 | `docs/plans/audiobook-sitewide-voice-library-research.md` 链到本文 |
| 开发入口 | `docs/DEVELOPMENT.md`「当前推进中计划」增加链接（若该文件纳入版本） |
| 运维 tip | vault §七点四十五 起；每里程碑 cutover 追加 § |
| Obsidian 调研 | `ainovel 全站音色库与AI规划-调研` 链到仓库计划 |

Cutover 惯例不变：Mac dist tarball → scp → `git reset --hard origin/main` → extract → **re-link storage/tmp** → `pnpm -C server prisma:generate` → restart novel-server → `--noproxy` smoke。

---

## 8. 建议首轮执行契约（开 D 时粘贴）

```text
Milestone：D 库管理台 + list UX
目标：SPA 可运营浏览/筛选/导入 draft；picker 分页检索
P0/P1：list client offset/q；管理页只读+导入；无 auto-approve
不做的 P2/P3：删除资产、RBAC、LLM rewrite、seed 批量无试听
Manual-required：无（空库可验）
阶段上限：3
阶段拆分：D1 契约 → D2 管理 UI → D3 导入入口
验收标准：筛选/分页正确；import 无 approved 控件；harden 单测仍绿
停止条件：D P0/P1 完成或阶段用尽
```

---

## 9. 变更记录

| 日期 | tip / 提交 | 说明 |
|---|---|---|
| 2026-07-18 | Milestone D | 库管理台 SPA + picker q/分页；见 §2.6 |
| 2026-07-18 | `661c372` | 本计划文档上 main |
| 2026-07-18 | `1b7078b` | harden live；本计划立项 |
| 2026-07-18 | A/B/C `5ed6c25` | 库+planner+picker 生产基线 |
