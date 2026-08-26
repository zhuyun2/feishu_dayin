// 纯 JavaScript PNG 白底去除模块 — 零外部依赖（仅用 Node.js 内置 zlib）。
// 原理：将白底像素的 alpha 设为 0（透明），彩色笔画保持不透明。
// 公式：alpha = max(0, 255 - min(R, G, B))
//   纯白 (255,255,255) → alpha=0（透明）
//   纯红 (255,0,0)     → alpha=255（不透明）
//   浅色边缘           → 部分透明（过渡自然）
//
// 支持 colorType: 0(灰) 2(RGB) 3(索引) 4(灰+Alpha) 6(RGBA)
// 支持 bitDepth: 1/2/4/8（16-bit 不支持）
// 非隔行（Adam7 interlace 不支持，返回 null）。
// JPEG 不支持透明通道，返回 null。
'use strict';

const zlib = require('zlib');

// ============ CRC32（PNG 标准） ============
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============ Paeth 预测器 ============
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ============ PNG 签名 ============
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// ============ 计算 bitsPerPixel ============
function bitsPerPixel(colorType, bitDepth) {
  switch (colorType) {
    case 0: return bitDepth;           // 灰度
    case 2: return bitDepth * 3;      // RGB
    case 3: return bitDepth;           // 索引
    case 4: return bitDepth * 2;      // 灰+Alpha
    case 6: return bitDepth * 4;      // RGBA
    default: return 0;
  }
}

// ============ 解过滤扫描行 ============
// stride: 每行字节数（不含 filter byte）
// filterBpp: 过滤用 bpp = ceil(bitsPerPixel / 8)，最小 1
function unfilter(raw, stride, height, filterBpp) {
  const out = Buffer.alloc(height * stride);
  let src = 0;
  let prev = null;

  for (let y = 0; y < height; y++) {
    if (src + 1 + stride > raw.length) return null; // 数据不完整
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < stride; x++) {
      const v = line[x];
      const left = x >= filterBpp ? cur[x - filterBpp] : 0;
      const up = prev ? prev[x] : 0;
      const ul = prev && x >= filterBpp ? prev[x - filterBpp] : 0;

      switch (filter) {
        case 0: cur[x] = v; break;                                     // None
        case 1: cur[x] = (v + left) & 0xFF; break;                     // Sub
        case 2: cur[x] = (v + up) & 0xFF; break;                       // Up
        case 3: cur[x] = (v + ((left + up) >> 1)) & 0xFF; break;       // Average
        case 4: cur[x] = (v + paeth(left, up, ul)) & 0xFF; break;      // Paeth
        default: return null; // 未知过滤类型
      }
    }
    prev = cur;
  }
  return out;
}

// ============ 从子字节格式提取像素索引 ============
// bitDepth: 1, 2, 4, or 8
// pixels: 解过滤后的 Buffer
// stride: 每行字节数
// x, y: 像素坐标
// 返回: 像素值（索引或灰度值）
function getPixel(pixels, stride, x, y, bitDepth) {
  if (bitDepth === 8) {
    return pixels[y * stride + x];
  }
  const bitsPerByte = 8 / bitDepth;
  const byteIdx = y * stride + Math.floor(x / bitsPerByte);
  const pixelInByte = x % bitsPerByte;
  const bitShift = (bitsPerByte - 1 - pixelInByte) * bitDepth;
  const mask = (1 << bitDepth) - 1;
  return (pixels[byteIdx] >> bitShift) & mask;
}

