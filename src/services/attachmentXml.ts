import PizZip from 'pizzip';
import type { AttachmentBindOptions } from '../types';

// ============================================================================
// 附件图片注入（docx）
// ----------------------------------------------------------------------------
// 为什么需要「哨兵」：
//   docxtemplater 是纯文本模板引擎，图片模块是付费的，无法在 {字段} 处直接插图。
//   做法是分三步：
//     ① 渲染前：把「含图片的附件字段」的填充值换成一个不可见哨兵文本
//        （\uE000ATT1\uE000，私有区字符，docxtemplater 原样输出）
//     ② docxtemplater 正常渲染（哨兵随文本落到 <w:t> 里）
//     ③ 渲染后：本模块把哨兵所在的 run 拆成「图片 run + 文本 run」
//   非图片附件不设哨兵，仍由 docxtemplater 输出文件名文本 —— 保持原有规则。
//
// 覆盖范围与 docxFill 一致：word/document.xml + header*/footer*.xml。
// ============================================================================

const ATTACH_PART_RE = /^word\/(?:document|header\d+|footer\d+)\.xml$/i;
const RUN_RE = /<w:r(?:\s[^>]*)?\/>|<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const WT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const SENTINEL_CHAR = '\uE000';
const SENTINEL_TOKEN_RE = /\uE000ATT(\d+)\uE000/g;

const EMU_PER_CM = 360000; // 1cm = 360000 EMU

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

const RELS_SKELETON =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  `<Relationships xmlns="${RELS_NS}"></Relationships>`;

// 渲染前写进填充数据的哨兵（index 从 1 开始，与 indexToField 对应）
export function makeAttachSentinel(index: number): string {
  return `${SENTINEL_CHAR}ATT${index}${SENTINEL_CHAR}`;
}

function partSlug(part: string): string {
  return part.replace(/^word\//, '').replace(/\.xml$/i, '').replace(/[^A-Za-z0-9]/g, '');
}

function relsPathFor(part: string): string {
  return part.replace(/^word\//, 'word/_rels/') + '.rels';
}

function ensureContentType(ct: string, ext: string): string {
  const key = `Extension="${ext}"`;
  if (ct.includes(key)) return ct;
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  return ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
}

// 取该 run 全部 <w:t> 文本的拼接（保持原转义，避免来回转义出错）
function runTextEscaped(runXml: string): string {
  let out = '';
  WT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WT_RE.exec(runXml))) out += m[1];
  return out;
}

// 取 run 的字符格式（字体/加粗等），用于插图时保留文本样式
function extractRunProps(runXml: string): string {
  const m = runXml.match(/<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/);
  return m ? m[0] : '';
}

function buildTextRunEscaped(escaped: string, rPr: string): string {
  return `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
}

// inline（随文）图片 run：图片作为字符流的一部分，位置即占位符位置
function buildInlineRun(id: number, rId: string, ext: string, cx: number, cy: number): string {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="attach${id}" descr=""/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A_NS}">` +
    `<a:graphicData uri="${PIC_NS}">` +
    `<pic:pic xmlns:pic="${PIC_NS}">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="attach${id}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// 把一段填充后的 docx zip 里的哨兵替换为图片/文本 run。直接修改传入的 zip。
export function injectAttachmentImages(
  zip: PizZip,
  bind: AttachmentBindOptions,
  indexToField: Record<number, string>
): void {
  const parts = Object.keys(zip.files).filter((n) => ATTACH_PART_RE.test(n));
  if (parts.length === 0) return;

  let contentTypes = zip.file('[Content_Types].xml') ? zip.file('[Content_Types].xml')!.asText() : '';

  for (const part of parts) {
    const file = zip.file(part);
    if (!file) continue;
    let xml = file.asText();
    if (xml.indexOf(SENTINEL_CHAR + 'ATT') < 0) continue;

    const slug = partSlug(part);
    const relsPath = relsPathFor(part);
    if (!zip.file(relsPath)) zip.file(relsPath, RELS_SKELETON);
    let rels = zip.file(relsPath)!.asText();
    const rIdByKey = new Map<string, string>();

    // 找出所有含哨兵的 run（从后往前替换，避免下标偏移）
    const runs: { start: number; end: number; xml: string }[] = [];
    RUN_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RUN_RE.exec(xml))) {
      if (rm[0].indexOf(SENTINEL_CHAR + 'ATT') >= 0) {
        runs.push({ start: rm.index, end: rm.index + rm[0].length, xml: rm[0] });
      }
    }

    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      const rPr = extractRunProps(run.xml);
      const text = runTextEscaped(run.xml);
      const out: string[] = [];
      let last = 0;
      SENTINEL_TOKEN_RE.lastIndex = 0;
      let tm: RegExpExecArray | null;
      while ((tm = SENTINEL_TOKEN_RE.exec(text))) {
        const before = text.slice(last, tm.index);
        if (before) out.push(buildTextRunEscaped(before, rPr));
        const field = indexToField[parseInt(tm[1], 10)];
        const cfg = field ? bind.byField[field] : undefined;
        if (cfg) {
          cfg.parts.forEach((p, pi) => {
            if (p.kind === 'text') {
              if (p.text) out.push(buildTextRunEscaped(escapeText(p.text), rPr));
              return;
            }
            // 同一字段的同一张图在多处出现时复用同一个 rId / media
            const key = `${part}\u0000${field}\u0000${pi}`;
            let rId = rIdByKey.get(key);
            if (!rId) {
              mediaSeq += 1;
              rId = `rIdAttach${slug}${mediaSeq}`;
              const mediaName = `attach_${slug}_${mediaSeq}.${p.ext}`;
              zip.file(`word/media/${mediaName}`, p.base64, { base64: true });
              rels = rels.replace(
                '</Relationships>',
                `<Relationship Id="${rId}" Type="${REL_TYPE_IMAGE}" Target="media/${mediaName}"/></Relationships>`
              );
              if (contentTypes) contentTypes = ensureContentType(contentTypes, p.ext);
              rIdByKey.set(key, rId);
            }
            const wEmu = Math.round(cfg.widthCm * EMU_PER_CM);
            const hEmu = Math.max(1, Math.round(wEmu * (p.h / p.w)));
            docPrSeq += 1;
            out.push(buildInlineRun(docPrSeq, rId, p.ext, wEmu, hEmu));
          });
        }
        last = tm.index + tm[0].length;
      }
      const tail = text.slice(last);
      if (tail) out.push(buildTextRunEscaped(tail, rPr));

      xml = xml.slice(0, run.start) + out.join('') + xml.slice(run.end);
    }

    // 兜底：清理任何未被识别的残留哨兵（如被 docxtemplater 拆散），避免打印出乱码
    xml = xml.replace(/\uE000ATT\d+\uE000/g, '');

    zip.file(part, xml);
    zip.file(relsPath, rels);
  }

  if (contentTypes) zip.file('[Content_Types].xml', contentTypes);
}

// 供 buildInlineRun 复用的文本转义
function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// docPr id 与 media 序号：模块级递增，保证同一文档内不重复（避开模板既有 id）
let mediaSeq = 0;
let docPrSeq = 5000;
