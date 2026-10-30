# 模型调用用量

domain 只归一化供应商返回的统计，不依赖数据库或业务执行（移植自上游 2026-10-05 llm-cache-observability 设计的 domain 部分）。

- 缓存读取属于输入，缓存创建属于未命中输入，均不可在合计之外再次相加。
- 明确返回 0 与未提供不同；未知为 null，无效计数只使缓存不可用，不丢弃合法基础总量。
- 原生 Anthropic 的 input 不含 read/creation，SDK 标准 input 已包含，必须在协议适配后归一化。
- 同次调用流片段合并累计量，不求和；不同物理调用才求和。汇总有未提供或无效数据时不伪造完整缓存统计。
- 厂商计数不根据字符数估计。

厂商字段映射（命中 / 未命中）：

| 协议形态 | 命中 | 未命中 |
|---|---|---|
| DeepSeek 原始 usage | `prompt_cache_hit_tokens` | `prompt_cache_miss_tokens`，或总输入减命中 |
| OpenAI 兼容及 SDK | `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` / `input_token_details.cache_read` | 总输入减命中 |
| Anthropic 原生 | `cache_read_input_tokens` | `input_tokens + cache_creation_input_tokens` |
| Gemini 原生 | `usageMetadata.cachedContentTokenCount` | `promptTokenCount - cachedContentTokenCount` |

业务总量入口仍是 `llm/usageTracking`（旧门面保留兼容导出）；本模块不写 DB。
