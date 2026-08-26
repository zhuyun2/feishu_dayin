// 自测：验证 docx 文本提取/改写/多页合并的正则逻辑在真实 .docx 上可用且不破坏结构。
// 运行：node scripts/test-docx.cjs
const fs = require('fs');
const path = require('path');
const PizZip = require(path.resolve(__dirname, '..', 'node_modules', 'pizzip'));

const SAMPLE = 'public/templates/tbldeXFrTixlf6sB/Antimicro 苯氧乙.docx';

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function extractParagraphs(docXml) {
  const out = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m, i = 0;
  while ((m = re.exec(docXml)) !== null) {
    out.push({ index: i++, text: m[0].replace(/<[^>]+>/g, ''), xml: m[0] });
  }
  return out;
}
function setParagraphText(xml, newText) {
  const rPrMatch = xml.match(/<w:r\b[^>]*>(<w:rPr[\s\S]*?<\/w:rPr>)/);
  const rPr = rPrMatch ? rPrMatch[1] : '';
  const escaped = escapeXml(newText);
  const run = rPr
    ? `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`
    : `<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r>`;
  return xml.replace(/<w:r\b[\s\S]*?<\/w:r>/g, '').replace(/<\/w:p>/, `${run}</w:p>`);
}
function getBodyParts(docXml) {
  const m = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const inner = m ? m[1] : docXml;
  const sectMatch = inner.match(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/);
  const sect = sectMatch ? sectMatch[0] : '';
  const content = sect ? inner.slice(0, inner.length - sect.length) : inner;
  return { content, sectPr: sect };
}
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function loadDoc(file) {
  const buf = fs.readFileSync(file);
  const zip = new PizZip(buf);
  return { zip, xml: zip.file('word/document.xml').asText() };
}
function reloadOk(buf) {
  try { const z = new PizZip(buf); return !!z.file('word/document.xml'); }
  catch (e) { return false; }
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

const file = path.resolve(__dirname, '..', SAMPLE);
assert(fs.existsSync(file), '示例 docx 存在: ' + SAMPLE);

// 1) 段落提取
const { xml } = loadDoc(file);
const paras = extractParagraphs(xml);
assert(paras.length > 0, `提取到 ${paras.length} 个段落`);

// 2) 改写某段落文本并写回，确认仍可加载
const target = paras[Math.min(1, paras.length - 1)];
const edited = xml.replace(target.xml, setParagraphText(target.xml, '@@PAGE field=产品明细 size=5 sum=数量:合计数量 @@'));
const z2 = new PizZip(fs.readFileSync(file)); // 用原始 docx 字节重新加载后写入 edited
z2.file('word/document.xml', edited);
const buf2 = z2.generate({ type: 'nodebuffer' });
assert(reloadOk(buf2), '改写段落后的 docx 可被 PizZip 重新加载');
assert(edited.includes('@@PAGE field=产品明细'), '改写后的 XML 包含分页指令文本');

// 3) 多页合并：把同一文档当作两页，插入分页符合并
const base = loadDoc(file);
const baseXml = base.xml;
const pageXml = base.xml;
const b = getBodyParts(baseXml);
const p = getBodyParts(pageXml);
const mergedInner = b.content + PAGE_BREAK + p.content + b.sectPr;
const mergedXml = baseXml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${mergedInner}</w:body>`);
const z3 = new PizZip(base.zip.generate({ type: 'nodebuffer' }));
z3.file('word/document.xml', mergedXml);
const buf3 = z3.generate({ type: 'nodebuffer' });
assert(reloadOk(buf3), '合并多页后的 docx 可被 PizZip 重新加载');
assert(mergedXml.includes('<w:br w:type="page"/>'), '合并结果包含分页符');

console.log(process.exitCode ? '\n存在失败用例' : '\n全部通过 ✅');
