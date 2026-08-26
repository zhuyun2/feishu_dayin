import PizZip from 'pizzip';

// ============================================================================
// xlsx → 保真 HTML 表格渲染
// ----------------------------------------------------------------------------
// 用 exceljs 读取第一个工作表的：单元格值、合并区间、列宽、行高、字体(加粗/大小/颜色)、
// 对齐、边框，转成一张带 inline style 的 <table>。目标是货单级别的保真（边框/合并/列宽）。
// 打印时该 HTML table 直接放进 iframe 打印，天然支持。
// ============================================================================

const PX_PER_CHAR = 8.5; // Excel 列宽单位≈字符数；按宋体/Calibri 11pt 较准
const PX_PER_POINT = 96 / 72; // 行高 point → px
const MIN_COL_PX = 60;   // 防止极窄列（空列宽）被挤成无法显示

function colWidthToPx(w: number | undefined): number {
  if (!w || w <= 0) return MIN_COL_PX;
  return Math.max(MIN_COL_PX, Math.round(w * PX_PER_CHAR + 8));
}

function rowHeightToPx(h: number | undefined): number {
  if (!h) return 20;
  return Math.round(h * PX_PER_POINT);
}

function argbToCss(argb?: string): string | null {
  if (!argb) return null;
  // exceljs 颜色是 AARRGGBB
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return `#${hex}`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s: string): string { return String(s).replace(/[&<>]/g, (c) => ESC[c]); }

interface MergeRange { top: number; left: number; bottom: number; right: number; }

function parseMerges(ws: any): MergeRange[] {
  const ranges: MergeRange[] = [];
  const model = ws.model?.merges || [];
  for (const ref of model) {
    // ref 形如 "A1:J1"
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    ranges.push({
      left: colLetterToNum(m[1]), top: parseInt(m[2], 10),
      right: colLetterToNum(m[3]), bottom: parseInt(m[4], 10),
    });
  }
  return ranges;
}

function colLetterToNum(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

// 找到某单元格属于哪个合并区间；返回该区间（若是左上角）或 null（若被其它单元格覆盖）
function mergeAt(merges: MergeRange[], row: number, col: number): { range: MergeRange; isAnchor: boolean } | null {
  for (const r of merges) {
    if (row >= r.top && row <= r.bottom && col >= r.left && col <= r.right) {
      return { range: r, isAnchor: row === r.top && col === r.left };
    }
  }
  return null;
}

function borderStyle(b: any): string {
  if (!b || !b.style) return '';
  const w = b.style === 'thin' || b.style === 'hair' ? '1px'
    : b.style === 'medium' ? '2px' : b.style === 'thick' ? '3px' : '1px';
  const color = argbToCss(b.color?.argb) || '#000';
  return `${w} solid ${color}`;
}

function cellText(cell: any): string {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((rt: any) => rt.text).join('');
    if (v.text) return v.text;
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

// 读取 blob → 渲染成 HTML table 字符串
export async function renderXlsxToHtml(blob: Blob): Promise<string> {
  const excelModule: any = await import('exceljs');
  const ExcelJS = excelModule.default || excelModule;
  const ab = await blob.arrayBuffer();
  const zip = new PizZip(ab);
  const sheetName = Object.keys(zip.files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const sheetXml = sheetName ? zip.file(sheetName)?.asText() || '' : '';
  const xmlBreaks = Array.from(sheetXml.matchAll(/<brk\b[^>]*\bid="(\d+)"[^>]*\/>/g), (m) => Number(m[1]));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ab);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel 无工作表');

  const merges = parseMerges(ws);
  const colCount = ws.columnCount || ws.actualColumnCount || 10;
  const rowCount = ws.rowCount || ws.actualRowCount || 14;

  // 列宽
  const colWidths: number[] = [];
  for (let c = 1; c <= colCount; c++) {
    const col = ws.getColumn(c);
    colWidths[c] = colWidthToPx(col?.width);
  }

  const totalW = colWidths.slice(1).reduce((a, b) => a + b, 0);

  const breakRows = new Set<number>(xmlBreaks);
  for (const br of (ws.model?.rowBreaks || [])) {
    const id = typeof br === 'number' ? br : br.id;
    if (Number.isFinite(id)) breakRows.add(Number(id));
  }
  const pageEnds = Array.from(breakRows).filter((r) => r > 0 && r < rowCount).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = 1;
  for (const end of pageEnds) { ranges.push([start, end]); start = end + 1; }
  ranges.push([start, rowCount]);

  let html = '';
  for (let page = 0; page < ranges.length; page++) {
    const [from, to] = ranges[page];
    html += `<table style="border-collapse:collapse;table-layout:fixed;width:${totalW}px;background:#fff;font-family:'宋体',SimSun,sans-serif;${page < ranges.length - 1 ? 'break-after:page;' : ''}">`;
    html += '<colgroup>';
    for (let c = 1; c <= colCount; c++) html += `<col style="width:${colWidths[c]}px"/>`;
    html += '</colgroup>';
    for (let r = from; r <= to; r++) {
    const rowObj = ws.getRow(r);
    const h = rowHeightToPx(rowObj?.height);
    html += `<tr style="height:${h}px">`;
    for (let c = 1; c <= colCount; c++) {
      const info = mergeAt(merges, r, c);
      if (info && !info.isAnchor) continue; // 被合并覆盖，跳过
      const cell = ws.getCell(r, c);
      const attrs: string[] = [];
      if (info && info.isAnchor) {
        const cs = info.range.right - info.range.left + 1;
        const rs = info.range.bottom - info.range.top + 1;
        if (cs > 1) attrs.push(`colspan="${cs}"`);
        if (rs > 1) attrs.push(`rowspan="${rs}"`);
      }
      const styles: string[] = ['padding:2px 4px', 'overflow:hidden'];
      // 边框
      const bd = cell.border || {};
      styles.push(`border-top:${borderStyle(bd.top) || '0'}`);
      styles.push(`border-bottom:${borderStyle(bd.bottom) || '0'}`);
      styles.push(`border-left:${borderStyle(bd.left) || '0'}`);
      styles.push(`border-right:${borderStyle(bd.right) || '0'}`);
      // 字体
      const font = cell.font || {};
      if (font.bold) styles.push('font-weight:bold');
      if (font.italic) styles.push('font-style:italic');
      if (font.size) styles.push(`font-size:${Math.round(font.size * 96 / 72)}px`);
      const fc = argbToCss(font.color?.argb);
      if (fc) styles.push(`color:${fc}`);
      // 背景
      const fill = cell.fill as any;
      const bg = fill?.type === 'pattern' ? argbToCss(fill.fgColor?.argb) : null;
      if (bg) styles.push(`background:${bg}`);
      // 对齐
      const al = cell.alignment || {};
      const ha = al.horizontal || (typeof cell.value === 'number' ? 'right' : 'left');
      styles.push(`text-align:${ha}`);
      styles.push(`vertical-align:${al.vertical || 'middle'}`);
      if (al.wrapText) {
        styles.push('white-space:pre-wrap;word-break:break-all');
      } else {
        styles.push('white-space:nowrap');
      }

      html += `<td ${attrs.join(' ')} style="${styles.join(';')}">${esc(cellText(cell))}</td>`;
    }
      html += '</tr>';
    }
    html += '</table>';
  }
  return html;
}
