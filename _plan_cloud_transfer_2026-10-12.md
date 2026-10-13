# 需求评估：飞书云文档传输（打印文档保存到云盘目录）

日期：2026-10-12
状态：方案已评估，待用户确认 5 个决策点后开发
关联：`_plan_cloud_push_2026-09-18.md`（同需求的历史分析，结论一致，未实施）

---

## 一、需求

插件增加「飞书云文档传输」设置：可配置目标云盘目录；点击打印后，把生成的打印文档保存到该目录。

## 二、可行性结论

**可行。** 核心链路已明确，本机网络实测可达 `open.feishu.cn`（HTTP 200 / 0.27s）。

但有 **1 个硬性前提**：

> 必须新增一个飞书**自建应用**（app_id / app_secret）并开通云空间上传权限，且目标文件夹要授权给该应用。
> 现有插件代码里**没有任何 OpenAPI 接入**，这条路是从零新开的。

以及 **1 个必须先在开发前定的决策**：调用身份用「应用身份(tenant)」还是「用户身份(user)」（见 4.2）。

---

## 三、现状调研（实测，非推测）

| 项 | 结论 |
|---|---|
| 前端 SDK 能力 | `@lark-base-open/js-sdk` 仅提供 Base / Table / Record / Field / UI / bridge；bridge 只有 `getUserId`、`getTenantKey`、`getEnv` 等，**不提供云空间上传能力，也不暴露 access_token** |
| 前端能否直连 Drive API | **不能**。既拿不到令牌，也会撞 CORS |
| 现有服务端 | webpack devServer 的 express 实例；已挂 `templateApi` / `pdfApi` / `tunnelApi` / `setupApi`；已有 `/api/proxy-image`、`/api/print/pdf` 二进制接口先例 |
| 现有配置存储 | `templates/_config.json` → `{ tables, downloadNames, mergeFields, attachmentImages }`，按 tableId 组织 |
| 现有 OpenAPI 凭证 | **无**（grep `app_id` / `app_secret` / `open.feishu.cn` 结果全空） |
| 网络可达性 | `open.feishu.cn` 实测 HTTP 200，耗时 0.27s |
| 历史记录 | 项目内已有 `_plan_cloud_push_2026-09-18.md`（同需求分析，未实施） |

---

## 四、技术选型（关键）

### 4.1 用哪个接口

| 接口 | 能否满足「保存到云盘目录」 | 说明 |
|---|---|---|
| `POST /open-apis/drive/v1/files/upload_all` | ✅ **唯一正确选择** | `parent_type=explorer` + `parent_node=<文件夹token>`，文件会真实出现在云盘该目录中 |
| `POST /open-apis/drive/v1/medias/upload_all`（上传素材） | ❌ | 素材**不会出现在云盘目录**，只挂载在某个云文档内部。侧边栏开发指南提到的「云空间上传素材」即此接口，不适合本需求 |
| 多维表格授权码 `PersonalBaseToken` | ❌ 不推荐 | 授权码体系文档化仅支持 Base 接口 + Drive 的**上传素材 / 下载素材**两个接口，**不含 `files/upload_all`**，无法作为方案依赖 |
| `import_tasks`（导入为飞书原生文档） | ⚠️ 可选 | 能把 docx 转成飞书云文档放进目录，但属异步任务，且 docx→飞书文档保真度不保证，对「单据打印」意义不大 |

**结论**：用 `files/upload_all`，把填充好的 `.docx`（或 `.xlsx`）原件上传到目录。

### 4.2 调用身份（必须先在开发前定）

`files/upload_all` 支持两种令牌：

| | A. tenant_access_token（应用身份）**推荐** | B. user_access_token（用户身份） |
|---|---|---|
| 本质 | 后端用 app_id/app_secret 换租户令牌 | 用户 OAuth 授权一次，换用户令牌 |
| 前置配置 | 建应用 → 开 `drive:drive` → 发布 → 启用机器人 → 建群拉机器人 → **把目标文件夹共享给该群（可编辑）** | 建应用 → 开 `drive:drive` → 发布 → 登记回调地址 → 用户点「授权」 |
| 是否需把文件夹共享给应用 | **需要**（否则 403 / 1061004） | **不需要**（用的是用户自己的云盘权限） |
| 运行时稳定性 | 令牌 2h 自动续期，**零交互、最稳** | 需保存 refresh_token 并定期续期（长期不用会失效，需重新授权） |
| 文件所有者 | 应用 / 机器人 | 用户本人 |
| 实现复杂度 | 低 | 中（OAuth 回调 + 令牌刷新） |

**推荐 A（tenant_access_token）**：运行时最稳、实现最简单；代价是一次性的「文件夹共享给应用」配置。
若企业不允许把文件夹共享给应用、或希望文件归属到用户本人名下，则选 B。

### 4.3 文件夹 token 从哪来

云盘打开目标文件夹，地址栏形如：

```
https://xxx.feishu.cn/drive/folder/fldcnXXXXXXXXXXXX
```

**末段即 folder_token**。设置项让用户直接粘贴文件夹链接，服务端解析末段即可。
（可选做「浏览选择器」，需额外 readonly 权限与列目录接口，建议放二期。）

---

## 五、推荐方案设计

### 5.1 架构（复用现有常驻服务，不改部署架构）