// ============ 主函数：去除 PNG 白底 ============
// 返回处理后的 PNG Buffer，或 null（非 PNG / 不支持的格式 / 处理失败）
function stripWhiteBgPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.compare(PNG_SIG, 0, 8, 0, 8) !== 0) return null; // 不是 PNG

  // ---- 解析 chunk ----
  let width, height, bitDepth, colorType, interlace;
  const idatChunks = [];
  let plte = null, trns = null;

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len; // length(4) + type(4) + data + crc(4)

    switch (type) {
      case 'IHDR':
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
        break;
      case 'PLTE': plte = data; break;
      case 'tRNS': trns = data; break;
      case 'IDAT': idatChunks.push(Buffer.from(data)); break;
      case 'IEND': break;
    }
    if (type === 'IEND') break;
  }

  // 仅处理非隔行、非 16-bit
  if (interlace !== 0) return null;
  if (bitDepth === 16) return null;
  if (!width || !height || width > 8000 || height > 8000) return null; // 尺寸限制

  // 验证 colorType 与 bitDepth 组合
  const validCombos = {
    0: [1, 2, 4, 8],   // 灰度
    2: [8, 16],         // RGB
    3: [1, 2, 4, 8],   // 索引
    4: [8, 16],         // 灰+Alpha
    6: [8, 16],         // RGBA
  };
  const allowed = validCombos[colorType];
  if (!allowed || !allowed.includes(bitDepth)) return null;

  // ---- 计算步幅与过滤 bpp ----
  const bps = bitsPerPixel(colorType, bitDepth);
  const stride = Math.ceil((width * bps) / 8);
  const filterBpp = Math.max(1, Math.ceil(bps / 8)); // 过滤用 bpp，最小 1

  // ---- 解压 IDAT ----
  const compressed = Buffer.concat(idatChunks);
  let raw;
  try { raw = zlib.inflateSync(compressed); } catch { return null; }

  // ---- 解过滤 ----
  const pixels = unfilter(raw, stride, height, filterBpp);
  if (!pixels) return null;

  // ---- 转为 RGBA ----
  const rgba = Buffer.allocUnsafe(width * height * 4);
  let di = 0;
  const count = width * height;

  if (colorType === 6 && bitDepth === 8) {
    // RGBA 8-bit — 直接复制
    rgba.set(pixels);
  } else if (colorType === 2 && bitDepth === 8) {
    // RGB 8-bit → RGBA
    let si = 0;
    for (let i = 0; i < count; i++) {
      rgba[di++] = pixels[si++];
      rgba[di++] = pixels[si++];
      rgba[di++] = pixels[si++];
      rgba[di++] = 255;
    }
  } else if (colorType === 4 && bitDepth === 8) {
    // 灰+Alpha 8-bit → RGBA
    let si = 0;
    for (let i = 0; i < count; i++) {
      const g = pixels[si++];
      const a = pixels[si++];
      rgba[di++] = g; rgba[di++] = g; rgba[di++] = g; rgba[di++] = a;
    }
  } else if (colorType === 0 && bitDepth === 8) {
    // 灰度 8-bit → RGBA
    let si = 0;
    for (let i = 0; i < count; i++) {
      const g = pixels[si++];
      rgba[di++] = g; rgba[di++] = g; rgba[di++] = g; rgba[di++] = 255;
    }
  } else if (colorType === 3) {
    // 索引色（1/2/4/8-bit）→ RGBA
    if (!plte) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = getPixel(pixels, stride, x, y, bitDepth);
        const pi = idx * 3;
        rgba[di++] = plte[pi];
        rgba[di++] = plte[pi + 1];
        rgba[di++] = plte[pi + 2];
        rgba[di++] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  } else if (colorType === 0 && bitDepth < 8) {
    // 灰度 1/2/4-bit → RGBA
    // PNG 灰度子字节: 值范围 0..(2^bd - 1), 需映射到 0..255
    const maxVal = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = getPixel(pixels, stride, x, y, bitDepth);
        const g = Math.round((v / maxVal) * 255);
        rgba[di++] = g; rgba[di++] = g; rgba[di++] = g; rgba[di++] = 255;
      }
    }
  } else {
    return null; // 不支持的组合
  }

  // ---- 核心：alpha = max(0, 255 - min(R, G, B)) ----
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i + 3] = Math.max(0, 255 - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]));
  }

  // ---- 重编码：filter 0 (None) ----
  const stride4 = width * 4;
  const filtered = Buffer.allocUnsafe(height * (1 + stride4));
  let fi = 0;
  for (let y = 0; y < height; y++) {
    filtered[fi++] = 0; // filter: None
    rgba.copy(filtered, fi, y * stride4, (y + 1) * stride4);
    fi += stride4;
  }

  // ---- 压缩 ----
  const compressed2 = zlib.deflateSync(filtered, { level: 9 });

  // ---- 构建输出 PNG ----
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compression: deflate
  ihdr[11] = 0;  // filter: adaptive
  ihdr[12] = 0;  // interlace: none

  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed2),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 对外接口
// buf: 上传的图片 Buffer
// 返回: 处理后的 PNG Buffer，或 null（非 PNG / 不支持 / 失败）
function stripWhiteBg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  // PNG 魔数
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return stripWhiteBgPng(buf);
  }
  // JPEG 不支持透明通道，不处理
  return null;
}

module.exports = { stripWhiteBg, stripWhiteBgPng };
