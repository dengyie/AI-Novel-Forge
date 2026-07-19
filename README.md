# AI Novel Forge

**以小说为题的 AI 创作平台。**

从一句话灵感到可连载的长篇正文，再到有声书与衍生创作——把规划、写作、审核、修复和资产管理收成一条可暂停、可恢复的生产链。

![Monorepo](https://img.shields.io/badge/Monorepo-pnpm%20workspace-3C873A)
![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB)
![Backend](https://img.shields.io/badge/Backend-Express%20%2B%20Prisma-111827)
![AI](https://img.shields.io/badge/AI-LangChain%20%2B%20LangGraph-7C3AED)
![Database](https://img.shields.io/badge/Database-SQLite%20%2B%20Prisma-111827)

生产站点（示例）：[ainovel.mangoq.ccwu.cc](https://ainovel.mangoq.ccwu.cc)

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
