# 图像生成厂商边界

## Background

角色形象图生成服务面向写作新手，配置入口必须尽量低负担：用户只应理解“哪个厂商负责文本模型、哪个模型负责图片生成”，不应被要求判断内置厂商白名单或手动修复前后端厂商枚举。

项目中的图像生成流程默认调用 OpenAI 兼容的 `/images/generations` 接口。部分内置厂商有推荐图像模型，但自定义网关、本地转发服务和聚合接口也可能提供同样的图像接口。

## Decision

图像模型设置不再绑定到固定内置厂商。任意已保存的模型厂商都可以配置一个独立的图像模型；只有已经启用、连接信息完整且拥有图像模型的厂商，才会出现在角色形象图生成的厂商列表中。

## Current Rule

- 文本默认模型和图像模型是两类独立设置。
- 图像模型保存到 `provider.imageModel.<provider>` 设置键下，不要求 provider 是内置厂商。
- 内置厂商可以提供推荐图像模型选项；自定义厂商默认不预设选项，但允许手动填写。
- 图片生成执行时读取任务上的 provider 和 model，再用该 provider 保存的 API 地址和 API Key 调用 `/images/generations`。
- 自定义或本地 OpenAI 兼容服务可以不填写 API Key；请求会省略 Authorization 头。
- 角色形象图的前端选择列表必须来自当前设置数据，不能写死为 `openai`、`siliconflow`、`grok` 之类的固定列表。

## Failure Modes

- 如果设置页允许填写图像模型，但角色图生成页仍写死厂商，用户会误以为自定义厂商保存失败。
- 如果后端只允许固定厂商进入图像生成，前端动态列表会把可选项交给用户，但任务提交后失败。
- 如果删除自定义厂商时保留旧图像模型设置，后续重建同名厂商可能继承过期图片模型，造成难以解释的配置污染。

## 图片 HTTP 资源生命周期

漫画资产/场景上传属于二进制请求，全局 JSON 解析器的限额不适用。必须在 HTTP 读取阶段限制为 10 MiB、非空 PNG/JPEG/WebP，且对无 Content-Length 的 chunked 上传同样计数，不能收完之后才检查大小。

漫画资产/场景及短剧图片直出使用 Express sendFile。文件存在性查询不能替代流错误处理：文件可能在查询后删除，客户端也可能在下载中断开。未开始响应时交错误中间件，已开始时关闭响应，客户端断开后不追加错误 JSON；读取源必须随响应结束释放。

模块 HTTP 子职责见 `server/src/modules/comic/http/README.md` 与 `server/src/modules/drama/http/README.md`；业务服务负责路径解析和持久化，路由门面及子路由只负责合同校验和传输。

## 漫画角色资产图片发布

适用范围：角色资产上传、AI 生成、分镜参考图读取与图片 HTTP 输出。资产的可读文件由 `imageData.fileName` 指向，PNG/JPEG/WebP 是文件格式，不能依靠扫描扩展名优先级判断哪张是当前图。

每次上传或生成写入独立 `asset-UUID.ext` 候选，完整写入后再用数据库事务提交图片状态和文件名。事务同时读取实际被替代的文件名，成功后只清理这个前驱和旧固定命名文件；禁止遍历删除全部候选，以免擦掉另一个请求尚未提交的新图。写入或提交失败仅清理本次候选，原图和原指针不动。提交后的清理失败记录告警，不撤销新图、不把成功返回改成失败。

无 `fileName` 的已有资产仍从固定 `asset.png/jpg/webp` 读取，原因是部署前持久文件没有发布指针；下一次成功发布会清理这些固定文件。已有指针找不到文件时必须报不存在，不准回退显示另一个旧扩展。生成中或生成失败状态保留数据库当前指针，不能用开始生成时的旧快照覆盖期间上传的新图。

## Related Modules

- `server/src/services/settings/ProviderImageSettingsService.ts`
- `server/src/services/image/provider.ts`
- `server/src/routes/settings.ts`
- `server/src/routes/settings/customProviderRoutes.ts`
- `client/src/pages/settings/components/ProviderConfigDialog.tsx`
- `client/src/pages/characters/components/CharacterImageDialog.tsx`
