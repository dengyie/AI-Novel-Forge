# AI Novel Forge

**以小说为题的 AI 创作平台。**

从一句话灵感到可连载的长篇正文，再到有声书与衍生创作——把规划、写作、审核、修复和资产管理收成一条可暂停、可恢复的生产链。

![Monorepo](https://img.shields.io/badge/Monorepo-pnpm%20workspace-3C873A)
![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB)
![Backend](https://img.shields.io/badge/Backend-Express%20%2B%20Prisma-111827)
![AI](https://img.shields.io/badge/AI-LangChain%20%2B%20LangGraph-7C3AED)
![Database](https://img.shields.io/badge/Database-SQLite%20%2B%20Prisma-111827)

---

## 它解决什么问题

多数「AI 写作」工具停在对话补全：你写一句，它回一段。短文够用，长篇容易跑偏、断档、前后不一致。

**AI Novel Forge** 的目标是把「整本书写完」做成系统能力：

- 用自动导演把灵感落成方向、世界、角色、卷纲与章节任务
- 用同一条主链跑章节生成、审核、修复与状态回灌
- 把写法、拆书、知识库、音色与角色资产做成可复用的长期库存
- 在此之上扩展有声书、漫画、短剧等衍生工作台

适合想认真跑通一本长篇的创作者，也适合研究 Agent 工作流、长链路任务与创作类 AI Native 产品的开发者。

---

## 你能用它做什么

### 自动导演开书

一句话进入整本规划。支持多套方向与标题组、定向修订、四种运行模式（准备到可开写 / 全书自动 / 按范围 / 叠加去 AI 味闭环）。检查点可暂停、可恢复；模型故障或连续失败会主动停下，而不是死循环重试。

### Creative Hub

统一的创作中枢：对话、规划、工具调用、任务状态与回合总结。自然语言意图路由到导演阶段或章节任务；浏览器通知在到达检查点时提醒你回来接管。

### 章节生产主链

正文生成 → 审核 → 可修复问题处理 → 质量债务 → 角色/事实/伏笔回灌 → 下一章入口。上下文按本章参与者筛选角色账本，避免把全书角色一股脑塞进 prompt。

### 写法、拆书与知识库

写法引擎可保存、绑定、试写；反 AI 规则压制模板腔。拆书支持多档角色档案与形象演变。RAG（可选 Qdrant）把拆书结论与文档回灌到规划与续写。

### 有声书

小说 → 标注 → 多角色 TTS → 逐章/全书音频。工作台支持音色规划、全站音色库、试听与人耳 approve 门禁、逐章生成进度列表。

### 衍生工坊

漫画分镜与短剧改编围绕**已完成**的小说内容展开，不抢主链优先级。

### 桌面版与介绍站

- Windows 桌面安装包 / portable：见 [Releases](https://github.com/dengyie/AI-Novel-Forge/releases)
- 公开介绍站源码：`site/`（可部署到 GitHub Pages）

---

## 最新更新

### 2026-09-30

- 已取消的 AI 请求不会继续发送，也不会被迟到的成功结果误报为完成；流式响应中断时保留原始错误原因。

- 章节与世界生成遇到断连会提示重试；取消后重新生成时，旧响应和延迟完成的刷新不会混入新结果或打断新任务，新的生成仍可正常停止。
- 自动导演的进度和审批入口持续跟随任务最新状态，完成后会读取最终结果。

- 桌面版启动遇到无响应服务时会按时结束等待；退出、重启和安装更新前会等待本地服务关闭，减少残留后台进程。
- 重做有声书后，重新播放和下载会读取最新音频；超长全书可继续合并并生成 M4B，避免在约 25 小时音频处因文件长度限制失败。
- 取消有声书生成会及时停止待发送和正在读取的语音请求；语音服务繁忙时会暂停连续重试，减少重复等待与无效调用。
- 知识库外部服务迟迟未返回完整结果时会按超时收口，减少索引和检索长期停留在等待状态。
- 漫画资产和场景图片支持上传 10 MiB 以内的 PNG、JPEG、WebP；图片下载中断或文件读取失败时会释放资源，避免影响其他创作请求。
- 请求频率保护会依据可信连接来源计数，避免伪造来源绕过限流并挤占创作资源。
- 恢复归档资料并重建后，较早的清理重试不会删除可用索引，资料可持续参与写作检索。
- 修复章节期间保存新正文后，较早的修复候选不会覆盖修复记录或把新版正文误计为修复失败。
- 编辑章节后会保留新版正文的质量记录；较早的审校结果不会改写章节状态，也不会误停后续自动写作。
- 有声书播放、拖动进度和取消下载后会及时释放读取资源；音频读取异常只影响当前请求，避免中断其他创作任务。
- 知识资料在索引期间更新后会继续处理最新版本，保留当前资料的定制分块；旧任务不会把新版本误标为已完成，延迟到达或重试的旧任务也不会覆盖正在处理或已完成资料的定制分块。
- 知识库写入或清理暂时失败时可继续重试，写作检索只使用有效资料，避免引用过期内容。
- 全书自动写作会根据前文新增或修正的事实刷新后续章节任务，等待预取期间产生的新事实也会纳入；重复预取会复用已完成的刷新，减少重复规划和前后情节脱节。
- 编辑章节正文时，较早的生成、保存或人物时间线重建任务不会覆盖新版正文的人物时间线、摘要事件和一致性事实。
- 有声书 M4B 文件会按队列生成；长时间封装只在持续停止产出时中断，避免大书生成到一半被误停。
- 重做章节或重新生成有声书后，较早的封装任务不会覆盖新音频；服务重启和编码进程意外退出后可安全继续处理。
- 关闭服务时会收口正在启动的有声书后台处理，避免退出后又开始封装。

完整更新历史见 [版本更新说明](./docs/releases/release-notes.md)。

---

## 仓库结构

```text
AI-Novel-Forge/
├── client/     # Web 前端（React + Vite）
├── server/     # API / 导演 / 生产链 / 有声书（Express + Prisma）
├── shared/     # 共享类型与工具
├── desktop/    # Electron 桌面壳（产品名 AI Novel Forge）
├── site/       # 公开介绍站
├── docs/       # 架构、计划、公开文档与发布说明
└── scripts/    # 开发与发布辅助脚本
```

包名空间为 `@ai-novel/*`；用户可见品牌为 **AI Novel Forge**。

---

## 快速开始

### 环境

- Node.js `^20.19 || ^22.12 || >=24`
- pnpm `>=10.6`（仓库锁定 `pnpm@10.6.0`）

### 安装与本地开发

```bash
pnpm install
cp .env.example server/.env   # 按需填写模型与密钥
pnpm db:migrate
pnpm db:seed                  # 可选
pnpm dev                      # shared + server + client
```

常用命令：

| 命令 | 作用 |
|------|------|
| `pnpm dev` | 全栈开发 |
| `pnpm dev:desktop` | 桌面壳联调 |
| `pnpm build` | shared → server → client |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 服务端测试 |
| `pnpm build:site` | 构建介绍站 |

默认本地链路：API 与 Web 由 monorepo 脚本拉起；RAG / 向量库仅在你配置 Qdrant 后启用。

更细的安装、排障与第一本小说路径见 `docs/public/` 与 `docs/DEVELOPMENT.md`。

---

## 模型与数据

- 多提供商：OpenAI 兼容端点、DeepSeek、SiliconFlow、xAI 等（以设置页与 `.env` 为准）
- 规划 / 正文 / 审阅 / 拆书等可按任务拆路由
- 默认 **SQLite + Prisma** 即可跑通主链
- 可选 **Qdrant** 做知识检索
- 有声书依赖外部 TTS（如 MiMo chat-audio 等配置项）

请勿把生产密钥、数据库与用户内容提交进 Git。配置备份与部署属于运维侧流程，不在本 README 展开。

---

## 文档入口

| 路径 | 内容 |
|------|------|
| [docs/public/basic-introduction.md](./docs/public/basic-introduction.md) | 产品基础介绍 |
| [docs/public/usage-guide.md](./docs/public/usage-guide.md) | 使用路径 |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | 开发说明 |
| [docs/releases/release-notes.md](./docs/releases/release-notes.md) | 版本更新 |
| [docs/plans/](./docs/plans/) | 功能设计与里程碑计划 |

---

## 许可

默认 **AGPL-3.0-only**。以 SaaS / 托管服务等形式对外提供本项目或其修改版时，请阅读根目录 `LICENSE` 与 `NOTICE`，并取得相应商业授权。

---

## 维护

- 仓库：https://github.com/dengyie/AI-Novel-Forge  
- 维护者：dengyie  
- 问题与讨论：GitHub Issues  

欢迎围绕主链稳定性、创作质量与有声书体验提交 PR；大功能请先开 Issue 对齐范围。
