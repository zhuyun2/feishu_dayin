# 需求：把打印文档推送到指定飞书云文档文件夹

日期：2026-09-18
状态：可行性分析完成，待用户确认两点后实现

## 需求原文
增加一个按钮，直接把打印文档的数据推送到指定的飞书云文档的指定文件夹下面。

## 可行性结论
**可行，但有一个硬性前提**：必须新增飞书开放平台应用（app_id + app_secret）并开通云空间权限。
当前插件源码里**没有任何 OpenAPI 接入**（已 grep 确认，仅 Cloudflare 隧道 API）。

## 为什么现有插件做不到
- 现只用 `@lark-base-open/js-sdk`（多维表格开放组件 SDK），只在侧边栏生效，只能读表/记录、填模板、本地预览打印。
- 不提供云空间文件上传能力，也不暴露 OpenAPI 令牌。
- "推送到云文件夹"本质是调用 `open.feishu.cn/open-apis/drive/...`，属于应用级 OpenAPI，与表格组件 SDK 两套体系。

## 推荐方案：后端代理（复用现有同源 Express dev server）
```
插件"推送云文档"按钮 → generate() 拿填充 blob → POST /api/cloud/upload(blob+folder_token+文件名)
  → 后端 tenant_access_token → POST /open-apis/drive/v1/files/upload_all → 返回云文件 URL
```
优点：避免浏览器直连 CORS、避免暴露 app_secret、复用常驻服务/隧道，不改部署架构。

## 落地步骤（待确认后实施）
- 新增 server/feishuCloudApi.js：读 server/feishuConfig.json(app_id/secret, 不入库)；缓存 tenant_access_token；POST /api/cloud/upload 调 drive/v1/files/upload_all；返回 URL。
- webpack.config.js setupMiddlewares 挂载该模块。
- src/services/templateApi.ts 新增 pushToCloud()。
- src/components/PrintTab.tsx 底部操作栏加"推送云文档"按钮，复用 buildDownloadName 生成文件名。
- 目标文件夹配置：在下载命名弹窗加"云文档文件夹"输入，按表存 _config.json（或先 localStorage）。
- server/feishuConfig.example.json 凭证模板 + 说明。

## 用户必须配合的前提（阻塞点）
1. 注册/复用飞书应用（app_id/secret）。
2. 开通 drive:drive:import、drive.file 等云空间 scope（部分需管理员审批）。
3. 文件夹权限：tenant_access_token 上传需把应用添加为文件夹协作者。

## 待用户确认的两点
1. 目标类型：A. 云空间文件夹（上传 .docx 文件，最常见）；B. 已存在的在线文档 Doc（写内容，复杂很多）。→ 假设 A。
2. 应用身份：A. tenant_access_token（推荐，需文件夹共享给应用）；B. user_access_token（需侧边栏 OAuth）。→ 推荐 A。

## 已确认的项目现状（用于实现）
- 后端 API 挂载模式：webpack.config.js 的 setupMiddlewares 用 require('./server/xxx')(devServer.app)。
- 模板/配置落盘：templates/_config.json（tables + downloadNames 按 tableId）。
- 文件名生成：src/services/downloadName.ts buildDownloadName()。
- 填充产物：docxFill.fillTemplate / xlsxFill.fillXlsx 返回 Blob。
- 前端已有"打印/下载"按钮在 PrintTab 底部操作栏，可直接加第三按钮。
