/* 修正版校验：精确 w:p 标签统计 + 段落边界定位锚点 */
const fs = require('fs');
const JSZip = require('jszip');

function countWpTags(xml) {
  // 只匹配真正的 <w:p 标签（前瞻排除 pPr/pStyle/pBdr/pTabs/pShd 等）
  const opens = [];
  const re = /<w:p(?=[\s/>])/g;
  let m;
  while ((m = re.exec(xml))) {
    const rest = xml.slice(m.index + 4);
    if (rest[0] === '>') opens.push({ self: false });
    else if (rest[0] === '/') opens.push({ self: true });
    else {
      const gt = rest.indexOf('>');
      opens.push({ self: rest.slice(0, gt).endsWith('/') });
    }
  }
  const openReal = opens.filter(o => !o.self).length;
  const selfReal = opens.filter(o => o.self).length;
  const closeP = (xml.match(/<\/w:p>/g) || []).length;
  return { openReal, selfReal, closeP, bal: openReal === closeP };
}

function findAnchors(docXml) {
  const out = [];
  let idx = 0;
  while (true) {
    const i = docXml.indexOf('<wp:anchor', idx);
    if (i < 0) break;
    // 精确找所属段落起始：向前找最近的 <w:p 或 <w:p>（不跨越 </w:p>）
    let pStart = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (docXml.startsWith('</w:p>', j)) { pStart = -1; break; } // 越过了段落结束，说明 anchor 不在段落内（异常）
      if (docXml.startsWith('<w:p ', j) || docXml.startsWith('<w:p>', j)) { pStart = j; break; }
    }
    // 段落结束
    const pEnd = docXml.indexOf('</w:p>', i) + 6;
    if (pStart >= 0 && pEnd > 6) {
      const para = docXml.slice(pStart, pEnd);
      const rEmbed = (para.match(/r:embed="([^"]+)"/) || [])[1] || '';
      const posH = (para.match(/<wp:posOffset>([^<]*)<\/wp:posOffset>/g) || []).map(x => x.replace(/<\/?wp:posOffset>/g, ''));
      const name = (/<wp:docPr[^>]*name="([^"]*)"/.exec(para) || [])[1] || '';
      // 段号 = 段落起始之前出现的 page break 数
      const before = docXml.slice(0, pStart);
      const segIdx = before.split('<w:br w:type="page"/>').length - 1;
      out.push({ segIdx, rEmbed, posH, name });
    }
    idx = i + 10;
  }
  return out;
}

async function analyze(file, expect) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const docXml = await zip.files['word/document.xml'].async('string');
  const relsXml = await zip.files['word/_rels/document.xml.rels'].async('string');
  const ctXml = await zip.files['[Content_Types].xml'].async('string');
  const t = countWpTags(docXml);
  const anchors = findAnchors(docXml);
  const hasPng = ctXml.includes('Extension="png"');
  const hasRels = relsXml.includes('rIdStamp0');
  // zip 完整性
  let zipOk = true;
  try { await Promise.all(Object.values(zip.files).map(f => f.async('uint8array'))); } catch (e) { zipOk = false; }

  console.log('='.repeat(64));
  console.log(file);
  console.log(`  w:p 标签: open=${t.openReal} selfClose=${t.selfReal} close=${t.closeP} 平衡=${t.bal ? '✅' : '❌'}`);
  console.log(`  rels rIdStamp0=${hasRels ? '✅' : '❌'}  png类型=${hasPng ? '✅' : '❌'}  zip完整=${zipOk ? '✅' : '❌'}`);
  console.log(`  锚点: ${anchors.length} 个`);
  for (const a of anchors) {
    console.log(`    seg#${a.segIdx} name="${a.name}" r:embed=${a.rEmbed} posOffset=[${a.posH.join(',')}]`);
  }
  const gotSegs = anchors.map(a => a.segIdx).sort((x, y) => x - y);
  const expSegs = [...expect.segs].sort((x, y) => x - y);
  const segOk = JSON.stringify(gotSegs) === JSON.stringify(expSegs);
  const allOk = t.bal && hasPng && hasRels && zipOk && segOk && anchors.every(a => a.rEmbed === 'rIdStamp0');
  console.log(`  段分布期望=[${expSegs.join(',')}] 实际=[${gotSegs.join(',')}] ${segOk ? '✅' : '❌'}`);
  console.log(`  结果: ${allOk ? '✅ 全部通过' : '❌ 存在问题'}`);
  return allOk;
}

(async () => {
  const results = [];
  results.push(await analyze('_stamp_test_A.docx', { segs: [0, 1] }));
  results.push(await analyze('_stamp_test_B.docx', { segs: [0] }));
  results.push(await analyze('_stamp_test_C.docx', { segs: [1] }));
  results.push(await analyze('_stamp_test_D.docx', { segs: [0, 1] }));
  console.log('='.repeat(64));
  console.log(results.every(Boolean) ? '✅ 四个文件全部通过端到端校验' : '❌ 存在失败项');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
