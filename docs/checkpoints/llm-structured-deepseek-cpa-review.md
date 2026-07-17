# LLM Structured Output × DeepSeek × CPA 全面 Review

日期：2026-07-13  
范围：`server/src/llm/*` structured invoke / reasoning / fallback  
触发：生产导演任务卡死；用户确认 CPA 模型本身可用

## 1. 现象

- 导演在「准备本书世界」长时间失败 / 请求失败。
- 用户侧 CPA 直连模型正常。
- 日志：
  - `provider=openai model=deepseek-v4-pro ... Request was aborted` `latencyMs≈300000`
  - `errorCategory=transport_error`
  - primary `deepseek-v4-flash` 能出内容但 schema repair 循环
  - fallback 到 pro 后空转超时

## 2. 根因链（不是单一 bug）

```text
AppSetting.structuredFallback.chain
  provider=openai + model=deepseek-v4-pro   ← 配置层
        ↓
isDeepSeekThinkingModeProvider()
  只认 provider=deepseek 或 host=api.deepseek.com
  CPA 场景返回 false                         ← 检测层
        ↓
structuredProfile.requiresNonThinkingForStructured = false
  无法 force-disable thinking                ← profile 层
        ↓
CPA 返回 content=null, reasoning_content=...  ← 协议层
        ↓
toText(result.content) → 空 / "null"         ← 解析层
        ↓
repair 循环 → fallback pro → 300s abort      ← 级联层
```

旁证（pxed 实测）：

| 调用 | 结果 |
|---|---|
| CPA `/v1/models` 代理/直连 | 200 |
| flash chat | 200 |
| pro chat 普通 | 200 ~4s |
| pro + `response_format=json_object` | **content=null**，仅 reasoning |
| grok-4.5 structured | 正常 15–36s |

## 3. 设计缺陷（Review 结论）

| # | 缺陷 | 严重度 |
|---|---|---|
| D1 | Thinking 能力检测绑定 **provider 枚举/官方 host**，不认 **model id** | P0 |
| D2 | DeepSeek structured profile **未**声明 `requiresNonThinkingForStructured` | P0 |
| D3 | Fallback 默认链与生产 DB 使用 `openai+deepseek-*` 组合 | P0 |
| D4 | `toText(result.content)` 对 `null` content 无 reasoning 回退 | P1 |
| D5 | `toText(null)` 经 `JSON.stringify` 语义差（空结构） | P1 |
| D6 | 读 DB 设置时不做 hop 规范化，坏配置会永久复现 | P1 |
| D7 | 官方 host regex 与 reasoning 侧不一致（`api.deepseek.com` vs 更宽） | P2 |
| D8 | Abort/timeout 被标 `transport_error`，与真网络故障难区分 | P2 |
| D9 | Fallback chain 与 primary 同 model 不同 provider 时 dedupe key 过粗/过细需文档化 | P3 |

## 4. 代码层修复（本分支）

分支：`fix/llm-structured-deepseek-cpa-proxy`

### 4.1 `reasoning.ts`

- `normalizeModelId` / `isDeepSeekThinkingCapableModelId` / `isDeepSeekFamilyModelId`
- `isDeepSeekThinkingModeProvider`：**model id 权威**；`openai|siliconflow|custom_gateway` + 任意 OpenAI 兼容 baseURL 命中
- thinking kwargs 同时下发 `thinking.type` 与 `enable_thinking`（兼容不同网关）
- `includeRawResponse: true` 便于抽 reasoning
- **新增** `extractMessageTextForStructuredOutput`：content 优先，空则尝试 `reasoning_content` 中的 JSON

### 4.2 `structuredOutput.ts`

- DeepSeek family 判定含 model id（含 org/prefix）
- `deepseek-v4-pro` / `reasoner`：`requiresNonThinkingForStructured` + `supportsReasoningToggle`

### 4.3 `structuredFallbackSettings.ts`

- 默认链 provider：`deepseek` 而非 `openai`
- `coerceProviderForModelId`：读库/normalize hop 时 `openai+deepseek-*` → `deepseek`
- 持久坏配置在 **read path** 自愈

### 4.4 `structuredInvoke.ts` / `structuredInvokeRepair.ts`

- 用 `extractMessageTextForStructuredOutput` 替代裸 `toText(result.content)`

### 4.5 测试

- 更新 `reasoningHandling.test.js`、`structuredFallbackSettings.test.js`
- 新增 `structuredOutputDeepseekProxy.test.js`
- **17/17 pass**

## 5. 生产热修

- pxed `dist/llm/*` 已同步本分支编译产物
- `AppSetting` chain 已改为 deepseek → flash → grok-4.5
- `novel-server` 已重启

## 6. 未做 / 后续建议

1. **合入 main 并发版**，避免下次发布覆盖 dist 热修。  
2. UI/设置页保存 fallback 时同步调用 `coerceProviderForModelId`，避免再写入 openai+deepseek。  
3. 将 abort 与真 transport 错误分类拆开（日志/告警）。  
4. world.generate schema 过严导致 flash repair 循环：可另开「schema 宽松/提示词」优化，与本次 provider 修复正交。  
5. 考虑 structured 路径默认 `reasoningEnabled=false` 对所有 `requiresNonThinking` 模型做二次断言日志。

## 7. 验收清单

- [x] unit：CPA openai+pro 识别 thinking  
- [x] unit：profile requiresNonThinking  
- [x] unit：coerce openai+deepseek → deepseek  
- [x] unit：null content → reasoning JSON  
- [x] pxed dist 部署 + DB 配置  
- [x] health 恢复  
- [ ] 导演全链路到章节 pipeline（监管任务继续）
