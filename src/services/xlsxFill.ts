import PizZip from 'pizzip';
import type { PrintDataValue, LinkedRow, MergeBindOptions } from '../types';
import { rewriteMergeXml, signatureFields, attachMergeTagsToRows } from './mergeField';
import { amountToChinese } from './money';
import { parsePageDirective, DEFAULT_PAGE_SIZE } from './pageDirective';

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ============================================================================
// 轻量 xlsx 模板填充引擎
// ----------------------------------------------------------------------------
// docxtemplater 的 xlsx 模块是付费的，这里针对「货单 / 记录单」这类结构自研一个：
//   - 普通占位符  {字段名}         → 直接替换单元格文本
//   - 明细循环    {#字段}…{/字段}  → 该字段值为数组，把「含循环标记的整行」按数据条数复制
//   - 自动求和    {合计数量}/{合计金额} 等 → 见 computeAutoSums 约定
//   - 分页指令    @@PAGE field=… size=N @@ → 每页明细行数上限；指令单元格不打印
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

// 找出 @@PAGE 指令所在的单元格，解析出每页明细行数，并让指令行不参与打印。
//   - 专用指令行（整行只有这一个单元格）且位于末尾 → 整行删除，不留空行占用页高；
//   - 其他情况 → 只清空文本、保留行与样式（删行会让后续行号与合并区域整体错位）。
function extractPageDirective(sheetXml: string): { xml: string; rowsPerPage: number } {
  const cellRe = /<c\b[^>]*t="inlineStr"[^>]*>\s*<is>([\s\S]*?)<\/is>\s*<\/c>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(sheetXml))) {
    const runs = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    const text = unescapeXml(runs.map((r) => r.replace(/<t[^>]*>([\s\S]*?)<\/t>/, '$1')).join(''));
    const rule = parsePageDirective(text);
    if (!rule) continue;

    const rowStart = sheetXml.lastIndexOf('<row ', m.index);
    const rowClose = sheetXml.indexOf('</row>', m.index);
    const rowEnd = rowClose < 0 ? m.index + m[0].length : rowClose + '</row>'.length;
    const rowXml = rowStart >= 0 ? sheetXml.slice(rowStart, rowEnd) : '';
    const rowNum = (rowXml.match(/<row r="(\d+)"/) || [])[1];
    // 该行不能被合并单元格引用，否则删行会留下悬空引用。
    // 注意必须只在 <mergeCells> 段内匹配：否则会误命中 <dimension ref="A1:G25"/>。
    const mergeSection = sheetXml.match(/<mergeCells[\s\S]*?<\/mergeCells>/);
    const mergedRef = !rowNum || (!!mergeSection &&
      new RegExp(`ref="[A-Z]+${rowNum}:[A-Z]+\\d+"|ref="[A-Z]+\\d+:[A-Z]+${rowNum}"`).test(mergeSection[0]));
    const onlyCell = (rowXml.match(/<c\b/g) || []).length <= 1;
    const isLastRow = rowStart >= 0 && !/<row\b/.test(sheetXml.slice(rowEnd));

    if (rowStart >= 0 && onlyCell && isLastRow && !mergedRef) {
      return { xml: sheetXml.slice(0, rowStart) + sheetXml.slice(rowEnd), rowsPerPage: rule.size };
    }
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const cleared = `${openTag}<is><t xml:space="preserve"></t></is></c>`;
    return {
      xml: sheetXml.slice(0, m.index) + cleared + sheetXml.slice(m.index + m[0].length),
      rowsPerPage: rule.size,
    };
  }
  return { xml: sheetXml, rowsPerPage: DEFAULT_PAGE_SIZE };
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

// 明细区高度 = 模板中「循环行 → 合计行」占用的行数。
// 若模板里没有合计行，回退为 1 —— 只把循环行本身当作明细行。
// ⚠️ 旧实现回退为 5，会把它当成「明细区有 5 行」，于是循环行之后的 4 行真实模板内容
//    （如「小试工艺描述」「实验现象」「稳定性试验」等固定区块）被整行丢弃，打印时消失。
function pageCapacity(rows: RowInfo[], loopRow: number): number {
  const footer = rows.find((r) => r.r > loopRow && /\{(?:合计数量|合计金额)\}|合计/.test(r.xml));
  return Math.max(1, (footer ? footer.r : loopRow + 1) - loopRow);
}