```
插件「打印」/「保存到云盘」按钮
  → 已有 generate() 产出填充后的 Blob（docxFill / xlsxFill）
  → POST /api/cloud/upload   (body=二进制; headers: x-folder-token / x-file-name)
  → 本地常驻服务：取/缓存 tenant_access_token
  → POST https://open.feishu.cn/open-apis/drive/v1/files/upload_all
  → 返回 { file_token, url } → 前端提示「已保存到云盘」+ 可点击链接
```

**为什么走服务端**：① app_secret 绝不能进前端；② 避开 CORS；③ 令牌缓存与续期集中管理；
④ 服务已常驻并已暴露固定域名，**零新增部署成本**。

### 5.2 改动清单

**新增**
- `server/feishuCloudApi.js` — 令牌获取/缓存 + 上传 + 校验接口；挂到 `webpack.config.js` 的 `setupMiddlewares`
- `server/feishuConfig.example.json` — 凭证模板（app_id / app_secret / 可选默认 folder_token）
- `server/feishuConfig.json` — 真实凭证，**加入 .gitignore**（不入库、不随项目复制）
- `src/components/CloudTransferSetting.tsx` — 设置面板（粘贴链接 / 开关 / 测试连接 / 目录名回显）

**修改**
- `webpack.config.js` — 挂载新模块（1 行）
- `src/services/templateApi.ts` — 新增 `getCloudConfig / saveCloudConfig / verifyFolder / uploadToCloud`
- `src/components/PrintTab.tsx` — 加「☁️ 云文档传输」面板入口 + 打印后自动上传（开关控制）+ 独立「保存到云盘」按钮
- `templates/_config.json` — 新增 `cloudTransfer` 段（按 tableId 存 folder_token / folderName / enabled）——**只存文件夹，不存密钥**

### 5.3 服务端接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cloud/status` | 凭证是否已配置、令牌是否可用 |
| POST | `/api/cloud/upload` | 上传；body=二进制，headers 传 folder_token / file_name；返回 file_token + url |
| POST | `/api/cloud/verify` | 校验 folder_token 是否存在、应用是否有编辑权限（提前暴露 1061004） |

### 5.4 前端交互
- 打印页新增可折叠面板「☁️ 云文档传输」，与现有「🖼 附件图片」「🔗 合并字段」面板风格一致；
- 粘贴文件夹链接 → 自动解析 token → 点「测试连接」→ 回显目录名 / 校验结果 → 保存（按表）；
- 开关「打印后自动保存到云盘」；另设独立「保存到云盘」按钮（只归档不打印）；
- 文件名复用现有 `buildDownloadName()`（已支持按字段拼名 + 非法字符清洗），无需新造；
- **上传失败不影响打印**：打印走原有链路，上传结果独立提示（成功给可点击的云文档链接）。

### 5.5 用户必须配合的一次性前置（阻塞点）
1. 在飞书开放平台创建**企业自建应用**，拿到 app_id / app_secret；
2. 开通云空间权限：**「查看、评论、编辑和管理云空间中所有文件」(`drive:drive`)** 或 **「上传、下载文件到云空间」(`drive:file`）** —— 敏感权限，**通常需企业管理员审批**；
3. 发布应用版本；
4. 按 4.2 选定身份后补对应配置：
   - 选 A：启用机器人 → 建群拉机器人 → 把目标文件夹共享给该群、权限「可编辑」；
   - 选 B：在应用「安全设置」登记回调地址（本项目已有固定域名 `https://print.dimeifeishudayin.icu` 可直接作回调域），服务端实现 `/api/cloud/oauth/callback`。

---

## 六、风险与限制

| 风险 | 影响 | 应对 |
|---|---|---|
| 企业禁止自建应用 / `drive:drive` 审批不过 | **方案阻断** | 开发前先确认能否开通权限（最优先确认项） |
| 忘记把文件夹共享给应用 | 上传 403 / 1061004 | 提供「测试连接」，把报错翻译成中文指引 |
| 单文件 > 20MB | 上传失败 | 打印单据通常远小于 20MB；超限时提示（本项目无需分片上传） |
| 频控 5 QPS / 1 万次/天 | 理论上限 | 单机单据量远达不到 |
| 文件所有者为「应用/机器人」（选 A） | 云盘归属显示为应用 | 若在意则选 B（用户身份） |
| 密钥泄露 | 账号风险 | 密钥只落 `server/feishuConfig.json`（gitignore）；接口仅对内网/本机服务暴露 |

---

## 七、工作量（相对本项目复杂度）

| 模块 | 复杂度 |
|---|---|
| 服务端令牌 + 上传 + 校验接口 | 中 |
| 配置读写 + gitignore | 低 |
| 前端设置面板 + 打印后上传 + 状态提示 | 中 |
| 联调（含 1061004 权限排查） | 中 |

不改动现有打印 / 模板 / 印章任何逻辑，属**旁路增强**，风险可控。

---

## 八、待确认（开发前必须定）

1. **目标类型**：A 云盘文件夹（上传 .docx 原件，推荐）/ B 转成飞书原生文档
2. **调用身份**：A tenant_access_token（推荐）/ B user_access_token
3. **触发方式**：打印后自动保存（开关）/ 仅独立按钮 / 两者都要
4. **配置粒度**：每张数据表一个目录 / 全局一个目录
5. **能否开通自建应用的 drive 权限**（**这是能否立项的前提**）
