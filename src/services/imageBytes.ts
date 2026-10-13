// 图片字节工具：仅读文件头识别 PNG / JPEG 并解析像素尺寸；base64 与 bytes 互转。
// 供「附件图片注入」与「电子印章注入」共用，避免两处各写一套解析。

export interface ImageInfo {
  w: number;
  h: number;
  ext: 'png' | 'jpg';
}

// PNG: 8 字节签名 + IHDR，宽高在 offset 16/20（大端）
function parsePngSize(bin: Uint8Array): { w: number; h: number } | null {
  if (bin.length < 24) return null;
  const w = (bin[16] << 24) | (bin[17] << 16) | (bin[18] << 8) | bin[19];
  const h = (bin[20] << 24) | (bin[21] << 16) | (bin[22] << 8) | bin[23];
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

// JPEG: 扫描 SOFn 段（C0-CF 除 C4/C8/CC），高宽在段内 offset 5/7（大端）
function parseJpegSize(bin: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < bin.length) {
    if (bin[i] !== 0xff) { i += 1; continue; }
    const marker = bin[i + 1];
    if (marker === 0xd8 || marker === 0x01) { i += 2; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const len = (bin[i + 2] << 8) | bin[i + 3];
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (bin[i + 5] << 8) | bin[i + 6];
      const w = (bin[i + 7] << 8) | bin[i + 8];
      if (w <= 0 || h <= 0) return null;
      return { w, h };
    }
    i += 2 + len;
  }
  return null;
}

// 识别 PNG / JPEG（按魔数），返回像素尺寸与扩展名；其他格式返回 null
export function detectImage(bin: Uint8Array): ImageInfo | null {
  if (bin.length >= 8 && bin[0] === 0x89 && bin[1] === 0x50 && bin[2] === 0x4e && bin[3] === 0x47) {
    const s = parsePngSize(bin);
    return s ? { ...s, ext: 'png' } : null;
  }
  if (bin.length >= 3 && bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff) {
    const s = parseJpegSize(bin);
    return s ? { ...s, ext: 'jpg' } : null;
  }
  return null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 二进制转 base64（分块，避免 String.fromCharCode 参数过多爆栈）
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
