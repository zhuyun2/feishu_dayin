// 飞书云文档传输：前端 API 封装（全部走后端 /api/cloud/*，前端不接触任何密钥）。
// 后端实现见 server/feishuCloudApi.js。

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error || `请求失败（${res.status}）`;
  } catch (e) {
    return `请求失败（${res.status}）`;
  }
}

export interface CloudUser {
  name: string;
  avatarUrl?: string;
  openId?: string;
}

export interface CloudStatus {
  configured: boolean;   // 服务端是否已填入 appId / appSecret
  authorized: boolean;   // 是否已拿到可用的 user_access_token
  user?: CloudUser | null;
  expiresAt?: number;
  redirectUri?: string;
  scopes?: string[];
  hint?: string;         // 未配置时的引导文案
}

export interface CloudFolder {
  token: string;
  name: string;
}

export async function getCloudStatus(): Promise<CloudStatus> {
  const res = await fetch('/api/cloud/status');
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as CloudStatus;
}

// 取授权链接（由前端 window.open 打开，避免在飞书侧边栏 iframe 内跳转）
export async function startCloudOAuth(): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const res = await fetch('/api/cloud/oauth/start', { method: 'POST' });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { authorizeUrl: string; redirectUri: string };
}

export async function cloudLogout(): Promise<void> {
  const res = await fetch('/api/cloud/oauth/logout', { method: 'POST' });
  if (!res.ok) throw new Error(await parseError(res));
}

// 列出某文件夹下的子文件夹（folderToken 为空 = 根目录「我的空间」）
export async function listCloudFolders(folderToken?: string): Promise<CloudFolder[]> {
  const q = folderToken ? `?folder_token=${encodeURIComponent(folderToken)}` : '';
  const res = await fetch(`/api/cloud/folders${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = await res.json();
  return (body.folders || []) as CloudFolder[];
}

// 校验目标文件夹可写（把 1061004 权限问题提前暴露）
export async function verifyCloudFolder(folderToken: string): Promise<void> {
  const res = await fetch('/api/cloud/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderToken }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export interface CloudUploadResult {
  fileToken: string;
  name: string;
  url: string;
}

// 推送文件二进制到指定文件夹
export async function uploadToCloud(
  blob: Blob,
  fileName: string,
  folderToken: string
): Promise<CloudUploadResult> {
  const q = `file_name=${encodeURIComponent(fileName)}&folder_token=${encodeURIComponent(folderToken)}`;
  const res = await fetch(`/api/cloud/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as CloudUploadResult;
}
