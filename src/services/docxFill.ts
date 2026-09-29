import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { PrintDataValue, LinkedRow, MergeBindOptions } from '../types';
import { extractParagraphs, setParagraphText, getBodyParts, PAGE_BREAK, trimTrailingEmptyParagraphsInZip } from './docxText';
import { rewriteMergeXml, createMergeRegistry, signatureFields } from './mergeField';
import { amountToChinese } from './money';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// docxtemplater 会一并渲染的正文/页眉页脚 part —— 合并字段在这几处都要改写
const MERGE_PART_RE = /^word\/(?:document|header\d+|footer\d+)\.xml$/i;

// ============ 分页规则（模板内指令） ============
// 模板正文里写一行（引擎渲染时自动剔除，不打印）：
//   @@PAGE field=产品明细 size=5 sum=数量:合计数量,金额:合计金额 @@
// field : 作为循环明细的字段名（其值为数组）
// size  : 每页（每张出货单）行数上限
// sum   : 需要求和的数字列，col:out 表示把 col 列求和后写入 out 变量
interface PageRule {
  field: string;
  size: number;
  sums: { col: string; out: string }[];
}

// 从一段纯文本解析分页指令；找不到返回 null
export function parsePageDirective(text: string): PageRule | null {
  const m = text.match(/@@PAGE\s+([\s\S]*?)\s*@@/);
  if (!m) return null;
  const body = m[1].trim();
  const rule: Record<string, string> = {};
  body.split(/\s+/).forEach((tok) => {
    const eq = tok.indexOf('=');
    if (eq > 0) rule[tok.slice(0, eq)] = tok.slice(eq + 1);
  });
  if (!rule.field) return null;
  const size = parseInt(rule.size, 10);
  const sums = (rule.sum ? rule.sum.split(',') : [])
    .map((s) => {
      const [col, out] = s.split(':');
      return col ? { col, out: out || `合计${col}` } : null;
    })
    .filter((x): x is { col: string; out: string } => !!x);
  return { field: rule.field, size: Number.isFinite(size) && size > 0 ? size : 5, sums };
}

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

// 用数据填充一个已加载的 zip（docxtemplater），返回渲染后的 zip
function renderToZip(zip: PizZip, data: Record<string, PrintDataValue>): PizZip {
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });
  doc.render(data);
  const rendered = doc.getZip();
  // 渲染后清理末尾空段落，避免不同软件排版遗留的空白页
  trimTrailingEmptyParagraphsInZip(rendered);
  return rendered;
}

// 把多页渲染结果合并为一个 docx：每页之间插入分页符，保留首页的 sectPr（含页眉页脚引用）
function mergeDocsZip(zips: PizZip[]): PizZip {
  let baseXml = zips[0].file('word/document.xml')!.asText();
  for (let i = 1; i < zips.length; i++) {
    const pageXml = zips[i].file('word/document.xml')!.asText();
    const b = getBodyParts(baseXml);
    const p = getBodyParts(pageXml);
    const newInner = b.content + PAGE_BREAK + p.content + b.sectPr;
    baseXml = baseXml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${newInner}</w:body>`);
  }
  zips[0].file('word/document.xml', baseXml);
  // 合并后的文档末尾也可能遗留空段落
  trimTrailingEmptyParagraphsInZip(zips[0]);
  return zips[0];
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
export function fillTemplate(
  templateBuffer: ArrayBuffer,
  data: Record<string, PrintDataValue>,
  merge?: MergeBindOptions
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
    }
  }

  const found = findPageRule(docXml0);

  // 无分页指令：直接渲染
  if (!found) {
    return generateBlob(renderToZip(zip0, payload));
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
    return renderToZip(new PizZip(cleanedBytes), pageData);
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
