# pxed 部署历史与腾讯生产入口

pxed 已退出 ainovel 生产并关闭自启动。原 `Deploy pxed` 工作流已删除；`main`、`deploy/*` tag 和 Actions 手动重放均不得再用于启动 pxed。历史工作流与 cutover 参数仅通过 Git 历史查询，本页不提供可误执行的旧发布命令。

当前生产为腾讯 `tencent-vps` 的 `/opt/ai-novel` Docker Compose，公网 `https://ainovel.mangoqwq.com`。唯一生产工作流为 [deploy-tencent.yml](../../.github/workflows/deploy-tencent.yml)。发布顺序是 feature → beta 验证 → main；先备份并确认活动任务，再通过 GitHub 构建镜像和健康检查发布。

机上回滚由 `deploy/tencent/rollback-image-tag.sh` 执行，不能把旧 pxed 当作在线热备。若未来重新启用 pxed，必须另行确认数据、进程和部署配置，不能恢复旧自动触发器。

详细主机、备份、代理和线上版本以 Obsidian《ainovel 文档索引》链接的《pxed ai-novel 部署与运维》当前腾讯章节为准。
