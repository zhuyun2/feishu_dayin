import type { TemplateInfo, MatchConfig } from '../types';

// 与本地 dev server 的 /api 通信。所有文件名走 encodeURIComponent。

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error || `请求失败（${res.status}）`;
  } catch (e) {
    return `请求失败（${res.status}）`;
  }
}

export async function listTemplates(tableId: string): Promise<TemplateInfo[]> {
  const res = await fetch(`/api/templates?tableId=${encodeURIComponent(tableId)}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = await res.json();
  return body.templates as TemplateInfo[];
}

export interface UploadResult {
  ok: boolean;
  conflict?: boolean; // 409 同名
  error?: string;
  info?: TemplateInfo;
}

export async function uploadTemplate(
  tableId: string,
  name: string,
  data: ArrayBuffer | Blob,
  overwrite = false
): Promise<UploadResult> {
  const q = `tableId=${encodeURIComponent(tableId)}&name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`;
  const res = await fetch(`/api/templates?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  });
  if (res.status === 409) return { ok: false, conflict: true };
  if (!res.ok) return { ok: false, error: await parseError(res) };
  return { ok: true, info: (await res.json()) as TemplateInfo };
}

export async function deleteTemplate(tableId: string, name: string): Promise<void> {
  const res = await fetch(
    `/api/templates/${encodeURIComponent(name)}?tableId=${encodeURIComponent(tableId)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) throw new Error(await parseError(res));
}

export interface CopyResult {
  ok: boolean;
  conflict?: boolean;
  error?: string;
  info?: TemplateInfo;
}

export async function copyTemplate(tableId: string, source: string, target: string): Promise<CopyResult> {
  const res = await fetch('/api/templates/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableId, source, target }),
  });
  if (res.status === 409) return { ok: false, conflict: true };
  if (!res.ok) return { ok: false, error: await parseError(res) };
  return { ok: true, info: (await res.json()) as TemplateInfo };
}

// 取模板二进制内容（用于填充与下载），走静态路径 /templates/<tableId>/<name>
export async function fetchTemplateBuffer(tableId: string, name: string): Promise<ArrayBuffer> {
  const res = await fetch(`/templates/${encodeURIComponent(tableId)}/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`无法读取模板文件（${res.status}）`);
  return res.arrayBuffer();
}

// 模板下载 URL（管理页 <a download> 用）
export function templateDownloadUrl(tableId: string, name: string): string {
  return `/templates/${encodeURIComponent(tableId)}/${encodeURIComponent(name)}`;
}

export async function getConfig(): Promise<MatchConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as MatchConfig;
}

export async function putConfig(cfg: MatchConfig): Promise<MatchConfig> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as MatchConfig;
}
