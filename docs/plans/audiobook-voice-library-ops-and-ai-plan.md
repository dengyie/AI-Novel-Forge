# 全站音色库运营与 AI 规划 — 开发计划（D–G）

> **status: delivered (code)** · 2026-07-18  
> **生产 tip**：production / `origin/main` 代码 **`0b776e6`**（A–G + review harden + heardSha 绑定）；docs 可叠在其后  
> **前置 SoT**：`docs/plans/audiobook-sitewide-voice-library-research.md`  
> **产品**：Obsidian `ainovel 小说转有声书 产品形态` · 调研 `ainovel 全站音色库与AI规划-调研`  
> **运维 cutover**：vault `production ai-novel 部署与运维` **§七点四十九**（heardSha + approve token live）/ §七点四十八 / §七点四十七 / §七点四十五（harden）/ §七点四十四（ABC）  
> **原则**：里程碑驱动；每里程碑 ≤3 阶段；禁 auto-approve seeds；禁客户端裸 `ttsRefAudioPath`；生产 `AUTH_ALLOW_OPEN` 下能力限制必须在 **service/HTTP**；approve 另叠 env token + heardSha。

---

## 0. 现状（以 main@0b776e6 为准）

### 已交付

| 层 | 现状 |
|---|---|
| 库存储 | JSON registry `storage/voice-refs/global`；`primaryFile.path` 相对 voice-refs；文件锁 `mutateRegistry`；损坏 quarantine |
| Character | `ttsVoiceAssetId` + denormalize 绝对 `ttsRefAudioPath`（bind 时）；runtimeMigrations 幂等列 |
| API | list/get/**import-file**/import-seed-pack/status/bind + **media-access/audio/rewrite** |
| 安全 harden | import/seed **禁** `approved`；`sourcePath`/`packRoot` allowlist；list limit/offset 有限；skipProbe 仍 `tryResolve(requireApproved)` |
| Planner B | `prefer_library`；suggest 仅注入 approved clone_ref；apply clone 只经 assetId + assertBindable |
| 工作台 C | `CharacterVoiceEditor` approved 库选择器；base64 覆盖清 assetId；`decideCharacterVoiceRefUpdate` 顺序 |
| D 管理台 | SPA `/audiobook/voice-library` list/filter/import draft；picker q/分页 |
| E 人耳 | 库级试听；`review.heardAt` + **`heardSha256`**；approve 须 heard 且 sha≡primaryFile |
| F token | 生产 **已设** `VOICE_LIBRARY_APPROVE_TOKEN`；升 approved 须 `X-Voice-Library-Approve-Token` |
| G rewrite | `POST .../voice-design/rewrite` 候选 `applied:false`；`source=llm` / `rule_fallback` + `fallbackReason` |
| 生产 | production **`0b776e6`**；approve token live；E2E API 绿；库可有 draft/archived 测试项 |

### 本计划 P0/P1 缺口

**无**（D–G 代码 + 生产 cutover + API E2E 已闭环）。

### 仍 Manual-required（不阻塞代码交付）

1. 浏览器管理台：sessionStorage 填 approve token → **真人播放** → 点 approve  
2. 真 LLM redesign 听感（API `source=llm` 已验；人耳听 design 试听未编造）  
3. seed 包经 EarAgent / 播放写入 heard 后升 approved（**禁止** import 直批 approved；AI 耳可自动升权）

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

### 3.7 交付记录（2026-07-18）

| 项 | 状态 |
|---|---|
| E1 库级 media-access + GET audio（clone_ref 直播 ref.wav；draft 可听） | ✅ |
| E2 管理台试听 + session「已听」+ 单条 approve | ✅ |
| E3 勾选 batch 仅已听项；零 auto-approve | ✅ |
| 服务 `resolveLibraryPreviewAudioPath` + 单测 | ✅ |
| **heardSha harden `0b776e6`**：`review.heardBy`/`heardSha256`；import/overwrite **清 review**；同 sha 二次 mark **skip 写锁**；`setStatus(approved)` 要求 heardAt 且 sha≡`primaryFile.sha256`；UI 批准前 GET 预检 | ✅ |

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

### 4.7 交付记录（2026-07-18）

| 项 | 状态 |
|---|---|
| F1 `VOICE_LIBRARY_APPROVE_TOKEN` + header 校验 + timing-safe + 单测 set/unset | ✅ |
| F2 管理台 sessionStorage token 输入；403 文案 | ✅ |
| F3 audit 日志 `voice_library_status … ok=`（无 token 明文） | ✅ |
| 未设 env 与现网兼容 | ✅ |
| **生产 F3 live**：production `server/.env` **已设** token（不进 git）；无/错 token → **403**；正确 token + heardSha → approved | ✅ |

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

