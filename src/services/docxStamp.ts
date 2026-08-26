import PizZip from 'pizzip';
import type { StampConfig, StampPosition } from '../types';

// ============ 电子印章注入（下载用） ============
// 把印章图片以「浮动于文字上方」的 anchor 形式写入渲染后的 docx：
//   - 图片字节写入 word/media/stamp<i>.png
//   - [Content_Types].xml 补齐 png/jpeg 声明
//   - word/_rels/document.xml.rels 补 image 关系
//   - word/document.xml 的 body 末尾（sectPr 前）插入带 wp:anchor 的段落
// 定位使用 posOffset（EMU，相对页面左上角，Word 原生语义），坐标与预览/打印的
// JS 叠加（stampOverlay）保持一致：印章中心落在 (base% + offset%, base% + offset%) 页面位置。
// 注意：docx-preview 渲染 anchor 时把 left/top 当作「相对流位置」的偏移（非页面），
// 因此预览/打印不走本注入，而由 stampOverlay 在渲染后叠加。

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EMU_PER_TWIP = 635; // 1 twip = 1/20 pt = 635 EMU

export interface StampImage {
  name: string;    // 印章文件名（仅用于命名 media 内的文件）
  base64: string;  // 图片 base64（不含 data: 前缀）
}

// 位置预设：印章中心点占页面宽/高的百分比，后续叠加 offsetX/offsetY 与多章错开
export const STAMP_POSITION_BASE: Record<StampPosition, { x: number; y: number }> = {
  'right-bottom': { x: 72, y: 72 },
  'left-bottom': { x: 10, y: 72 },
  'center': { x: 50, y: 45 },
  'right-top': { x: 72, y: 8 },
  'bottom-center': { x: 50, y: 72 },
};

// ===== 图片尺寸解析（PNG/JPEG，只读头部） =====

