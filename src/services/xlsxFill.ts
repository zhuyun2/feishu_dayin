import PizZip from 'pizzip';
import type { PrintDataValue, LinkedRow } from '../types';
import { amountToChinese } from './money';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DETAIL_ROWS_PER_PAGE = 5;

// ============================================================================
// 轻量 xlsx 模板填充引擎
// ----------------------------------------------------------------------------
// docxtemplater 的 xlsx 模块是付费的，这里针对「货单」这类结构自研一个：
//   - 普通占位符  {字段名}         → 直接替换单元格文本
//   - 明细循环    {#字段}…{/字段}  → 该字段值为数组，把「含循环标记的整行」按数据条数复制
//   - 自动求和    {合计数量}/{合计金额} 等 → 见 SUM_MAP 约定或显式传入
//
// 实现策略：把所有共享字符串(sharedStrings)内联进 worksheet，再对 sheet XML 做
// 纯文本占位符替换 + 循环行克隆 + 行号/合并单元格重排。这样避免共享字符串索引维护。
// ============================================================================

const XLML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => XLML_ESC[c]);
}

// 从 "12"、"1,234.5"、"￥100"、"12个" 等文本提取数字
export function parseNumber(v: PrintDataValue): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const m = String(v).replace(/[^0-9.\-]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

function formatNumber(n: number): string {
  if (!isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString();
}

// 解析共享字符串表 → 字符串数组（<si> 可能含多个 <t> run，拼接）
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const runs = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    const text = runs.map((r) => r.replace(/<t[^>]*>([\s\S]*?)<\/t>/, '$1')).join('');
    out.push(unescapeXml(text));
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 把 worksheet 里所有 t="s"（共享字符串引用）单元格改为 t="inlineStr" 内联文本，
// 这样占位符 {字段} 就直接出现在 sheet XML 中，便于后续替换与循环克隆。
export function inlineSharedStrings(sheetXml: string, strings: string[]): string {
  return sheetXml.replace(
    /<c ([^>]*?)t="s"([^>]*?)>\s*<v>(\d+)<\/v>\s*<\/c>/g,
    (_all, pre, post, idx) => {
      const text = strings[parseInt(idx, 10)] ?? '';
      const attrs = (pre + post).replace(/\s+/g, ' ').trim();
      return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }
  );
}

// 提取模板中的全部占位符名（{字段}、{#字段}、{/字段}）
export function extractPlaceholders(strings: string[]): string[] {
  const set = new Set<string>();
  for (const s of strings) {
    const ms = s.match(/\{[#/]?[^{}]+\}/g) || [];
    for (const raw of ms) {
      const name = raw.replace(/[{}#/]/g, '').trim();
      if (name) set.add(name);
    }
  }
  return Array.from(set);
}

// 找到循环字段名：形如 {#字段} … {/字段}。返回第一个匹配的字段名。
export function findLoopField(sheetXml: string): string | null {
  const m = sheetXml.match(/\{#([^{}]+)\}/);
  return m ? m[1].trim() : null;
}

interface RowInfo { r: number; xml: string; start: number; end: number; }

// 按 <row r="N"> 拆出所有行
function splitRows(sheetData: string): RowInfo[] {
  const rows: RowInfo[] = [];
  const re = /<row r="(\d+)"[\s\S]*?<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheetData))) {
    rows.push({ r: parseInt(m[1], 10), xml: m[0], start: m.index, end: m.index + m[0].length });
  }
  return rows;
}

// 把一行 XML 的行号从 old 改为 nn（包括 <row r> 和内部 <c r="A5"> 引用）
function renumberRow(rowXml: string, oldR: number, newR: number): string {
  return rowXml
    .replace(new RegExp(`<row r="${oldR}"`), `<row r="${newR}"`)
    .replace(new RegExp(`(<c r="[A-Z]+)${oldR}"`, 'g'), `$1${newR}"`);
}

// 用一条数据行的值替换循环行 XML 里的占位符（去掉 {#..}{/..} 标记）
function fillLoopRow(rowXml: string, row: LinkedRow): string {
  let xml = rowXml.replace(/\{#[^{}]+\}/g, '').replace(/\{\/[^{}]+\}/g, '');
  xml = xml.replace(/\{([^{}]+)\}/g, (_all, name) => {
    const v = row[name.trim()];
    return escapeXml(v == null ? '' : String(v));
  });
  return xml;
}

// 替换普通（非循环）占位符
function fillScalars(xml: string, data: Record<string, PrintDataValue>): string {
  return xml.replace(/\{([^#/{}][^{}]*)\}/g, (all, name) => {
    const key = name.trim();
    if (Array.isArray(data[key])) return all; // 循环字段不在这里处理
    const v = data[key];
    return v == null || Array.isArray(v) ? '' : escapeXml(String(v));
  });
}

// 求和：默认对明细里的「数量」求和写入 {合计数量}，「金额」/「产品总价」写入 {合计金额}。
// 也可由调用方在 data 里预置这些字段来覆盖。
function computeAutoSums(rows: LinkedRow[]): Record<string, string> {
  const pick = (cands: string[]): number => {
    for (const c of cands) {
      if (rows.some((r) => r[c] != null && r[c] !== '')) {
        return rows.reduce((s, r) => s + parseNumber(r[c]), 0);
      }
    }
    return 0;
  };
  return {
    合计数量: formatNumber(pick(['数量'])),
    合计金额: formatNumber(pick(['金额', '产品总价', '总价'])),
  };
}

function pageCapacity(rows: RowInfo[], loopRow: number): number {
  const footer = rows.find((r) => r.r > loopRow && /\{(?:合计数量|合计金额)\}|合计/.test(r.xml));
  return Math.max(1, (footer ? footer.r : loopRow + 5) - loopRow);
}

function shiftRowXml(rowXml: string, offset: number): string {
  if (!offset) return rowXml;
  return rowXml.replace(/(<row r=")(\d+)/, (_a, p, r) => `${p}${parseInt(r, 10) + offset}`)
    .replace(/(<c r="[A-Z]+)(\d+)(")/g, (_a, p, r, s) => `${p}${parseInt(r, 10) + offset}${s}`);
}

function repeatPageMerges(
  sheetXml: string,
  loopRow: number,
  templateCapacity: number,
  targetCapacity: number,
  pageCount: number,
  pageHeight: number
): string {
  return sheetXml.replace(/<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/, (_all, attrs, inner) => {
    const base: Array<{ c1: string; r1: number; c2: string; r2: number }> = [];
    inner.replace(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/g,
      (_m: string, c1: string, r1: string, c2: string, r2: string) => { base.push({ c1, r1: +r1, c2, r2: +r2 }); return _m; });
    const refs = new Set<string>();
    const footerRow = loopRow + templateCapacity;
    const detailDelta = targetCapacity - templateCapacity;
    for (let p = 0; p < pageCount; p++) {
      const off = p * pageHeight;
      for (const m of base) {
        if (m.r1 === loopRow && m.r2 === loopRow) {
          for (let i = 0; i < targetCapacity; i++) refs.add(`${m.c1}${loopRow + off + i}:${m.c2}${loopRow + off + i}`);
        } else if (m.r1 >= loopRow && m.r2 < footerRow) {
          continue;
        } else {
          const r1 = m.r1 >= footerRow ? m.r1 + detailDelta : m.r1;
          const r2 = m.r2 >= footerRow ? m.r2 + detailDelta : m.r2;
          refs.add(`${m.c1}${r1 + off}:${m.c2}${r2 + off}`);
        }
      }
    }
    const list = Array.from(refs);
    const nextAttrs = /\bcount="\d+"/.test(attrs) ? attrs.replace(/\bcount="\d+"/, `count="${list.length}"`) : `${attrs} count="${list.length}"`;
    return `<mergeCells${nextAttrs}>${list.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;
  });
}

function setDimension(sheetXml: string, endCol: string, endRow: number): string {
  return sheetXml.replace(/<dimension\b[^>]*ref="[A-Z]+\d+:[A-Z]+\d+"[^>]*\/>/, `<dimension ref="A1:${endCol}${endRow}"/>`);
}

function setRowBreaks(sheetXml: string, breaks: number[]): string {
  const withoutBreaks = sheetXml.replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/, '');
  if (!breaks.length) return withoutBreaks;
  const xml = `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((r) => `<brk id="${r}" max="16383" man="1"/>`).join('')}</rowBreaks>`;
  return withoutBreaks.replace(
    /(<(?:customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>)/,
    `${xml}$1`
  );
}

// 用数据填充 xlsx 模板，返回填充后的 Blob（下载/预览三用）。
export function fillXlsx(
  templateBuffer: ArrayBuffer,
  data: Record<string, PrintDataValue>
): Blob {
  const zip = new PizZip(templateBuffer);
  const ssFile = zip.file('xl/sharedStrings.xml');
  const strings = ssFile ? parseSharedStrings(ssFile.asText()) : [];

  // 找第一个 worksheet
  const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!sheetName) throw new Error('xlsx 模板缺少工作表');
  let sheetXml = zip.file(sheetName)!.asText();

  // 1) 内联共享字符串，占位符进入 sheet
  sheetXml = inlineSharedStrings(sheetXml, strings);

  // 2) 处理明细循环
  const loopField = findLoopField(sheetXml);
  let loopRowNum = 0;
  if (loopField) {
    const rows: LinkedRow[] = Array.isArray(data[loopField]) ? (data[loopField] as LinkedRow[]) : [];
    const sdMatch = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
    if (sdMatch) {
      const sheetData = sdMatch[1];
      const allRows = splitRows(sheetData);
      const loopRow = allRows.find((r) => /\{#[^{}]+\}/.test(r.xml));
      if (loopRow) {
        loopRowNum = loopRow.r;
        const dataRows = rows.length > 0 ? rows : [];
        const n = dataRows.length;
        const templateCapacity = pageCapacity(allRows, loopRow.r);
        const detailDelta = DETAIL_ROWS_PER_PAGE - templateCapacity;
        const pageHeight = allRows[allRows.length - 1].r + detailDelta;
        const pageCount = Math.max(1, Math.ceil(n / DETAIL_ROWS_PER_PAGE));
        const before = allRows.filter((r) => r.r < loopRow.r);
        const after = allRows.filter((r) => r.r >= loopRow.r + templateCapacity);
        const pages: string[] = [];
        for (let p = 0; p < pageCount; p++) {
          const chunk = dataRows.slice(p * DETAIL_ROWS_PER_PAGE, (p + 1) * DETAIL_ROWS_PER_PAGE);
          const pageRows: string[] = [];
          for (let i = 0; i < DETAIL_ROWS_PER_PAGE; i++) {
            pageRows.push(renumberRow(fillLoopRow(loopRow.xml, chunk[i] || {}), loopRow.r, loopRow.r + i));
          }
          const pageAfter = after.map((r) => renumberRow(r.xml, r.r, r.r + detailDelta));
          const pageSums = computeAutoSums(chunk);
          const pageData: Record<string, PrintDataValue> = {
            ...data,
            ...pageSums,
            合计金额大写: amountToChinese(pageSums.合计金额),
            金额大写: amountToChinese(pageSums.合计金额),
          };
          const pageXml = [...before.map((r) => r.xml), ...pageRows, ...pageAfter]
            .map((xml) => shiftRowXml(xml, p * pageHeight)).join('');
          pages.push(fillScalars(pageXml, pageData));
        }
        sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${pages.join('')}</sheetData>`);
        sheetXml = repeatPageMerges(
          sheetXml, loopRowNum, templateCapacity, DETAIL_ROWS_PER_PAGE, pageCount, pageHeight
        );
        const dimension = sheetXml.match(/<dimension\b[^>]*ref="[A-Z]+\d+:([A-Z]+)\d+"/);
        sheetXml = setDimension(sheetXml, dimension?.[1] || 'J', pageHeight * pageCount);
        sheetXml = setRowBreaks(sheetXml, Array.from({ length: pageCount - 1 }, (_, i) => pageHeight * (i + 1)));

        const sums = computeAutoSums(dataRows);
        for (const [k, v] of Object.entries(sums)) {
          if (data[k] == null) data[k] = v;
        }
        // 合计金额大写（若模板用到 {合计金额大写}/{金额大写}）
        if (data['合计金额大写'] == null) data['合计金额大写'] = amountToChinese(data['合计金额']);
        if (data['金额大写'] == null) data['金额大写'] = amountToChinese(data['合计金额']);
      }
    }
  }

  // 3) 替换普通占位符
  sheetXml = fillScalars(sheetXml, data);

  zip.file(sheetName, sheetXml);
  return zip.generate({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' }) as Blob;
}

export function isXlsxName(name: string): boolean {
  return /\.xlsx$/i.test(name);
}