### 5.7 交付记录（2026-07-18）

| 项 | 状态 |
|---|---|
| G1 `voiceDesignRewriteService` + mock LLM 单测 + rule_fallback | ✅ |
| G2 `POST .../characters/:charId/voice-design/rewrite` 仅候选 | ✅ |
| G3 角色卡 design 模式：生成候选 → 预览 → 应用到表单 | ✅ |
| 生产 E2E：rewrite `source=llm`、`applied=false`（林逸） | ✅ API |
| 真模型听感 / 浏览器 UI 应用 | Manual-required |

---

## 6. 跨里程碑安全不变量（回归必测）

1. 客户端 **永不**提交任意可写 `ttsRefAudioPath`（仅 null / 服务端字段）。  
2. bind / plan apply clone / execute TTS：**恒** `requireApproved`。  
3. import / seed：**永不**落地 approved。  
4. `sourcePath` 仅 allowlist。  
5. registry 损坏 **不**静默空库。  
6. 列表 skipProbe：**不**盲信幽灵 assetId。  
7. **不** forceResume；**不**编造听感/真机结果。  
8. **`setStatus(approved)` + clone_ref**：须 `review.heardAt` 且 `review.heardSha256 === primaryFile.sha256`。  
9. import/overwrite：**清 `review: null`**（防旧 heard 批准新音频）。  
10. 生产若设 `VOICE_LIBRARY_APPROVE_TOKEN`：升 approved **必须**正确 header（timing-safe）；token **永不**进 git/bundle。

单测锚点：`server/tests/voiceLibraryService.test.js`、`characterVoiceRefUpdate.test.js`、`audiobookWorkspaceOverview.test.js`、planner library tests。

---

## 7. 文档与部署

| 动作 | 位置 |
|---|---|
| 本计划 | `docs/plans/audiobook-voice-library-ops-and-ai-plan.md`（本文） |
| SoT 摘要 | `docs/plans/audiobook-sitewide-voice-library-research.md` 链到本文 |
| 开发入口 | `docs/DEVELOPMENT.md` / `docs/README.md` 有声书工作流 |
| 运维 tip | vault **§七点四十九**（`0b776e6` heardSha + token）；历史 §四十四–四十八 |
| Obsidian 调研 | `ainovel 全站音色库与AI规划-调研` · 索引 `ainovel 文档索引` |

Cutover 惯例不变：Mac pack **`client/dist`+`server/dist`** → scp → `git reset --hard origin/main` → extract → **re-link storage/tmp** → `pnpm -C server prisma:generate` → restart novel-server → `curl --noproxy '*'` smoke（机上勿裸 curl，supervisord 代理会 404）。

### 7.1 管理台 Manual 路径（浏览器）

1. 打开 `https://example.com/audiobook/voice-library`  
2. 若生产已设 approve token：在管理台输入框粘贴 token（**sessionStorage**，不进 git）  
3. 对 draft `clone_ref`：**真人点播放** → 等 GET audio 完成 → 再 Approve  
4. 预期：未听 / sha 失配 → 拒绝；无 token → 403；齐备 → approved 进 picker  

---

## 8. 历史执行契约（开 D 时曾用；已完成）

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

D–G + heardSha 均已满足停止条件；**勿**自动开 QFP / P2-7 / listen M1–M6。

---

## 9. 变更记录

| 日期 | tip / 提交 | 说明 |
|---|---|---|
| 2026-07-18 | **`0b776e6`** | heardAt↔`primaryFile.sha256`；overwrite 清 review；同 sha skip mark；UI 预检；**生产 approve token live**；E2E API 绿；vault §七点四十九 |
| 2026-07-18 | `791c64d` | media whitelist + heardAt 门禁 + rewrite 可观测 |
| 2026-07-18 | `1d00fb6` | Milestone E/F/G 功能：库试听/人耳 approve/token 门禁/LLM rewrite |
| 2026-07-18 | Milestone D `dc95736` | 库管理台 SPA + picker q/分页；见 §2.6 |
| 2026-07-18 | `661c372` | 本计划文档上 main |
| 2026-07-18 | `1b7078b` | harden live；本计划立项 |
| 2026-07-18 | A/B/C `5ed6c25` | 库+planner+picker 生产基线 |


---

## 全 AI 匹配 + AI 耳（2026-07-21）

详见 [audiobook-ai-voice-match-auto-ear-plan.md](./audiobook-ai-voice-match-auto-ear-plan.md)。

- profile：`ear_auto` / `library_ai_fill`
- LabelAgent `label:ai-v3` 可赋 lead
- VoiceBrief + `prefer_library_ai`；Ready design/preset fallback
