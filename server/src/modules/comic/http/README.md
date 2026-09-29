# 漫画 HTTP 边界

路由门面 `comicRoutes.ts` 供 app 挂载，内部按用户能力分工：项目/分镜/批次生产留在门面，`characterImageRoutes.ts` 承担角色视觉身份和设计稿，`assetSceneRoutes.ts` 承担资产/场景管理与图片传输。业务编排与持久化仍由既有 comic services 所有，HTTP 模块只校验、映射请求和响应；外部不要导入子路由。

`imageRequestSchemas.ts` 维护三条图像生成入口共用的 HTTP 输入合同。原始图片上传在 `imageUploadBody.ts` 限定 PNG/JPEG/WebP、非空、最多 10 MiB（含 chunked），不允许压缩请求体；全局 JSON 限额不能保护二进制上传。

图片文件发送使用 Express sendFile 管理读取生命周期。客户端断开后不追加 JSON；响应已开始后读取失败只能关闭响应，未开始时才进入错误中间件。路径仍由对应资产服务解析，不接收客户端文件系统路径。