function parsePngSize(bin: Uint8Array): { w: number; h: number } | null {
  // PNG: 8 字节签名 + IHDR，宽高在 offset 16/20（大端）
  if (bin.length < 24) return null;
  const w = (bin[16] << 24) | (bin[17] << 16) | (bin[18] << 8) | bin[19];
  const h = (bin[20] << 24) | (bin[21] << 16) | (bin[22] << 8) | bin[23];
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

function parseJpegSize(bin: Uint8Array): { w: number; h: number } | null {
  // JPEG: 扫描 SOFn 段（C0-CF 除 C4/C8/CC），高宽在段内 offset 5/7（大端）
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

function detectImage(bin: Uint8Array): { w: number; h: number; ext: string } | null {
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

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ===== 页面尺寸 =====

function getPageSizeEmu(docXml: string): { w: number; h: number } {
  // 取最后一个 sectPr 的 pgSz w/h（twips），无则按 A4
  const mw = docXml.match(/<w:pgSz[^>]*w:w="(\d+)"/);
  const mh = docXml.match(/<w:pgSz[^>]*w:h="(\d+)"/);
  const wTwips = mw ? parseInt(mw[1], 10) : 11906;
  const hTwips = mh ? parseInt(mh[1], 10) : 16838;
  return { w: wTwips * EMU_PER_TWIP, h: hTwips * EMU_PER_TWIP };
}

// ===== Content_Types 补齐 =====

function ensureContentType(contentTypes: string, ext: string): string {
  const key = `Extension="${ext}"`;
  if (contentTypes.includes(key)) return contentTypes;
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  const decl = `<Default Extension="${ext}" ContentType="${type}"/>`;
  return contentTypes.replace('</Types>', decl + '</Types>');
}

// ===== 生成 anchor 段落 XML（posOffset 绝对定位，相对页面左上角） =====

function buildAnchorParagraph(opts: {
  id: number;
  rId: string;
  ext: string;
  cx: number;     // EMU
  cy: number;     // EMU
  left: number;   // EMU，图片左上角 x
  top: number;    // EMU，图片左上角 y
  opacity: number; // 0-1
}): string {
  const { id, rId, ext, cx, cy, left, top, opacity } = opts;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 100000);
  return [
    '<w:p>',
    '<w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>',
    '<w:r><w:drawing>',
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">',
    '<wp:simplePos x="0" y="0"/>',
    `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(left)}</wp:posOffset></wp:positionH>`,
    `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(top)}</wp:posOffset></wp:positionV>`,
    `<wp:extent cx="${cx}" cy="${cy}"/>`,
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
    '<wp:wrapNone/>',
    `<wp:docPr id="${id}" name="stamp${id}" descr=""/>`,
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="stamp${id}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    '<pic:blipFill>',
    `<a:blip r:embed="${rId}"><a:alphaModFix amt="${alpha}"/></a:blip>`,
    '<a:stretch><a:fillRect/></a:stretch>',
    '</pic:blipFill>',
    '<pic:spPr>',
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</pic:spPr>',
    '</pic:pic>',
    '</a:graphicData>',
    '</a:graphic>',
    '</wp:anchor>',
    '</w:drawing></w:r>',
    '</w:p>',
  ].join('');
}

// ===== 主入口：往渲染后的 zip 注入印章（下载用） =====

export function injectStampsIntoZip(
  zip: PizZip,
  stamps: StampImage[],
  config: StampConfig
): PizZip {
  if (!stamps.length) return zip;

  const docXml = zip.file('word/document.xml')!.asText();
  const contentTypes = zip.file('[Content_Types].xml')!.asText();
  const relsXml = zip.file('word/_rels/document.xml.rels')!.asText();

  let ct = contentTypes;
  let rels = relsXml;
  const drawings: string[] = [];

  const base = STAMP_POSITION_BASE[config.position] || STAMP_POSITION_BASE['right-bottom'];
  // 锚定模式：anchorText + 已保存的 anchor（预览时动态计算并持久化）优先于位置预设
  const anchor = config.anchorText?.trim() ? config.anchor : undefined;
  const page = getPageSizeEmu(docXml);
  const stampWEmu = Math.round((page.w * config.size) / 100);

  stamps.forEach((stamp, i) => {
    const bytes = base64ToBytes(stamp.base64);
    const info = detectImage(bytes);
    if (!info) throw new Error(`印章图片「${stamp.name}」格式无法识别`);
    const id = 100 + i; // docPr id 避开模板既有值
    const rId = `rIdStamp${i}`;
    const stampHEmu = Math.round((stampWEmu * info.h) / info.w);

    ct = ensureContentType(ct, info.ext);
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp${i}.${info.ext}"/></Relationships>`
    );
    zip.file(`word/media/stamp${i}.${info.ext}`, stamp.base64, { base64: true });

    // 印章中心点（% 页宽/高），与预览叠加（stampOverlay）一致：
    // 锚定模式下以锚点为基准（offsetX/Y 作为微调），多枚向下错开 i*9%
    const centerX = page.w * (((anchor ? anchor.x : base.x) + config.offsetX) / 100);
    const centerY = page.h * (((anchor ? anchor.y : base.y) + config.offsetY + i * 9) / 100);
    // anchor 定位点是图片左上角
    const left = Math.max(0, centerX - stampWEmu / 2);
    const top = Math.max(0, centerY - stampHEmu / 2);

    drawings.push(
      buildAnchorParagraph({
        id,
        rId,
        ext: info.ext,
        cx: stampWEmu,
        cy: stampHEmu,
        left,
        top,
        opacity: config.opacity,
      })
    );
  });

  zip.file('[Content_Types].xml', ct);
  zip.file('word/_rels/document.xml.rels', rels);

  // body 末尾（sectPr 之前）插入印章段落；若无 </w:body> 则不注入
  const insert = drawings.join('');
  if (docXml.includes('</w:body>')) {
    zip.file('word/document.xml', docXml.replace('</w:body>', insert + '</w:body>'));
  }

  return zip;
}

// ===== 便捷入口：Blob → 盖章后的 Blob（下载用） =====

export async function stampDocxBlob(
  blob: Blob,
  stamps: StampImage[],
  config: StampConfig
): Promise<Blob> {
  if (!stamps.length) return blob;
  const buf = await blob.arrayBuffer();
  const zip = new PizZip(buf);
  injectStampsIntoZip(zip, stamps, config);
  return zip.generate({
    type: 'blob',
    mimeType: MIME,
    compression: 'DEFLATE',
  }) as Blob;
}

// ArrayBuffer → base64（配合 fetchStampBuffer 使用）
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
