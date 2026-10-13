import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { PrintDataValue, LinkedRow, MergeBindOptions, AttachmentBindOptions } from '../types';
import { extractParagraphs, setParagraphText, getBodyParts, PAGE_BREAK, trimTrailingEmptyParagraphsInZip } from './docxText';
import { rewriteMergeXml, createMergeRegistry, signatureFields, attachMergeTagsToRows } from './mergeField';
import { injectAttachmentImages, makeAttachSentinel } from './attachmentXml';
import { amountToChinese } from './money';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// docxtemplater 会一并渲染的正文/页眉页脚 part —— 合并字段在这几处都要改写
const MERGE_PART_RE = /^word\/(?:document|header\d+|footer\d+)\.xml$/i;

// ============ 分页规则（模板内指令） ============
// 指令格式与解析见 ./pageDirective（xlsx 引擎共用同一套解析）。
//   @@PAGE field=产品明细 size=5 sum=数量:合计数量,金额:合计金额 @@
import { parsePageDirective, type PageRule } from './pageDirective';

// 从一段纯文本解析分页指令；找不到返回 null
export { parsePageDirective };
export type { PageRule };

// 在 document.xml 中查找分页指令段落
function findPageRule(docXml: string): { rule: PageRule; block: string } | null {
  for (const p of extractParagraphs(docXml)) {
    const rule = parsePageDirective(p.text);
    if (rule) return { rule, block: p.xml };
  }
  return null;
}

