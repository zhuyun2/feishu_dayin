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

// ===== 页段解析（下载注入按页定位） =====
// 把 <w:body> 内的文档流按「页边界」切成若干页段，供按页插入印章段落：
//   - 页边界标记：分页符（<w:br w:type="page"/>）、pageBreakBefore、段落级 sectPr
//     （<w:pPr><w:sectPr> 或段落内容级 <w:sectPr>，均表示该段落是某节最后一段）
//   - 边界段落本身归属前一页；第 k 页段 = 第 k-1 个边界段落结束 → 第 k 个边界段落结束
//   - 无任何边界标记的文档只有一个页段（即整个 body），与旧行为（body 末尾注入）一致
interface PageSegment {
  start: number; // 页段起始偏移（body 内）
  end: number;   // 页段结束偏移（不含）
}

function parsePageSegments(docXml: string, bodyStart: number, bodyEnd: number): PageSegment[] {
  // 页边界段落（分页符/段落级 sectPr/pageBreakBefore）本身归属前一页，
  // 因此记录「段落开始」与「段落结束」两个位置：
  //   - 首页段 = body 开始 → 首个边界段落开始（不含边界段落）
  //   - 中间页段 = 上一边界段落结束 → 本边界段落开始
  //   - 尾页段 = 最后边界段落结束 → body 结束
  const bounds: { start: number; end: number }[] = [];
  const pRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(docXml))) {
    if (m.index < bodyStart || m.index >= bodyEnd) continue;
    const seg = m[0];
    const isBoundary =
      /<w:br[^>]*w:type="page"/.test(seg) ||
      // 显式开启的 pageBreakBefore（无属性或 val=1/true/on；val=0/false/off 是关闭，不产生分页）
      /<w:pageBreakBefore(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(seg) ||
      /<w:sectPr[^>]*>/.test(seg); // 段落级 sectPr（pPr 内或段落内容级）
    if (isBoundary) bounds.push({ start: m.index, end: m.index + seg.length });
  }
  const segments: PageSegment[] = [];
  let cur = bodyStart;
  bounds.forEach((b, i) => {
    if (i === 0) {
      segments.push({ start: cur, end: b.start });
    } else {
      segments.push({ start: bounds[i - 1].end, end: b.start });
    }
    cur = b.end;
  });
  segments.push({ start: cur, end: bodyEnd });
  return segments;
}

// 页段内的安全插入点：取段内最后一个块级结束标签（段落或表格）之后。
// anchor 浮动对象的实际位置由 posOffset 决定，流位置只决定「属于哪一页」，
// 因此插在页段末尾既安全又符合"盖章在页面下部"的直觉。
// 段内没有块级元素（理论空页）时退回页段开头。
function insertionPoint(docXml: string, seg: PageSegment): number {
  const region = docXml.slice(seg.start, seg.end);
  const pEnd = region.lastIndexOf('</w:p>');
  const tEnd = region.lastIndexOf('</w:tbl>');
  if (pEnd < 0 && tEnd < 0) return seg.start;
  const at = pEnd >= tEnd ? pEnd + '</w:p>'.length : tEnd + '</w:tbl>'.length;
  return seg.start + at;
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
// 多页模板（含分页符/段落级 sectPr）：按页注入，每页由 config.pages[k].enabled 控制
// 是否盖章、锚点用 config.pages[k].anchor（锚定模式下预览动态计算并持久化）。
// 单页/无分页符模板：等价于旧行为（body 末尾注入）。

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

  const base = STAMP_POSITION_BASE[config.position] || STAMP_POSITION_BASE['right-bottom'];
  const page = getPageSizeEmu(docXml);
  const stampWEmu = Math.round((page.w * config.size) / 100);

  // 印章图片与关系：每枚只注册一次（media + rels + Content_Types），各页复用同一 rId
  stamps.forEach((stamp, i) => {
    const bytes = base64ToBytes(stamp.base64);
    const info = detectImage(bytes);
    if (!info) throw new Error(`印章图片「${stamp.name}」格式无法识别`);
    const rId = `rIdStamp${i}`;
    ct = ensureContentType(ct, info.ext);
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp${i}.${info.ext}"/></Relationships>`
    );
    zip.file(`word/media/stamp${i}.${info.ext}`, stamp.base64, { base64: true });
  });

  // 解析 body 与页段
  const bodyStart = docXml.indexOf('<w:body>');
  const bodyEnd = docXml.lastIndexOf('<w:sectPr'); // body 级 sectPr（页面属性）之前
  if (bodyStart < 0) return zip;
  const segEnd = bodyEnd >= bodyStart ? bodyEnd : docXml.indexOf('</w:body>');
  const segments = parsePageSegments(docXml, bodyStart + '<w:body>'.length, segEnd);

  // 逐页生成印章段落，记录插入位置（同页多枚拼接为一个插入块，保证顺序）
  const insertions: { pos: number; xml: string }[] = [];
  segments.forEach((seg, k) => {
    const pageCfg = config.pages?.[k];
    const enabled = pageCfg?.enabled !== false;
    if (!enabled) return;
    // 锚定模式：该页锚点优先用 pages[k].anchor（预览按页定位并持久化），退回全局 anchor
    const anchor = config.anchorText?.trim() ? pageCfg?.anchor || config.anchor : undefined;
    const pos = insertionPoint(docXml, seg);

    const drawings = stamps.map((stamp, i) => {
      const bytes = base64ToBytes(stamp.base64);
      const info = detectImage(bytes);
      if (!info) throw new Error(`印章图片「${stamp.name}」格式无法识别`);
      const id = 100 + k * 10 + i; // docPr id 按页+枚错开，避开模板既有值
      const rId = `rIdStamp${i}`;
      const stampHEmu = Math.round((stampWEmu * info.h) / info.w);

      // 印章中心点（% 页宽/高），与预览叠加（stampOverlay）一致：
      // 锚定模式下以锚点为基准（offsetX/Y 作为微调），多枚向下错开 i*9%
      const centerX = page.w * (((anchor ? anchor.x : base.x) + config.offsetX) / 100);
      const centerY = page.h * (((anchor ? anchor.y : base.y) + config.offsetY + i * 9) / 100);
      // anchor 定位点是图片左上角
      const left = Math.max(0, centerX - stampWEmu / 2);
      const top = Math.max(0, centerY - stampHEmu / 2);

      return buildAnchorParagraph({
        id,
        rId,
        ext: info.ext,
        cx: stampWEmu,
        cy: stampHEmu,
        left,
        top,
        opacity: config.opacity,
      });
    }).join('');

    insertions.push({ pos, xml: drawings });
  });

  // 从后往前插入，避免偏移错位；若无 </w:body> 则不注入
  if (!docXml.includes('</w:body>')) return zip;
  let out = docXml;
  insertions.sort((a, b) => b.pos - a.pos);
  for (const ins of insertions) {
    out = out.slice(0, ins.pos) + ins.xml + out.slice(ins.pos);
  }

  zip.file('[Content_Types].xml', ct);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('word/document.xml', out);

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
