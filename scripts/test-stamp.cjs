// 冒烟测试：把印章注入真实模板 docx，验证 zip 结构与 XML 正确性。
// 逻辑与 src/services/docxStamp.ts 逐行对齐（CJS 复刻），供 Node 端验证。
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATES = [
  'D:/Data/feishu_dayin-main/templates/tbldeXFrTixlf6sB/柏舒逸 Bersulli.docx',
  'D:/Data/feishu_dayin-main/templates/tbldeXFrTixlf6sB/10%卡松+货CJ-2-测试模版.docx',
];

const EMU_PER_TWIP = 635;
const POSITION_BASE = {
  'right-bottom': { x: 72, y: 72 },
  'left-bottom': { x: 10, y: 72 },
  'center': { x: 50, y: 45 },
  'right-top': { x: 72, y: 8 },
  'bottom-center': { x: 50, y: 72 },
};

function base64ToBytes(b64) {
  return Buffer.from(b64, 'base64');
}

function detectImage(bin) {
  if (bin.length >= 8 && bin[0] === 0x89 && bin[1] === 0x50 && bin[2] === 0x4e && bin[3] === 0x47) {
    const w = (bin[16] << 24) | (bin[17] << 16) | (bin[18] << 8) | bin[19];
    const h = (bin[20] << 24) | (bin[21] << 16) | (bin[22] << 8) | bin[23];
    return { w, h, ext: 'png' };
  }
  return null;
}

function getPageSizeEmu(docXml) {
  const mw = docXml.match(/<w:pgSz[^>]*w:w="(\d+)"/);
  const mh = docXml.match(/<w:pgSz[^>]*w:h="(\d+)"/);
  const w = (mw ? parseInt(mw[1], 10) : 11906) * EMU_PER_TWIP;
  const h = (mh ? parseInt(mh[1], 10) : 16838) * EMU_PER_TWIP;
  return { w, h };
}

function ensureContentType(contentTypes, ext) {
  if (contentTypes.includes(`Extension="${ext}"`)) return contentTypes;
  const type = ext === 'png' ? 'image/png' : 'image/jpeg';
  return contentTypes.replace('</Types>', `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
}

function buildAnchorParagraph({ id, rId, ext, cx, cy, left, top, opacity }) {
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 100000);
  return [
    '<w:p>',
    '<w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>',
    '<w:r><w:drawing>',
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">',
    '<wp:simplePos x="0" y="0"/>',
    `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(left)}</wp:posOffset></wp:positionH>`,
    `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(top)}</wp:posOffset></wp:positionV>`,
    `<wp:extent cx="${cx}" cy="${cy}"/>`,
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
    '<wp:wrapNone/>',
    `<wp:docPr id="${id}" name="stamp${id}" descr=""/>`,
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="stamp${id}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>`,
    '<pic:blipFill>',
    `<a:blip r:embed="${rId}"><a:alphaModFix amt="${alpha}"/></a:blip>`,
    '<a:stretch><a:fillRect/></a:stretch>',
    '</pic:blipFill>',
    '<pic:spPr>',
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
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

function injectStampsIntoZip(zip, stamps, config) {
  if (!stamps.length) return zip;
  const docXml = zip.file('word/document.xml').asText();
  const contentTypes = zip.file('[Content_Types].xml').asText();
  const relsXml = zip.file('word/_rels/document.xml.rels').asText();
  let ct = contentTypes;
  let rels = relsXml;
  const drawings = [];
  const base = POSITION_BASE[config.position] || POSITION_BASE['right-bottom'];
  const page = getPageSizeEmu(docXml);
  const stampWEmu = Math.round((page.w * config.size) / 100);
  stamps.forEach((stamp, i) => {
    const bytes = base64ToBytes(stamp.base64);
    const info = detectImage(bytes);
    if (!info) throw new Error(`印章「${stamp.name}」格式无法识别`);
    const id = 100 + i;
    const rId = `rIdStamp${i}`;
    const mediaName = `word/media/stamp${i}.${info.ext}`;
    const stampHEmu = Math.round((stampWEmu * info.h) / info.w);
    ct = ensureContentType(ct, info.ext);
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp${i}.${info.ext}"/></Relationships>`
    );
    zip.file(mediaName, stamp.base64, { base64: true });
    // 印章中心点（% 页宽/高），多枚向下错开 i*9%；anchor 定位点是图片左上角
    const centerX = page.w * ((base.x + config.offsetX) / 100);
    const centerY = page.h * ((base.y + config.offsetY + i * 9) / 100);
    drawings.push(buildAnchorParagraph({
      id, rId, ext: info.ext, cx: stampWEmu, cy: stampHEmu,
      left: Math.max(0, centerX - stampWEmu / 2),
      top: Math.max(0, centerY - stampHEmu / 2),
      opacity: config.opacity,
    }));
  });
  zip.file('[Content_Types].xml', ct);
  zip.file('word/_rels/document.xml.rels', rels);
  if (docXml.includes('</w:body>')) {
    zip.file('word/document.xml', docXml.replace('</w:body>', drawings.join('') + '</w:body>'));
  }
  return zip;
}

