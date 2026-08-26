import type { StampInfo } from '../types';
import { arrayBufferToBase64 } from './docxStamp';

// 与本地 dev server 的 /api/stamps 通信（印章图片管理）。
// 印章按表隔离：templates/<tableId>/_stamps/。同名上传直接覆盖。

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error || `请求失败（${res.status}）`;
  } catch (e) {
    return `请求失败（${res.status}）`;
  }
}

export async function listStamps(tableId: string): Promise<StampInfo[]> {
  const res = await fetch(`/api/stamps?tableId=${encodeURIComponent(tableId)}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = await res.json();
  return body.stamps as StampInfo[];
}

export interface StampUploadResult {
  ok: boolean;
  error?: string;
  info?: StampInfo;
  stripped?: boolean;
}

export async function uploadStamp(tableId: string, name: string, data: ArrayBuffer | Blob): Promise<StampUploadResult> {
  const q = `tableId=${encodeURIComponent(tableId)}&name=${encodeURIComponent(name)}`;
  const res = await fetch(`/api/stamps?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  });
  if (!res.ok) return { ok: false, error: await parseError(res) };
  const body = await res.json();
  return { ok: true, info: body as StampInfo, stripped: body?.stripped === true };
}

export async function deleteStamp(tableId: string, name: string): Promise<void> {
  const res = await fetch(
    `/api/stamps/${encodeURIComponent(name)}?tableId=${encodeURIComponent(tableId)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) throw new Error(await parseError(res));
}

// 印章图片 URL（<img src> 直接引用）
export function stampUrl(tableId: string, name: string): string {
  return `/api/stamps/${encodeURIComponent(name)}?tableId=${encodeURIComponent(tableId)}`;
}

// 取印章图片二进制（用于注入 docx）
export async function fetchStampBuffer(tableId: string, name: string): Promise<ArrayBuffer> {
  const res = await fetch(stampUrl(tableId, name));
  if (!res.ok) throw new Error(`无法读取印章图片（${res.status}）`);
  return res.arrayBuffer();
}

// 印章 base64 缓存：预览/打印叠加会在配置变化时反复用到，避免重复读取
const base64Cache = new Map<string, string>();

// 取印章图片 base64（供预览/打印的 JS 叠加层使用，自动缓存）
export async function fetchStampBase64(tableId: string, name: string): Promise<string> {
  const key = `${tableId}/${name}`;
  const hit = base64Cache.get(key);
  if (hit) return hit;
  const buf = await fetchStampBuffer(tableId, name);
  const b64 = arrayBufferToBase64(buf);
  base64Cache.set(key, b64);
  return b64;
}
