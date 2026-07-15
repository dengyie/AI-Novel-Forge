# 人物卡固定试听资产（Character Voice Preview Asset）

> 状态：已完成（2026-07-16）  
> 范围：AI Novel 角色音色试听从「每次在线生成」改为「角色卡固定资产 + 播放只读」  
> 生产：pxed + `ainovel.mangoq.ccwu.cc`；blob 落 `server/storage`（生产 symlink → `/share/archive/ainovel/storage`）

## 0. 执行契约

```text
Milestone：人物卡固定试听资产
目标：试听音成为角色卡固定资产；点播放不打 TTS；在线生成只在角色资产工作台完成；有声书台只读消费。
P0/P1 范围：
  - Character 试听字段 + 磁盘 preview.wav + 指纹失效
  - generate / status / audio API
  - CharacterVoiceEditor：生成 / 播放分离；未保存禁止生成
  - 角色列表与焦点条展示试听状态；有声书工作台只读播放 + 跳转提示
  - 必要单测 + 类型检查
不做的 P2/P3：
  - 批量队列生成、自定义多段试听、供应商 voice id 持久化
  - AI_NOVEL_DATA_ROOT 大重构、第二套全局音色中心
  - 为旧 ephemeral preview 保留长期产品入口
Manual-required：
  - 生产 pxed 发布后人工：生成 → 播放零 TTS → 改配置 stale → 重生成；确认 realpath 在 /share/archive
阶段上限：3
阶段拆分：
  1) 数据模型 + 路径 + 服务 + API + 类型
  2) 人物卡 UI（生成/播放/失效）
  3) 工作台闭环（列表状态、有声书只读）+ 测试审查
验收标准：见 §8
停止条件：P0/P1 完成并通过必要验证；或外部依赖阻断验收
```

## 1. 产品标准（SoT）

| 概念 | 标准 |
|------|------|
| 音色配置 | `ttsMode/ttsVoice/ttsStyle/ttsDesignPrompt/ttsRefAudioPath/ttsSpeakerAliases`（已有） |
| 试听资产 | 角色级固定 WAV + 元数据；与配置同生命周期 |
| 生成试听 | 显式动作：基于**已保存**配置 TTS → 落盘 → 写角色字段 |
| 播放试听 | 只读磁盘资产；**禁止**默认同步打上游 |
| 配置脏 | 未保存音色时禁止生成 |
| 指纹失效 | 配置变更后 status=`stale`，可播旧版并提示重生成 |
| 主操作台 | 小说「角色资产工作台」内 `CharacterVoiceEditor` |
| 消费台 | 有声书工作台：播固定试听 / 提示去角色台生成；不提供改配+在线生成 |

文案：

- **生成试听** / **重新生成**
- **播放试听**
- 不再用「试听」一词同时表示生成与播放

## 2. 冻结决策

1. **脏表单**：未保存禁止生成（必须先「保存音色」）。  
2. **过期试听**：允许播放旧版 + `stale` 提示。  
3. **旧** `POST /novels/:id/audiobook/voice-preview`：保留实现但**产品 UI 不再调用**；服务端若带 `characterId` 则改为「生成并固化」以兼容残留调用；无 `characterId` 仍可 ephemeral（工具/调试，不写卡）。  
4. **样例句**：默认系统短句；生成时可可选 `text`，写入 `ttsPreviewSampleText`。  
5. **批量生成**：本 milestone 不做。

## 3. 数据模型

### 3.1 Character 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `ttsPreviewAudioPath` | `String?` | 试听 WAV 路径 |
| `ttsPreviewSampleText` | `String?` | 生成时样例句 |
| `ttsPreviewFingerprint` | `String?` | 生成时配置指纹 |
| `ttsPreviewGeneratedAt` | `DateTime?` | 生成时间 |

双 schema：`schema.prisma` + `schema.sqlite.prisma`。  
SQLite 生产/dev：`runtimeMigrations` 列回填 + `migrations/20260716093000_character_tts_preview`。

### 3.2 磁盘

```text
storage/voice-refs/{novelId}/{characterId}/
  ref.*        # clone 参考（已有）
  preview.wav  # 固定试听
```

助手：`resolveCharacterVoicePreviewPath` / `writeCharacterVoicePreviewFromBase64`（与 ref 对称，atomic write）。