// 从可能是 "12"、"1,234.5"、"￥100"、"12个" 的文本中提取数字
function parseNumber(v: PrintDataValue): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const m = String(v).replace(/[^0-9.\-]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// 对一组行（一个分页）按 sums 配置求和
function computeSums(rows: LinkedRow[], sums: { col: string; out: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sums) {
    let total = 0;
    for (const r of rows) total += parseNumber(r[s.col]);
    out[s.out] = formatNumber(total);
  }
  return out;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [[]];
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// 附件图片注入上下文：绑定 + 哨兵序号 → 字段名
interface AttachContext {
  bind: AttachmentBindOptions;
  indexToField: Record<number, string>;
}

// 用数据填充一个已加载的 zip（docxtemplater），返回渲染后的 zip
function renderToZip(zip: PizZip, data: Record<string, PrintDataValue>, attach?: AttachContext): PizZip {
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc.render(data);
  const rendered = doc.getZip();
  // 渲染后把附件哨兵替换为 inline 图片（正文 + 页眉页脚），再做末尾空段落清理
  if (attach) injectAttachmentImages(rendered, attach.bind, attach.indexToField);
  trimTrailingEmptyParagraphsInZip(rendered);
  return rendered;
}

// 把多页渲染结果合并为一个 docx：每页之间插入分页符，保留首页的 sectPr（含页眉页脚引用）。
// 注意：仅合并 document.xml 会丢掉第 2 页起的图片（媒体文件与关系都在各自 zip 里），
// 因此这里把每页的 word/media/*、图片关系、Content_Types 声明一并并入首页 zip。
function mergeDocsZip(zips: PizZip[]): PizZip {
  const base = zips[0];
  const RELS = 'word/_rels/document.xml.rels';
  const CT = '[Content_Types].xml';
  const RELS_SKELETON =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  let baseXml = base.file('word/document.xml')!.asText();
  for (let i = 1; i < zips.length; i++) {
    const pageXml = zips[i].file('word/document.xml')!.asText();
    const b = getBodyParts(baseXml);
    const p = getBodyParts(pageXml);
    const newInner = b.content + PAGE_BREAK + p.content + b.sectPr;
    baseXml = baseXml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${newInner}</w:body>`);

    // 媒体文件（文件名全局唯一，直接并入即可）
    Object.keys(zips[i].files).forEach((name) => {
      if (!/^word\/media\//i.test(name) || base.file(name)) return;
      const f = zips[i].file(name);
      if (f) base.file(name, f.asUint8Array());
    });

    // 图片关系：按 Id 去重后追加
    const srcRels = zips[i].file(RELS);
    if (srcRels) {
      const baseRels = base.file(RELS) ? base.file(RELS)!.asText() : RELS_SKELETON;
      let merged = baseRels;
      (srcRels.asText().match(/<Relationship\b[^>]*\/>/g) || []).forEach((r) => {
        const id = (r.match(/Id="([^"]+)"/) || [])[1];
        if (id && merged.indexOf(`Id="${id}"`) >= 0) return;
        merged = merged.replace('</Relationships>', r + '</Relationships>');
      });
      base.file(RELS, merged);
    }

    // 内容类型声明（png / jpeg 等）
    const srcCt = zips[i].file(CT);
    if (srcCt) {
      const baseCt = base.file(CT) ? base.file(CT)!.asText() : '';
      if (baseCt) {
        let merged = baseCt;
        (srcCt.asText().match(/<Default\b[^>]*\/>/g) || []).forEach((d) => {
          const ext = (d.match(/Extension="([^"]+)"/) || [])[1];
          if (ext && merged.indexOf(`Extension="${ext}"`) < 0) {
            merged = merged.replace('</Types>', d + '</Types>');
          }
        });
        base.file(CT, merged);
      }
    }
  }
  base.file('word/document.xml', baseXml);
  // 合并后的文档末尾也可能遗留空段落
  trimTrailingEmptyParagraphsInZip(base);
  return base;
}

function generateBlob(zip: PizZip): Blob {
  return zip.generate({
    type: 'blob',
    mimeType: MIME,
    compression: 'DEFLATE',
  }) as Blob;
}

// 用数据填充 .docx 模板，返回填充后的 Blob（预览/打印/下载三用）。
// 若模板内含 @@PAGE 分页指令，则按规则自动分页、求和、标注页码并合并为多页 docx。
// merge：合并字段（复合占位符 {{A}{B}}）支持。传入后先把这些片段换成规整标签，
// 并把算出的输出值并入填充数据；不传则完全保持旧行为。
// attachments：附件图片支持。传入后，含图片的附件字段占位符先填哨兵文本，
// 渲染完成后再替换为 inline 图片（非图片附件不设哨兵，仍输出文件名）。
export function fillTemplate(
  templateBuffer: ArrayBuffer,
  data: Record<string, PrintDataValue>,
  merge?: MergeBindOptions,
  attachments?: AttachmentBindOptions
): Blob {
  const zip0 = new PizZip(templateBuffer);
  const docPart = 'word/document.xml';
  let docXml0 = zip0.file(docPart)!.asText();

  // 合并字段：先重写正文与页眉页脚里的复合占位符，再把输出值补进数据。
  // docxtemplater 会一并渲染页眉页脚，那里若有 {{A}{B}} 同样会报重复开标签，
  // 因此这些 part 必须一起改写，且共用一套全局标签编号。
  let payload = data;
  if (merge) {
    const registry = createMergeRegistry();
    Object.keys(zip0.files)
      .filter((name) => MERGE_PART_RE.test(name))
      .forEach((name) => {
        const file = zip0.file(name);
        if (!file) return;
        const raw = file.asText();
        const rewritten = rewriteMergeXml(raw, registry);
        if (rewritten.xml !== raw) zip0.file(name, rewritten.xml);
      });

    if (registry.order.length > 0) {
      docXml0 = zip0.file(docPart)!.asText();
      const extra: Record<string, PrintDataValue> = {};
      for (const signature of registry.order) {
        const tag = registry.tags[signature];
        if (payload[tag] == null) extra[tag] = merge.resolve(signature, signatureFields(signature));
      }
      payload = { ...data, ...extra };
      // 循环内的合并字段：把标签取值下沉到每一行（顶层值保留为回退），
      // 否则 {__MERGEn} 只能取到主记录字段，嵌套循环里的子表字段一律算空。
      attachMergeTagsToRows(payload, registry, merge);
    }
  }

  // 附件图片：把「含图片的附件字段」的填充值换成哨兵文本，渲染后再替换为 inline 图片。
  // 只覆盖真正含图片的字段；纯非图片附件不动（保持 docxtemplater 输出文件名文本）。
  let attach: AttachContext | undefined;
  if (attachments && Object.keys(attachments.byField).length > 0) {
    payload = { ...payload };
    const indexToField: Record<number, string> = {};
    let n = 0;
    for (const field of Object.keys(attachments.byField)) {
      if (!attachments.byField[field].parts.some((p) => p.kind === 'image')) continue;
      n += 1;
      indexToField[n] = field;
      payload[field] = makeAttachSentinel(n);
    }
    if (n > 0) attach = { bind: attachments, indexToField };
  }

  const found = findPageRule(docXml0);

  // 无分页指令：直接渲染
  if (!found) {
    return generateBlob(renderToZip(zip0, payload, attach));
  }

  // 有分页指令：剔除指令段落（置空，保留结构避免 Word 修复提示），得到干净模板字节。
  // 复用 zip0 —— 它已写入重写后的 document.xml 与页眉页脚，不能再从原始字节重建。
  const cleanedXml = docXml0.replace(found.block, setParagraphText(found.block, ''));
  const cleanedZip = zip0;
  cleanedZip.file(docPart, cleanedXml);
  const cleanedBytes = cleanedZip.generate({ type: 'arraybuffer' }) as ArrayBuffer;

  const arr = payload[found.rule.field];
  const rows: LinkedRow[] = Array.isArray(arr) ? (arr as LinkedRow[]) : [];
  const pages = chunkArray(rows, found.rule.size);

  const zips = pages.map((chunk, i) => {
    const sums = computeSums(chunk, found.rule.sums);
    const paddedChunk = chunk.concat(
      Array.from({ length: Math.max(0, found.rule.size - chunk.length) }, () => ({} as LinkedRow))
    );
    const upper: Record<string, string> = {};
    for (const [k, v] of Object.entries(sums)) {
      if (/金额|总价|金额合计|合计金额/.test(k)) upper[`${k}大写`] = amountToChinese(v);
    }
    const pageData: Record<string, PrintDataValue> = {
      ...payload,
      [found.rule.field]: paddedChunk,
      页码: i + 1,
      总页数: pages.length,
      ...sums,
      ...upper,
    };
    return renderToZip(new PizZip(cleanedBytes), pageData, attach);
  });

  if (zips.length <= 1) return generateBlob(zips[0]);
  return generateBlob(mergeDocsZip(zips));
}

// 把 docxtemplater 的报错翻译为中文可读信息
export function explainDocxError(err: any): string[] {
  const msgs: string[] = [];
  if (err && err.properties && Array.isArray(err.properties.errors)) {
    for (const e of err.properties.errors) {
      const ctx = e?.properties?.context || e?.properties?.xtag || '';
      const id = e?.properties?.id || '';
      if (id === 'unopened_tag' || id === 'unclosed_tag') {
        msgs.push(`标签未正确闭合：${ctx}（请检查 {#字段}…{/字段} 是否成对）`);
      } else if (id === 'duplicate_open_tag' || id === 'duplicate_close_tag') {
        msgs.push(`标签重复：${ctx}`);
      } else if (id === 'unbalanced_loop_tags') {
        msgs.push(`循环标签不匹配：${ctx}`);
      } else {
        msgs.push(e?.message || `模板标签错误：${ctx}`);
      }
    }
  }
  if (msgs.length === 0) {
    msgs.push(err?.message || '模板填充失败，请检查模板标签是否正确');
  }
  return msgs;
}
