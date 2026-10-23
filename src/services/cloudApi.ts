// 飞书云文档传输：前端 API 封装（全部走后端 /api/cloud/*，前端不接触任何密钥）。
// 后端实现见 server/feishuCloudApi.js。

// 带 HTTP 状态码的错误：401 表示授权已失效，调用方据此自动切回「重新授权」界面
export class CloudApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
  }
}

async function toError(res: Response): Promise<CloudApiError> {
  let msg = `请求失败（${res.status}）`;
  try {
    const body = await res.json();
    if (body?.error) msg = body.error;
  } catch (e) { /* 非 JSON 响应，用默认文案 */ }
  return new CloudApiError(msg, res.status);
}

export interface CloudUser {
  name: string;
  avatarUrl?: string;
  openId?: string;
}

export interface CloudStatus {
  configured: boolean;   // 服务端是否已填入 appId / appSecret
  authorized: boolean;   // accessToken 或 refreshToken 是否仍可用
  authExpired?: boolean; // 有令牌但 access + refresh 都已过期 → 必须重新授权
  user?: CloudUser | null;
  expiresAt?: number;
  refreshExpiresAt?: number;
  webhookConfigured?: boolean;  // 真正会发通知（启用 + 地址非空）
  webhookEnabled?: boolean;     // 仅「启用」开关（可能尚未填地址）
  defaultBodyTemplate?: string; // 服务端默认请求体模板（单一事实来源）
  templateVars?: string[];      // 模板里可引用的变量名
  redirectUri?: string;
  scopes?: string[];
  hint?: string;         // 未配置时的引导文案
}

export interface CloudFolder {
  token: string;
  name: string;
  /** true = 由「指向文件夹的快捷方式」展开而来（常用于把共享文件夹挂到我的空间） */
  viaShortcut?: boolean;
}

// 多维表格自动化通知的结果（skipped = 未配置 webhookUrl）
export interface CloudWebhookResult {
  ok?: boolean;
  skipped?: boolean;
  code?: number;
  error?: string;
}

export async function getCloudStatus(baseId?: string): Promise<CloudStatus> {
  const q = baseId ? `?base_id=${encodeURIComponent(baseId)}` : '';
  const res = await fetch(`/api/cloud/status${q}`);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as CloudStatus;
}

// 取授权链接（由前端 window.open 打开，避免在飞书侧边栏 iframe 内跳转）
export async function startCloudOAuth(): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const res = await fetch('/api/cloud/oauth/start', { method: 'POST' });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { authorizeUrl: string; redirectUri: string };
}

export async function cloudLogout(): Promise<void> {
  const res = await fetch('/api/cloud/oauth/logout', { method: 'POST' });
  if (!res.ok) throw await toError(res);
}

// 列出某文件夹下的子文件夹（folderToken 为空 = 根目录「我的空间」）
export async function listCloudFolders(folderToken?: string): Promise<CloudFolder[]> {
  const q = folderToken ? `?folder_token=${encodeURIComponent(folderToken)}` : '';
  const res = await fetch(`/api/cloud/folders${q}`);
  if (!res.ok) throw await toError(res);
  const body = await res.json();
  return (body.folders || []) as CloudFolder[];
}

// 解析「共享文件夹链接 / 纯 token」→ folderToken + 名称。
// 共享文件夹不在「我的空间」清单里（没有公开接口可枚举），只能粘贴链接进入。
export async function resolveCloudFolder(ref: string): Promise<{ folderToken: string; name: string }> {
  const res = await fetch(`/api/cloud/folder-meta?ref=${encodeURIComponent(ref)}`);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { folderToken: string; name: string };
}

// 校验目标文件夹可写（把 1061004 权限问题提前暴露）
export async function verifyCloudFolder(folderToken: string): Promise<void> {
  const res = await fetch('/api/cloud/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderToken }),
  });
  if (!res.ok) throw await toError(res);
}

export interface CloudUploadResult {
  fileToken: string;
  name: string;
  url: string;
  pusher?: string;
  webhook?: CloudWebhookResult;
}

// 推送文件二进制到指定文件夹。
// cfgKey = 多维表格 baseId，服务端据此读取该多维表格独立的 Webhook 配置；
// folderName 仅用于自动化通知文案。
export async function uploadToCloud(
  blob: Blob,
  fileName: string,
  folderToken: string,
  folderName?: string,
  cfgKey?: string
): Promise<CloudUploadResult> {
  const q =
    `file_name=${encodeURIComponent(fileName)}` +
    `&folder_token=${encodeURIComponent(folderToken)}` +
    `&folder_name=${encodeURIComponent(folderName || '')}` +
    `&cfg_key=${encodeURIComponent(cfgKey || '')}`;
  const res = await fetch(`/api/cloud/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as CloudUploadResult;
}

// 试发一条自动化通知。可传尚未保存的 webhookUrl / bodyTemplate，方便边改边测。
export async function testAutomationWebhook(input: {
  baseId?: string;
  webhookUrl?: string;
  bodyTemplate?: string;
}): Promise<CloudWebhookResult> {
  const res = await fetch('/api/cloud/webhook/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as CloudWebhookResult;
}
