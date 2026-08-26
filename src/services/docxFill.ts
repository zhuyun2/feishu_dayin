import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { PrintDataValue, LinkedRow } from '../types';
import { extractParagraphs, setParagraphText, getBodyParts, PAGE_BREAK } from './docxText';
import { amountToChinese } from './money';

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
  return doc.getZip();
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
export function fillTemplate(
  templateBuffer: ArrayBuffer,
  data: Record<string, PrintDataValue>
): Blob {
  const zip0 = new PizZip(templateBuffer);
  const docXml0 = zip0.file('word/document.xml')!.asText();
  const found = findPageRule(docXml0);

  // 无分页指令：直接渲染
  if (!found) {
    return generateBlob(renderToZip(zip0, data));
  }

  // 有分页指令：剔除指令段落（置空，保留结构避免 Word 修复提示），得到干净模板字节
  const cleanedXml = docXml0.replace(found.block, setParagraphText(found.block, ''));
  const cleanedZip = new PizZip(templateBuffer);
  cleanedZip.file('word/document.xml', cleanedXml);
  const cleanedBytes = cleanedZip.generate({ type: 'arraybuffer' }) as ArrayBuffer;

  const arr = data[found.rule.field];
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
      ...data,
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