### 3.3 指纹

规范化后 SHA256 hex（可截断 32）：

```text
mode|voice|style|designPrompt|refAudioPath|sampleText
```

`status`：

- `missing`：无 path 或文件不存在  
- `ready`：文件在且 fingerprint == 当前配置指纹  
- `stale`：文件在且 fingerprint 不匹配  

## 4. API

挂在角色路由（与 `PUT /:id/characters/:charId` 同模块）：

```http
POST /novels/:novelId/characters/:charId/voice-preview/generate
Body: { "text"?: string }

GET  /novels/:novelId/characters/:charId/voice-preview
→ { status, sampleText, fingerprint, currentFingerprint, generatedAt, audioUrl?, characterId, characterName, ttsMode, ... }

GET  /novels/:novelId/characters/:charId/voice-preview/audio
→ stream audio/wav（鉴权同角色资源；路径须在 voice-refs 目录内）
```

`generate`：

1. 读库中已保存音色；校验 mode 完备（preset/design/clone）  
2. TTS synthesize  
3. 写 `preview.wav`，更新四字段  
4. 返回 status + `audioUrl`（及可选 base64 便于首播，优先 URL）

角色 list/detail 自然带上新字段（`findMany` 全量）；bootstrap 可附 `voicePreviewStatus` 摘要（阶段 3）。

删除角色：尽量 unlink preview（与 ref 同目录，目录级清理可二期；本阶段 delete 时 safeUnlink preview path）。

## 5. UI

### 5.1 `CharacterVoiceEditor`

- 按钮：`保存音色` | `生成试听`/`重新生成` | `播放试听`  
- 生成：`dirty` → 禁用并提示先保存；调用 generate API  
- 播放：`ready|stale` 用 `audioUrl`；`missing` 禁用  
- 展示 status / 时长 / stale 文案  
- 移除对 `previewAudiobookVoice` 的产品依赖  

### 5.2 焦点条 / 列表

- 徽章：`试听✓` / `试听过期` / `无试听`（在有声书音色徽章旁）  

### 5.3 有声书面板

- 有资产则播放 URL  
- 无资产：文案引导角色资产工作台（不在此页 generate）  

## 6. 代码落点

| 层 | 文件 |
|----|------|
| 路径 | `server/src/services/audiobook/audiobookPaths.ts` |
| 服务 | `AudiobookVoiceAssetService` 扩展 generate/status；或 `CharacterVoicePreviewService` |
| 指纹 | `server/src/services/audiobook/characterVoicePreview.ts`（纯函数便于测） |
| 路由 | `novelSnapshotCharacterRoutes` 或 audiobook routes 下 character 子路径 |
| Schema | prisma 双文件 + runtimeMigrations + migration sql |
| 类型 | `shared/types/novelCharacter.ts`、`shared/types/audiobook.ts` |
| 客户端 API | `client/src/api/novel/characters.ts` 或 `audiobook.ts` |
| UI | `CharacterVoiceEditor.tsx`、helpers、`CharacterFocusSummary`、有声书 panel |
| 测试 | server 指纹/路径；client helpers status |

## 7. 阶段验收

### 阶段 1

- 字段可读写；generate 后磁盘与 DB 一致  
- status 三态单测  
- 播放 GET 能 stream  

### 阶段 2

- UI 生成/播放分离；dirty 门禁  
- 同配置二次播放不触发 generate  

### 阶段 3

- 列表/焦点状态；有声书只读  
- client/server 相关测试绿；类型检查通过  

## 8. 总验收

1. 同一配置连续点「播放试听」零次上游 TTS（仅 GET audio）  
2. 改音色配置后 status=stale，重生成后 ready  
3. 未保存配置无法生成  
4. preview 文件在 `storage/voice-refs/...`（生产在 archive 挂载）  
5. 有声书面板不提供在线改配生成入口  

## 9. 非目标与反模式

- 不把 WAV 写入 DB  
- 不在打开角色卡时自动 TTS  
- 不 fail-open 把 ephemeral base64 当固定资产  
- 不为文档/证据单独开阶段  

## 10. 提交约定

```text
feat(phase-1): character fixed voice preview asset model+api
feat(phase-2): character card generate/play split for voice preview
feat(phase-3): workbench preview status + audiobook read-only play
test(phase-X): ...
```