function shiftRowXml(rowXml: string, offset: number): string {
  if (!offset) return rowXml;
  return rowXml.replace(/(<row r=")(\d+)/, (_a, p, r) => `${p}${parseInt(r, 10) + offset}`)
    .replace(/(<c r="[A-Z]+)(\d+)(")/g, (_a, p, r, s) => `${p}${parseInt(r, 10) + offset}${s}`);
}

// 按「每页实际输出多少明细行 + 该页在输出中的起始偏移」重排合并单元格。
// 各页行数可能不同（不再补空白行），因此每页单独用 offsets[i] 定位。
function repeatPageMerges(
  sheetXml: string,
  loopRow: number,
  templateCapacity: number,
  pages: { detailCount: number; offset: number }[]
): string {
  return sheetXml.replace(/<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/, (_all, attrs, inner) => {
    const base: Array<{ c1: string; r1: number; c2: string; r2: number }> = [];
    inner.replace(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/g,
      (_m: string, c1: string, r1: string, c2: string, r2: string) => { base.push({ c1, r1: +r1, c2, r2: +r2 }); return _m; });
    const refs = new Set<string>();
    const footerRow = loopRow + templateCapacity;
    for (const pg of pages) {
      const off = pg.offset;
      const detailDelta = pg.detailCount - templateCapacity;
      for (const m of base) {
        if (m.r1 === loopRow && m.r2 === loopRow) {
          // 循环行自身的合并区：按本页实际明细行数逐行复制
          for (let i = 0; i < pg.detailCount; i++) refs.add(`${m.c1}${loopRow + off + i}:${m.c2}${loopRow + off + i}`);
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
// merge：合并字段（复合占位符 {{A}{B}}）支持，需在共享字符串内联之后、占位符替换之前重写。
export function fillXlsx(
  templateBuffer: ArrayBuffer,
  data: Record<string, PrintDataValue>,
  merge?: MergeBindOptions
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

  // 1.5) 解析 @@PAGE 指令并清空指令单元格（指令不打印）；未写则用默认每页行数
  const dirInfo = extractPageDirective(sheetXml);
  sheetXml = dirInfo.xml;
  const rowsPerPage = dirInfo.rowsPerPage;

  // 2) 合并字段（复合占位符）：重写为规整标签并补进数据
  let payload = data;
  if (merge) {
    const rw = rewriteMergeXml(sheetXml);
    if (rw.order.length > 0) {
      sheetXml = rw.xml;
      const extra: Record<string, PrintDataValue> = {};
      for (const signature of rw.order) {
        const tag = rw.tags[signature];
        if (payload[tag] == null) extra[tag] = merge.resolve(signature, signatureFields(signature));
      }
      payload = { ...data, ...extra };
      // 明细行内的合并字段：标签取值同样下沉到每一行（xlsx 目前只支持一层循环）
      attachMergeTagsToRows(payload, { tags: rw.tags, order: rw.order }, merge);
    }
  }

  // 3) 处理明细循环
  const loopField = findLoopField(sheetXml);
  let loopRowNum = 0;
  if (loopField) {
    const rows: LinkedRow[] = Array.isArray(payload[loopField]) ? (payload[loopField] as LinkedRow[]) : [];
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
        const pageCount = Math.max(1, Math.ceil(n / rowsPerPage));
        const before = allRows.filter((r) => r.r < loopRow.r);
        const after = allRows.filter((r) => r.r >= loopRow.r + templateCapacity);
        const lastTplRow = allRows[allRows.length - 1].r;
        const pages: string[] = [];
        // 每页实际输出的明细行数 + 该页在输出中的起始偏移。
        // size 是「每页行数上限」而非固定行数：有多少条数据就输出多少行，不补空白行。
        // 各页行数可能不同，因此偏移量按页累计（而不是固定 pageHeight × 页号）。
        const pageInfos: { detailCount: number; offset: number }[] = [];
        const breakRows: number[] = [];
        let offset = 0;
        for (let p = 0; p < pageCount; p++) {
          const chunk = dataRows.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
          const detailCount = Math.max(1, chunk.length); // 至少保留 1 行，避免表格塌陷
          const detailDelta = detailCount - templateCapacity;
          const pageRows = chunk.map((row, i) =>
            renumberRow(fillLoopRow(loopRow.xml, row), loopRow.r, loopRow.r + i)
          );
          const pageAfter = after.map((r) => renumberRow(r.xml, r.r, r.r + detailDelta));
          const pageSums = computeAutoSums(chunk);
          const pageData: Record<string, PrintDataValue> = {
            ...payload,
            ...pageSums,
            合计金额大写: amountToChinese(pageSums.合计金额),
            金额大写: amountToChinese(pageSums.合计金额),
          };
          const pageXml = [...before.map((r) => r.xml), ...pageRows, ...pageAfter]
            .map((xml) => shiftRowXml(xml, offset)).join('');
          pages.push(fillScalars(pageXml, pageData));

          pageInfos.push({ detailCount, offset });
          offset += lastTplRow + detailDelta; // 本页占用的总行数
          if (p < pageCount - 1) breakRows.push(offset);
        }
        sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${pages.join('')}</sheetData>`);
        sheetXml = repeatPageMerges(sheetXml, loopRowNum, templateCapacity, pageInfos);
        const dimension = sheetXml.match(/<dimension\b[^>]*ref="[A-Z]+\d+:([A-Z]+)\d+"/);
        sheetXml = setDimension(sheetXml, dimension?.[1] || 'J', offset);
        sheetXml = setRowBreaks(sheetXml, breakRows);

        const sums = computeAutoSums(dataRows);
        const extra: Record<string, PrintDataValue> = {};
        for (const [k, v] of Object.entries(sums)) {
          if (payload[k] == null) extra[k] = v;
        }
        // 合计金额大写（若模板用到 {合计金额大写}/{金额大写}）
        const total = payload['合计金额'] == null ? sums['合计金额'] : payload['合计金额'];
        if (payload['合计金额大写'] == null) extra['合计金额大写'] = amountToChinese(total);
        if (payload['金额大写'] == null) extra['金额大写'] = amountToChinese(total);
        payload = { ...payload, ...extra };
      }
    }
  }

  // 4) 替换普通占位符
  sheetXml = fillScalars(sheetXml, payload);

  zip.file(sheetName, sheetXml);
  return zip.generate({ type: 'blob', mimeType: MIME, compression: 'DEFLATE' }) as Blob;
}

export function isXlsxName(name: string): boolean {
  return /\.xlsx$/i.test(name);
}
