import PizZip from 'pizzip';

// 模板正文（docx）文本提取与改写工具。
// 用正则解析 word/document.xml，不依赖浏览器 DOM，便于在 Node 下测试与在插件内运行。
// 段落（<w:p>）不嵌套，非贪婪匹配即可逐段取出；每个段落的纯文本由内部所有 <w:t> 拼接。

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export interface ParagraphInfo {
  index: number; // 在 document.xml 中的段落序号（与改写时使用的 index 一致）
  text: string; // 该段落拼接后的纯文本（含其中的 {占位符}）
  xml: string; // 该段落原始 <w:p>…</w:p> 片段
}

// 转义写入 XML 的文本
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 从 document.xml 字符串提取全部段落
export function extractParagraphs(docXml: string): ParagraphInfo[] {
  const out: ParagraphInfo[] = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(docXml)) !== null) {
    const xml = m[0];
    const text = xml.replace(/<[^>]+>/g, '');
    out.push({ index: index++, text, xml });
  }
  return out;
}

// 改写某个段落的纯文本：保留首个 <w:r> 的 <w:rPr>（字体/加粗等），
// 将该段落内所有 run 合并为一个 run，文本设为 newText。
export function setParagraphText(xml: string, newText: string): string {
  const rPrMatch = xml.match(/<w:r\b[^>]*>(<w:rPr[\s\S]*?<\/w:rPr>)/);
  const rPr = rPrMatch ? rPrMatch[1] : '';
  const escaped = escapeXml(newText);
  const runInner = rPr
    ? `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`
    : `<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r>`;
  // 去掉原有 run，再把新 run 插到 </w:p> 之前
  return xml
    .replace(/<w:r\b[\s\S]*?<\/w:r>/g, '')
    .replace(/<\/w:p>/, `${runInner}</w:p>`);
}

// 从 docx 二进制读取 document.xml
export function readDocumentXml(buffer: ArrayBuffer): string {
  const zip = new PizZip(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('docx 缺少 word/document.xml');
  return file.asText();
}

// 把 document.xml 写回 docx，返回新 Blob
export function writeDocumentXml(buffer: ArrayBuffer, docXml: string): Blob {
  const zip = new PizZip(buffer);
  zip.file('word/document.xml', docXml);
  const out = zip.generate({ type: 'arraybuffer' }) as ArrayBuffer;
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// 提取模板内全部段落文本（供编辑器展示）
export function listTemplateParagraphs(buffer: ArrayBuffer): ParagraphInfo[] {
  return extractParagraphs(readDocumentXml(buffer));
}

// 按 {index,text} 批量改写段落文本，返回新 docx Blob。
// 只改传入的段落（未传入的保持原样，避免破坏未编辑段落的多 run 格式）。
export function applyParagraphEdits(
  buffer: ArrayBuffer,
  edits: { index: number; text: string }[]
): Blob {
  const docXml = readDocumentXml(buffer);
  const paras = extractParagraphs(docXml);
  const editMap = new Map<number, string>();
  edits.forEach((e) => editMap.set(e.index, e.text));

  // 从后往前替换，避免前面的替换改变后面段落的偏移
  let result = docXml;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (!editMap.has(paras[i].index)) continue;
    const newText = editMap.get(paras[i].index)!;
    const newBlock = setParagraphText(paras[i].xml, newText);
    result = result.replace(paras[i].xml, newBlock);
  }
  return writeDocumentXml(buffer, result);
}

// 供分页模块复用的辅助：把 document.xml 拆分为 <w:body> 的内容与末尾 sectPr
export function getBodyParts(docXml: string): { content: string; sectPr: string } {
  const m = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const inner = m ? m[1] : docXml;
  const sectMatch = inner.match(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/);
  const sectPr = sectMatch ? sectMatch[0] : '';
  const content = sectPr ? inner.slice(0, inner.length - sectPr.length) : inner;
  return { content, sectPr };
}

// 分页符段落
export const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

export const WORDPROCESSING_NS = W;

// ============ 清理末尾空段落（解决不同软件排版导致的多余空页） ============

// 解析 twips 数值属性，缺省/非数字返回 0
function parseTwipsAttr(value: string | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 判断一个 <w:p> 段落是否可安全视为「空段落」：
// - 没有任何可见内容（文本、图片、形状、分页符、对象、域、制表符等）
// - 没有明显的段前/段后间距或行距（避免误删用户有意保留的大段空行）
// - 没有段落边框或底纹装饰
function isEmptyParagraph(paraXml: string): boolean {
  // 可见内容标记
  const hasVisible = /<w:t[\s>]|<w:drawing[\s>]|<w:pict[\s>]|<w:br[\s>]|<w:object[\s>]|<w:fldChar|<w:instrText|<w:tab[\s/>]/.test(paraXml);
  if (hasVisible) return false;

  // 段落属性：较大间距保留（用户可能用它做间距）
  const spacingMatch = paraXml.match(/<w:spacing\b[^>]*>/);
  if (spacingMatch) {
    const sp = spacingMatch[0];
    const after = parseTwipsAttr(sp.match(/w:after="(\d+)"/)?.[1]);
    const before = parseTwipsAttr(sp.match(/w:before="(\d+)"/)?.[1]);
    const line = parseTwipsAttr(sp.match(/w:line="(\d+)"/)?.[1]);
    // 空行默认 line=240 左右可删；超过 360 视为有意保留
    if (after > 400 || before > 400 || line > 360) return false;
  }

  // 边框、底纹保留
  if (/<w:pBdr>|<w:shd[\s>]/.test(paraXml)) return false;

  return true;
}

// 删除 word/document.xml 末尾连续空段落，避免跨软件编辑后遗留的空白页。
// 直接修改传入的 PizZip 实例。
export function trimTrailingEmptyParagraphsInZip(zip: PizZip): void {
  const file = zip.file('word/document.xml');
  if (!file) return;
  const docXml = file.asText();

  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return;

  const body = bodyMatch[1];
  const sectMatch = body.match(/(<w:sectPr[\s\S]*?<\/w:sectPr>)\s*$/);
  const sectPr = sectMatch ? sectMatch[1] : '';
  let content = sectPr ? body.slice(0, body.length - sectPr.length) : body;

  // 从后往前删除空段落（包括自闭合 <w:p/>）
  const emptyParaRe = /<w:p\b[^>]*?\/>\s*$|<w:p\b[^>]*>[\s\S]*?<\/w:p>\s*$/;
  let changed = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = content.match(emptyParaRe);
    if (!m) break;
    if (!isEmptyParagraph(m[0].trimEnd())) break;
    content = content.slice(0, content.length - m[0].length);
    changed = true;
  }

  if (!changed) return;
  const newDocXml = docXml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${content}${sectPr}</w:body>`);
  zip.file('word/document.xml', newDocXml);
}