// ---- 主流程 ----
const stampB64 = fs.readFileSync('D:/Data/feishu_dayin-main/scripts/test-stamp.png').toString('base64');
const config = { position: 'right-bottom', size: 18, opacity: 0.85, offsetX: 0, offsetY: 0 };

let failed = 0;
for (const tpl of TEMPLATES) {
  const buf = fs.readFileSync(tpl);
  const zip = new PizZip(buf);
  injectStampsIntoZip(zip, [{ name: 'test-stamp.png', base64: stampB64 }], config);
  const out = zip.generate({ type: 'nodebuffer', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });

  const outZip = new PizZip(out);
  const checks = [];
  checks.push(['media 有印章图', !!outZip.file('word/media/stamp0.png')]);
  checks.push(['Content_Types 有 png 声明', outZip.file('[Content_Types].xml').asText().includes('Extension="png"')]);
  const rels = outZip.file('word/_rels/document.xml.rels').asText();
  checks.push(['rels 有 rIdStamp0', rels.includes('Id="rIdStamp0"') && rels.includes('media/stamp0.png')]);
  const docXml = outZip.file('word/document.xml').asText();
  checks.push(['document.xml 有 wp:anchor', docXml.includes('<wp:anchor')]);
  checks.push(['anchor 相对 page', docXml.includes('relativeFrom="page"')]);
  checks.push(['有 posOffset', docXml.includes('<wp:posOffset>')]);
  checks.push(['有透明度 alphaModFix', docXml.includes('alphaModFix')]);
  checks.push(['behindDoc=0 浮于文字上', docXml.includes('behindDoc="0"')]);
  // 印章 anchor 段：从「印章自己的 docPr id=100」往前找最近的 <wp:anchor
  const docPrIdx = docXml.indexOf('<wp:docPr id="100"');
  const segStart = docXml.lastIndexOf('<wp:anchor', docPrIdx);
  const anchorSeg = docXml.slice(segStart, docPrIdx + 400);
  // 尺寸：18% 页宽（方形印章 cx==cy），按模板真实页宽计算
  const page = getPageSizeEmu(docXml);
  const expW = Math.round((page.w * 18) / 100);
  const m = anchorSeg.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  checks.push(['extent 尺寸合理(≈18%页宽)', m && Math.abs(+m[1] - expW) < 1000 && +m[2] === +m[1]]);
  // 位置：right-bottom(72%,72%) → posOffset 左上角 = 中心 - 尺寸/2
  const expLeft = Math.round((page.w * 72) / 100 - expW / 2);
  const expTop = Math.round((page.h * 72) / 100 - expW / 2);
  const hSeg = anchorSeg.match(/<wp:positionH relativeFrom="page"><wp:posOffset>(-?\d+)<\/wp:posOffset>/);
  const vSeg = anchorSeg.match(/<wp:positionV relativeFrom="page"><wp:posOffset>(-?\d+)<\/wp:posOffset>/);
  checks.push(['H posOffset 匹配右下角 72%', hSeg && Math.abs(+hSeg[1] - expLeft) < 2]);
  checks.push(['V posOffset 匹配 72%', vSeg && Math.abs(+vSeg[1] - expTop) < 2]);
  // 锚定段落插在 </w:body> 前
  const bodyEnd = docXml.lastIndexOf('</w:body>');
  const anchorAt = docXml.indexOf('<wp:anchor');
  checks.push(['anchor 在 body 末尾之前', anchorAt > -1 && anchorAt < bodyEnd]);

  const allOk = checks.every(([, ok]) => ok);
  console.log(`${allOk ? '✅' : '❌'} ${path.basename(tpl)}`);
  for (const [name, ok] of checks) {
    if (!ok) { failed++; console.log('   ❌ ' + name); }
  }
  if (allOk) console.log('   全部通过（11 项检查）');

  // 输出盖章后的 docx 供人工打开验证
  const outName = `D:/Data/feishu_dayin-main/scripts/out-stamped-${path.basename(tpl).replace(/\.docx$/, '')}.docx`;
  fs.writeFileSync(outName, out);
  console.log(`   已输出: ${outName}`);
}

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
