import type {
  AttachmentFieldData, AttachmentBindOptions, AttachImagePart, AttachSizeConfig, RawAttachment,
} from '../types';
import { bytesToBase64, detectImage } from './imageBytes';

// ============================================================================
// 附件图片读取：token → 临时 URL → 服务端代理下载 → base64 + 像素尺寸
// ----------------------------------------------------------------------------
// 为什么不直接在前端 fetch 附件 URL：飞书附件域名与插件域名不同源，浏览器会被 CORS 拦。
// 因此统一走同源的 /api/proxy-image 由服务端拉取（服务端无跨域限制）。
// 临时 URL 有效期 10 分钟，这里按 token 做 8 分钟内存缓存，避免重复下载。
// ============================================================================

export const DEFAULT_ATTACH_WIDTH_CM = 5; // 未设置时的默认图片宽度

interface CachedImage {
  base64: string;
  ext: 'png' | 'jpg';
  w: number;
  h: number;
  at: number;
}

const CACHE_TTL_MS = 8 * 60 * 1000;
const cache = new Map<string, CachedImage>();

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
// 部分环境下 IOpenAttachment.type 只给扩展名或裸 mime，做个宽口径判定
const BARE_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
const GENERIC_BINARY_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

// 判定一条附件是否为图片。优先信任 type（mime），兜底看文件名扩展名。
export function isImageAttachment(a: RawAttachment): boolean {
  const t = String(a.type || '').trim().toLowerCase();
  const name = String(a.name || '');
  if (!t) return IMAGE_EXT_RE.test(name);
  if (/^image\//.test(t)) return true;
  if (BARE_IMAGE_TYPES.has(t)) return true;
  if (IMAGE_EXT_RE.test(t)) return true;
  // 服务端没给准确 mime 时，退回看文件名
  if (GENERIC_BINARY_TYPES.has(t)) return IMAGE_EXT_RE.test(name);
  return false;
}

// 说明：是否可插图只按「实际字节」判定（见 fetchImage 里的 detectImage），
// 不按文件名后缀过滤 —— 附件可能没有扩展名或后缀与实际格式不符。

// HTTP 响应 → 图片字节：校验状态、识别格式、转 base64
async function readImageBytes(res: Response): Promise<Omit<CachedImage, 'at'>> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const info = detectImage(bytes);
  if (!info) throw new Error('返回内容不是可识别的 PNG / JPEG');
  return { base64: bytesToBase64(bytes), ext: info.ext, w: info.w, h: info.h };
}

// 路径①：同源服务端代理。可绕开浏览器跨域，但要求服务端能访问该图片地址。
async function fetchViaServer(url: string): Promise<Omit<CachedImage, 'at'>> {
  const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
  if (res.ok) return readImageBytes(res);
  // 代理正常时返回结构化错误 { error, host?, upstreamStatus? }；
  // 解析不到 JSON 说明命中的不是我们的代理接口（多为 webpack-dev-server 的 404 HTML）
  let detail = '';
  try {
    const body = await res.json();
    if (body && body.error) {
      detail = body.host ? `${body.error}（源站 ${body.host}）` : String(body.error);
    }
  } catch (e) { /* 非 JSON 响应 */ }
  if (detail) throw new Error(detail);
  throw new Error(res.status === 404
    ? '服务端图片代理接口不存在（/api/proxy-image 未生效，需重启 dev server）'
    : `服务端图片代理返回 HTTP ${res.status}`);
}

// 路径②：浏览器直连。服务端访问不到、但客户端上下文可访问的地址走这条兜底。
async function fetchViaBrowser(url: string): Promise<Omit<CachedImage, 'at'>> {
  return readImageBytes(await fetch(url));
}

// 依次尝试「服务端代理 → 浏览器直连」，两条都失败时把各自原因合并抛出，便于定位
async function fetchImage(url: string): Promise<Omit<CachedImage, 'at'>> {
  const reasons: string[] = [];
  try {
    return await fetchViaServer(url);
  } catch (e: any) {
    reasons.push(e?.message || String(e));
  }
  try {
    return await fetchViaBrowser(url);
  } catch (e: any) {
    const m = e?.message || String(e);
    // 跨域被拦时浏览器只抛 TypeError: Failed to fetch / NetworkError
    reasons.push(/failed to fetch|networkerror|load failed|network request failed/i.test(m)
      ? '浏览器直连被跨域拦截'
      : `浏览器直连 ${m}`);
  }
  throw new Error(reasons.join('；'));
}

async function loadImage(token: string, url: string): Promise<Omit<CachedImage, 'at'>> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const img = await fetchImage(url);
  cache.set(token, { ...img, at: Date.now() });
  return img;
}

// buildAttachmentBind 的结果：bind 用于注入，warnings 用于在预览区提示失败原因
export interface AttachmentBindResult {
  bind?: AttachmentBindOptions;
  warnings: string[];
}

// 依据附件字段数据 + 尺寸配置，构建注入绑定。
// bind 为空表示没有可插入的图片（此时字段按原文件名规则输出）。
// 失败不再静默：每条降级原因都会进 warnings，避免「只看到文件名、不知为何」。
export async function buildAttachmentBind(
  table: any,
  recordId: string,
  attachments: Record<string, AttachmentFieldData> | undefined,
  sizeCfg?: Record<string, AttachSizeConfig>
): Promise<AttachmentBindResult> {
  if (!attachments) return { warnings: [] };
  const byField: AttachmentBindOptions['byField'] = {};
  const warnings: string[] = [];

  for (const fieldName of Object.keys(attachments)) {
    const data = attachments[fieldName];
    const imageItems = data.items.filter(isImageAttachment);
    if (imageItems.length === 0) continue; // 纯非图片附件 → 保持文件名文本

    // 取临时 URL 失败的 token（后续逐条给出可读原因，而不是整字段静默跳过）
    const urlByToken = new Map<string, string>();
    try {
      const urls = await table.getCellAttachmentUrls(imageItems.map((i) => i.token), data.fieldId, recordId);
      imageItems.forEach((it, i) => {
        const u = Array.isArray(urls) ? urls[i] : undefined;
        if (u) urlByToken.set(it.token, u);
      });
    } catch (e: any) {
      warnings.push(`附件字段「${fieldName}」无法获取图片地址：${e?.message || e}（已按文件名输出）`);
    }

    // 保持记录内附件原始顺序：图片 → 插图；非图片/下载失败 → 文件名文本
    const parts: AttachImagePart[] = [];
    for (const it of data.items) {
      if (!isImageAttachment(it)) {
        parts.push({ kind: 'text', text: it.name });
        continue;
      }
      const url = urlByToken.get(it.token);
      if (!url) {
        parts.push({ kind: 'text', text: it.name });
        continue;
      }
      try {
        const img = await loadImage(it.token, url);
        parts.push({ kind: 'image', base64: img.base64, ext: img.ext, w: img.w, h: img.h });
      } catch (e: any) {
        warnings.push(`附件图片「${it.name}」下载失败：${e?.message || e}（已按文件名输出）`);
        parts.push({ kind: 'text', text: it.name });
      }
    }

    if (!parts.some((p) => p.kind === 'image')) continue; // 一张都没成功 → 退回文本
    const w = sizeCfg?.[fieldName]?.widthCm;
    byField[fieldName] = {
      parts,
      widthCm: typeof w === 'number' && w > 0 ? w : DEFAULT_ATTACH_WIDTH_CM,
    };
  }

  return {
    bind: Object.keys(byField).length > 0 ? { byField } : undefined,
    warnings,
  };
}
