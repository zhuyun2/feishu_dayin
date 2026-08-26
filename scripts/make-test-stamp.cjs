// 生成测试用红色圆章 PNG（300x300，透明背景），供冒烟测试使用。
// 依赖 Node 内置 zlib（含 crc32），无第三方库。
const zlib = require('zlib');
const fs = require('fs');

const W = 300;
const H = 300;

// RGBA 像素缓冲（透明背景 + 红色圆环 + 中间文字感）
const raw = Buffer.alloc(H * (1 + W * 4));
const cx = W / 2;
const cy = H / 2;
const R = 138;       // 外圆半径
const ring = 18;     // 圆环粗细

for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    let r = 0, g = 0, b = 0, a = 0;
    if (d <= R && d >= R - ring) { r = 220; g = 30; b = 30; a = 255; }
    else if (d <= R - ring - 2) { r = 0; g = 0; b = 0; a = 0; }
    const p = rowStart + 1 + x * 4;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
  }
}

// 构造 PNG chunk
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || 'test-stamp.png';
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
