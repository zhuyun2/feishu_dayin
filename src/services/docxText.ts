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
