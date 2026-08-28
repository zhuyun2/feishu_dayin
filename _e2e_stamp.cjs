// 端到端验证：真实模板 + 真实注入（pizzip），生成盖章 docx 并校验
const PizZip = require('pizzip');
const fs = require('fs');
const path = require('path');

// 1x1 红色 PNG（base64）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 与 docxStamp.ts 一致的算法（含修复后的 parsePageSegments）
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

const EMU_PER_TWIP = 635;

function buildAnchorParagraph(opts) {
  const { id, rId, ext, cx, cy, left, top, opacity } = opts;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 100000);
  return [
    '<w:p>',
    '<w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>',
    '<w:r><w:drawing>',
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">',
    '<wp:simplePos x="0" y="0"/>',
    '<wp:positionH relativeFrom="page"><wp:posOffset>' + Math.round(left) + '</wp:posOffset></wp:positionH>',
    '<wp:positionV relativeFrom="page"><wp:posOffset>' + Math.round(top) + '</wp:posOffset></wp:positionV>',
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/>',
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
    '<wp:wrapNone/>',
    '<wp:docPr id="' + id + '" name="stamp' + id + '" descr=""/>',
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="stamp' + id + '.png"/><pic:cNvPicPr/></pic:nvPicPr>',
    '<pic:blipFill>',
    '<a:blip r:embed="' + rId + '"><a:alphaModFix amt="' + alpha + '"/></a:blip>',
    '<a:stretch><a:fillRect/></a:stretch>',
    '</pic:blipFill>',
    '<pic:spPr>',
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>',
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</pic:spPr>',
    '</pic:pic>',
    '</a:graphicData>',
    '</a:graphic>',
    '</wp:anchor>',
    '</w:drawing></w:r>',
    '</w:p>',
  ].join('');
}

function injectStampsIntoZip(zip, config) {
  const docXml = zip.file('word/document.xml').asText();
  const contentTypes = zip.file('[Content_Types].xml').asText();
  const relsXml = zip.file('word/_rels/document.xml.rels').asText();
  let ct = contentTypes;
  let rels = relsXml;

  const base = { x: 72, y: 72 }; // right-bottom
  const mw = docXml.match(/<w:pgSz[^>]*w:w="(\d+)"/);
  const mh = docXml.match(/<w:pgSz[^>]*w:h="(\d+)"/);
  const page = { w: (mw ? parseInt(mw[1]) : 11906) * EMU_PER_TWIP, h: (mh ? parseInt(mh[1]) : 16838) * EMU_PER_TWIP };
  const stampWEmu = Math.round((page.w * config.size) / 100);

  // 注册图片与关系（1 枚印章）
  ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  rels = rels.replace('</Relationships>', '<Relationship Id="rIdStamp0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp0.png"/></Relationships>');
  zip.file('word/media/stamp0.png', PNG_1PX, { base64: true });

  const bodyStart = docXml.indexOf('<w:body>');
  const bodyEnd = docXml.lastIndexOf('<w:sectPr');
  const segEnd = bodyEnd >= bodyStart ? bodyEnd : docXml.indexOf('</w:body>');
  const segments = parsePageSegments(docXml, bodyStart + '<w:body>'.length, segEnd);

  const insertions = [];
  segments.forEach((seg, k) => {
    const enabled = (config.pages || {})[k] ? config.pages[k].enabled !== false : true;
    if (!enabled) return;
    const anchor = config.anchorText && config.anchorText.trim() ? ((config.pages || {})[k] || {}).anchor || config.anchor : undefined;
    const pos = insertionPoint(docXml, seg);
    const infoH = 1, infoW = 1;
    const stampHEmu = Math.round((stampWEmu * infoH) / infoW);
    const centerX = page.w * (((anchor ? anchor.x : base.x) + (config.offsetX || 0)) / 100);
    const centerY = page.h * (((anchor ? anchor.y : base.y) + (config.offsetY || 0)) / 100);
    const left = Math.max(0, centerX - stampWEmu / 2);
    const top = Math.max(0, centerY - stampHEmu / 2);
    const para = buildAnchorParagraph({
      id: 100 + k * 10,
      rId: 'rIdStamp0',
      ext: 'png',
      cx: stampWEmu,
      cy: stampHEmu,
      left, top,
      opacity: config.opacity || 0.85,
    });
    insertions.push({ pos, xml: para, k });
  });

  let out = docXml;
  insertions.sort(function (a, b) { return b.pos - a.pos; });
  for (const ins of insertions) {
    out = out.slice(0, ins.pos) + ins.xml + out.slice(ins.pos);
  }
  zip.file('[Content_Types].xml', ct);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('word/document.xml', out);
  return zip;
}

// ============ 运行 ============
const tpl = 'D:/Data/feishu_dayin-main/templates/tbl4rkmTWj4CuLgp/巴德士专用_K103S(有谱图-2).docx';
const buf = fs.readFileSync(tpl);
const zip = new PizZip(buf);

// 场景 A：两页都盖（锚定模式，pages 有每页锚点）
const cfgA = {
  stamps: ['章.png'], position: 'right-bottom', size: 18, opacity: 0.85, offsetX: 0, offsetY: 0,
  anchorText: 'Official Seal',
  anchor: { x: 50, y: 50 },
  pages: {
    0: { enabled: true, anchor: { x: 40, y: 45 } },
    1: { enabled: true, anchor: { x: 55, y: 60 } },
  },
};
const zipA = injectStampsIntoZip(new PizZip(buf), cfgA);
const outA = zipA.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(path.join(__dirname, '_stamp_test_A.docx'), outA);

// 场景 B：只盖第 1 页
const cfgB = { ...cfgA, pages: { 0: { enabled: true, anchor: { x: 40, y: 45 } }, 1: { enabled: false } } };
const zipB = injectStampsIntoZip(new PizZip(buf), cfgB);
fs.writeFileSync(path.join(__dirname, '_stamp_test_B.docx'), zipB.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));

// 场景 C：只盖第 2 页
const cfgC = { ...cfgA, pages: { 0: { enabled: false }, 1: { enabled: true, anchor: { x: 55, y: 60 } } } };
const zipC = injectStampsIntoZip(new PizZip(buf), cfgC);
fs.writeFileSync(path.join(__dirname, '_stamp_test_C.docx'), zipC.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));

// 场景 D：无 pages 配置（旧配置兼容 → 每页都盖）
const zipD = injectStampsIntoZip(new PizZip(buf), { stamps: ['章.png'], position: 'right-bottom', size: 18, opacity: 0.85, offsetX: 0, offsetY: 0 });
fs.writeFileSync(path.join(__dirname, '_stamp_test_D.docx'), zipD.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log('已生成 4 个盖章 docx 测试文件');
for (const f of ['_stamp_test_A.docx', '_stamp_test_B.docx', '_stamp_test_C.docx', '_stamp_test_D.docx']) {
  const size = fs.statSync(path.join(__dirname, f)).size;
  console.log(f, size, 'bytes');
}
