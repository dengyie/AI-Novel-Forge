# Prompting Registry

`server/src/prompting/` 是本项目产品级 prompt 的唯一新增管理入口。

## Hard Rules

- 新增产品级 prompt 必须定义为 `PromptAsset`。
- 新增产品级 prompt 必须放在 `server/src/prompting/prompts/<family>/` 下。
- 新增产品级 prompt 必须在 `server/src/prompting/registry.ts` 注册。
- 新增业务能力不得在 service 内直接拼 `systemPrompt/userPrompt` 后调用 `invokeStructuredLlm`。
- 新增业务能力不得在 service 内直接使用裸 `getLLM()` 发起产品级 prompt 调用。
- 修改到旧的未纳管 prompt 业务链路时，默认一并迁入 registry，而不是继续在原文件扩写。

## Allowed Exceptions

- `server/src/llm/structuredInvoke.ts` 内部 JSON repair prompt。
- `server/src/llm/connectivity.ts` 这类探活/连通性探针。
- 二期范围内的 `graphs/*`、`routes/chat.ts`、`services/novel/runtime/*`、以及其他流式桥接代码。

## Asset Checklist

新增 prompt 时必须同时提供：

- `id`
- `version`
- `taskType`
- `mode`
- `language`
- `contextPolicy`
- `outputSchema` 或 text 模式的 `postValidate`
- `render()`

可选但推荐同时评估：

- `repairPolicy`：控制结构化 JSON/schema repair 次数
- `semanticRetryPolicy`：控制 `postValidate` 失败后的统一语义重试次数

## Naming

- 使用 `family.capability` 风格的 `id`
- `version` 使用 `v1`、`v2`
- 示例：
  - `audit.chapter.full@v2`
  - `world.structure.generate@v1`
  - `style.recommendation@v1`

## Runner Usage

- 结构化输出使用 `runStructuredPrompt`
- 纯文本输出使用 `runTextPrompt`
- 流式文本输出使用 `streamTextPrompt`
- 流式结构化输出使用 `streamStructuredPrompt`
- 调用方继续保留原 service 的 public method、数据库写入和返回 shape

### Responsibility Boundaries

- `core/promptRunner.ts` 只保留稳定公共门面和测试注入接线。
- `execution/` 负责上下文准备、同步文本调用与结构化调用编排。
- `streaming/` 负责建流、消费、超时/取消和流完成态。
- `validation/` 负责 postValidate、结构化结果修复与语义重试。
- `observability/` 负责运行日志、质量遥测与结果元数据。

同一次流式调用只能有一个 completion Promise 持有正文和 token usage 的最终结果。
取消、超时或断流时，该 Promise 同时失败；禁止再派生一个可能无人 await 的独立 usage Promise，
否则会在请求已经结束后产生未处理拒绝。
流消费不能假定 provider 会遵守传入的 `AbortSignal`：每次 `iterator.next()` 都必须同时等待
abort 与剩余 deadline，并在中断后调用 iterator cleanup。否则 completion 虽然已失败，生成器仍可能
卡在不响应 signal 的 provider iterator 上，直到外层超时才释放请求资源。

说明：

- `repairPolicy` 负责 JSON 解析 / schema 校验失败后的 repair
- `semanticRetryPolicy` 负责 JSON 已合法但 `postValidate` 未通过时的再生成

## Migration Default

- 如果一个 prompt 还没有资产化，不要在原 service 里继续加分支。
- 先创建资产，再把 service 切到 registry + runner。

## Governance Check

`server/tests/prompting-governance.test.js` 属于 server fast suite。它会扫描产品 service、agent、
route 与 graph 中的直接 `getLLM`、内联消息构造和结构化调用，并校验 Registry 元数据完整性。
迁移旧 Prompt 时必须新增可解析的 Registry 合约断言，不能通过扩大 allowlist 让违规路径继续存在。
