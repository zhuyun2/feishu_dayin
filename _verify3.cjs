const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 与修复后的 docxStamp.ts 完全一致的算法
function parsePageSegments(docXml, bodyStart, bodyEnd) {
  const bounds = [];
  const pRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = pRe.exec(docXml))) {
    if (m.index < bodyStart || m.index >= bodyEnd) continue;
    const seg = m[0];
    const isBoundary =
      /<w:br[^>]*w:type="page"/.test(seg) ||
      /<w:pageBreakBefore(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(seg) ||
      /<w:sectPr[^>]*>/.test(seg);
    if (isBoundary) bounds.push({ start: m.index, end: m.index + seg.length });
  }
  const segments = [];
  let cur = bodyStart;
  bounds.forEach((b, i) => {
    if (i === 0) segments.push({ start: cur, end: b.start });
    else segments.push({ start: bounds[i - 1].end, end: b.start });
    cur = b.end;
  });
  segments.push({ start: cur, end: bodyEnd });
  return segments;
}

function insertionPoint(docXml, seg) {
  const region = docXml.slice(seg.start, seg.end);
  const pEnd = region.lastIndexOf('</w:p>');
  const tEnd = region.lastIndexOf('</w:tbl>');
  if (pEnd < 0 && tEnd < 0) return seg.start;
  const at = pEnd >= tEnd ? pEnd + '</w:p>'.length : tEnd + '</w:tbl>'.length;
  return seg.start + at;
}

function inject(docXml, perPage) {
  const bodyStart = docXml.indexOf('<w:body>');
  const bodyEnd = docXml.lastIndexOf('<w:sectPr');
  const segEnd = bodyEnd >= bodyStart ? bodyEnd : docXml.indexOf('</w:body>');
  const segments = parsePageSegments(docXml, bodyStart + '<w:body>'.length, segEnd);
  const insertions = [];
  segments.forEach((seg, k) => {
    const enabled = perPage[k] !== false;
    if (!enabled) return;
    const pos = insertionPoint(docXml, seg);
    const xml = '<w:p><w:pPr><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr><w:r><w:drawing><!--STAMP k' + k + '--></w:drawing></w:r></w:p>';
    insertions.push({ pos, xml, k });
  });
  let out = docXml;
  insertions.sort(function (a, b) { return b.pos - a.pos; });
  for (const ins of insertions) {
    out = out.slice(0, ins.pos) + ins.xml + out.slice(ins.pos);
  }
  return { out, segments, insertions };
}

function checkBal(xml) {
  const openP = (xml.match(/<w:p[ >]/g) || []).length;
  const selfClose = (xml.match(/<w:p\s[^>]*\/>/g) || []).length;
  const closeP = (xml.match(/<\/w:p>/g) || []).length;
  return { openP, selfClose, closeP, ok: openP - selfClose === closeP };
}

const tmpDir = path.join(__dirname, '.tmp_verify');
fs.mkdirSync(tmpDir, { recursive: true });
function getXml(tpl) {
  execSync('unzip -o -q "' + tpl + '" word/document.xml -d "' + tmpDir + '"');
  return fs.readFileSync(path.join(tmpDir, 'word/document.xml'), 'utf8');
}

// 测试1：巴德士-2 两页都盖
let xml = getXml('D:/Data/feishu_dayin-main/templates/tbl4rkmTWj4CuLgp/巴德士专用_K103S(有谱图-2).docx');
let r = inject(xml, {});
console.log('===== 测试1: 巴德士-2 两页都盖 =====');
console.log('页段:', r.segments.map(function (s) { return '[' + s.start + ',' + s.end + ')'; }).join(' '));
const brAbs = xml.indexOf('<w:br w:type="page"/>');
const ins0 = r.insertions.find(function (i) { return i.k === 0; });
const ins1 = r.insertions.find(function (i) { return i.k === 1; });
console.log('第1页插入点:', ins0.pos, '| 在分页符前:', ins0.pos < brAbs, '| 在页段0内:', ins0.pos >= r.segments[0].start && ins0.pos <= r.segments[0].end);
console.log('第2页插入点:', ins1.pos, '| 在分页符后:', ins1.pos > brAbs, '| 在页段1内:', ins1.pos >= r.segments[1].start && ins1.pos <= r.segments[1].end);
let b = checkBal(r.out);
console.log('XML 平衡:', b.ok, '(开' + (b.openP - b.selfClose) + ' 闭' + b.closeP + ')');

// 测试2：只盖第1页 / 只盖第2页
r = inject(xml, { 1: false });
console.log('===== 测试2: 只盖第1页 =====');
console.log('页段0有章:', r.out.includes('STAMP k0'), '| 页段1无章:', !r.out.includes('STAMP k1'));
r = inject(xml, { 0: false });
console.log('===== 测试3: 只盖第2页 =====');
console.log('页段0无章:', !r.out.includes('STAMP k0'), '| 页段1有章:', r.out.includes('STAMP k1'));

// 测试4：全模板扫描
console.log('===== 测试4: 全模板扫描 =====');
const tplDir = 'D:/Data/feishu_dayin-main/templates';
const allTemplates = execSync('find "' + tplDir + '" -name "*.docx"').toString().trim().split('\n');
let pass = 0, fail = 0, multi = 0;
for (const t of allTemplates) {
  try {
    xml = getXml(t);
    r = inject(xml, {});
    const hasBoundary = /<w:br[^>]*w:type="page"/.test(xml) || /<w:pageBreakBefore/.test(xml) || /<w:pPr><w:sectPr/.test(xml);
    const allInSeg = r.insertions.every(function (ins) {
      const seg = r.segments[ins.k];
      return ins.pos >= seg.start && ins.pos <= seg.end;
    });
    b = checkBal(r.out);
    const origBal = checkBal(xml);
    if (hasBoundary) { multi++; console.log('[多页]', path.basename(t), '| 页段:', r.segments.length); }
    if (allInSeg && b.ok && origBal.ok) pass++;
    else { fail++; console.log('[FAIL]', path.basename(t), 'inSeg:', allInSeg, 'bal:', b.ok, 'origBal:', origBal.ok); }
  } catch (e) { fail++; console.log('[ERR ]', path.basename(t), e.message); }
}
console.log('通过: ' + pass + ', 失败: ' + fail + ', 含页边界模板: ' + multi);
