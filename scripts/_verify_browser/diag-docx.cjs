// Parse docx and report page setup + header layout
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const ROOT = path.resolve(__dirname, '../..');
const file = process.argv[2] || '10%卡松+货CJ-2-测试模版.docx';
const tplPath = path.join(ROOT, 'templates', 'tbldeXFrTixlf6sB', file);
const buf = fs.readFileSync(tplPath);
const zip = new PizZip(buf);

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// 1) document.xml — page size and margins
const docXml = zip.file('word/document.xml').asText();
const sectPrMatch = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
if (sectPrMatch) {
  const sect = sectPrMatch[0];
  const pgSz = sect.match(/<w:pgSz[^>]*\/>/)?.[0];
  const pgMar = sect.match(/<w:pgMar[^>]*\/>/)?.[0];
  console.log('=== Section properties ===');
  console.log('  pgSz:', pgSz);
  console.log('  pgMar:', pgMar);
}

// 2) header2.xml — header height, header content
console.log('\n=== Header content ===');
const headerPath = Object.keys(zip.files).find(p => /^word\/header\d+\.xml$/i.test(p));
console.log('  file:', headerPath);
const headerXml = zip.file(headerPath).asText();

// parse out the simple w:p elements
const pMatches = headerXml.match(/<w:p[\s\S]*?<\/w:p>/g) || [];
console.log(`  paragraph count: ${pMatches.length}`);
pMatches.forEach((p, i) => {
  // Strip attributes for readability
  const text = (p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
  const drawing = p.includes('<w:drawing>') || p.includes('<w:pict>');
  console.log(`    [${i}] text="${text.slice(0, 60)}" hasDrawing=${drawing}`);
});

// 3) anchors (already known)
console.log('\n=== Anchors (from word/header2.xml) ===');
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
// Use simple regex to find anchor blocks
const anchorBlocks = headerXml.match(/<wp:anchor[\s\S]*?<\/wp:anchor>/g) || [];
console.log(`  anchor count: ${anchorBlocks.length}`);
for (let i = 0; i < anchorBlocks.length; i++) {
  const a = anchorBlocks[i];
  const behindDoc = a.match(/behindDoc="(\d)"/)?.[1];
  const cx = parseInt(a.match(/<wp:extent cx="(\d+)"/)?.[1] || '0', 10);
  const cy = parseInt(a.match(/<wp:extent cy="(\d+)"/)?.[1] || '0', 10);
  const relH = a.match(/<wp:positionH relativeFrom="(\w+)"/)?.[1];
  const relV = a.match(/<wp:positionV relativeFrom="(\w+)"/)?.[1];
  const offH = parseInt(a.match(/<wp:positionH[\s\S]*?<wp:posOffset>(-?\d+)/)?.[1] || '0', 10);
  const offV = parseInt(a.match(/<wp:positionV[\s\S]*?<wp:posOffset>(-?\d+)/)?.[1] || '0', 10);
  const hasBlip = a.includes('<a:blip');
  const hasWsp = a.includes('<wps:wsp');
  const type = hasBlip ? 'image' : hasWsp ? 'textbox' : 'unknown';
  const isTextbox = type === 'textbox';
  let padding = null;
  if (isTextbox) {
    const bodyPr = a.match(/<wps:bodyPr([^>]*)>/)?.[1] || '';
    padding = {
      lIns: parseInt(bodyPr.match(/lIns="(\d+)"/)?.[1] || '0', 10),
      tIns: parseInt(bodyPr.match(/tIns="(\d+)"/)?.[1] || '0', 10),
      rIns: parseInt(bodyPr.match(/rIns="(\d+)"/)?.[1] || '0', 10),
      bIns: parseInt(bodyPr.match(/bIns="(\d+)"/)?.[1] || '0', 10),
    };
  }
  console.log(`  [${i}] ${type} behindDoc=${behindDoc}`);
  console.log(`      size: ${cx / 9525} x ${cy / 9525} px (${cx} x ${cy} EMU)`);
  console.log(`      relH=${relH} relV=${relV} offH=${offH / 9525} offV=${offV / 9525} px`);
  if (padding) console.log(`      padding (EMU):`, padding, '→ px:', {
    l: padding.lIns / 9525, t: padding.tIns / 9525, r: padding.rIns / 9525, b: padding.bIns / 9525,
  });
}

// 4) Compute expected positions
const pgMarMatch = docXml.match(/<w:pgMar[^>]*\/>/)?.[0] || '';
const top = parseInt(pgMarMatch.match(/w:top="(\d+)"/)?.[1] || '0', 10);
const left = parseInt(pgMarMatch.match(/w:left="(\d+)"/)?.[1] || '0', 10);
const right = parseInt(pgMarMatch.match(/w:right="(\d+)"/)?.[1] || '0', 10);
const bottom = parseInt(pgMarMatch.match(/w:bottom="(\d+)"/)?.[1] || '0', 10);
const headerMargin = parseInt(pgMarMatch.match(/w:header="(\d+)"/)?.[1] || '0', 10);
const pgSzMatch = docXml.match(/<w:pgSz[^>]*\/>/)?.[0] || '';
const pageW = parseInt(pgSzMatch.match(/w:w="(\d+)"/)?.[1] || '0', 10);
const pageH = parseInt(pgSzMatch.match(/w:h="(\d+)"/)?.[1] || '0', 10);

console.log('\n=== Page metrics (twips: 1/20 pt, 1pt=20twip) ===');
console.log(`  page: ${pageW/20} x ${pageH/20} pt = ${pageW/567} x ${pageH/567} cm`);
console.log(`  margins: top=${top/20}pt left=${left/20}pt right=${right/20}pt bottom=${bottom/20}pt`);
console.log(`  header offset: ${headerMargin/20}pt from top of page`);

// In docx-preview, the section is the page rendered at some scale.
// At 96 DPI, 1pt = 1.333px. So:
console.log('\n=== At 96 DPI ===');
console.log(`  page px: ${pageW/20*1.333} x ${pageH/20*1.333}`);
console.log(`  margins px: top=${top/20*1.333} left=${left/20*1.333} right=${right/20*1.333} bottom=${bottom/20*1.333}`);

// The header renders at (0, 0) inside the section, with the paragraph at headerMargin offset
// Wait, in OOXML, header sits in the page's "header" zone which is above the body content area
// So the section content area (body) starts at y = headerHeight + headerMargin
// In docx-preview, the section is rendered as a single block. The header is rendered at the top of the section.
// Typically the section has padding-top that includes the header zone.

// In docx-preview, the section.docx is the full page. The body content (paragraphs) has padding-top representing the top margin.
// The header is rendered ABOVE the body, with its own padding.
// So the section's effective padding is actually top margin + body content height? Or the section is the full page with padding-left/right for side margins, and padding-top includes header zone?

// Let me just compute: if relativeFrom=column with offset -13.6 from content area's left edge:
//   position = padding-left + offset
// where padding-left is the section's left padding (= page left margin in px)
// and offset is the EMU offset converted to px

console.log('\n=== Expected positions (Word semantics) ===');
// 1 inch = 914400 EMU. 1pt = 12700 EMU. 1px = 9525 EMU (at 96 DPI)
const ptToPx = 96 / 72;
const marginLeftPx = left / 20 * ptToPx;
const marginTopPx = top / 20 * ptToPx;
const marginHeaderPx = headerMargin / 20 * ptToPx;
console.log(`  marginLeft px: ${marginLeftPx}, marginTop px: ${marginTopPx}, headerOffset px: ${marginHeaderPx}`);

anchorBlocks.forEach((a, i) => {
  const cx = parseInt(a.match(/<wp:extent cx="(\d+)"/)?.[1] || '0', 10);
  const cy = parseInt(a.match(/<wp:extent cy="(\d+)"/)?.[1] || '0', 10);
  const relH = a.match(/<wp:positionH relativeFrom="(\w+)"/)?.[1];
  const relV = a.match(/<wp:positionV relativeFrom="(\w+)"/)?.[1];
  const offH = parseInt(a.match(/<wp:positionH[\s\S]*?<wp:posOffset>(-?\d+)/)?.[1] || '0', 10);
  const offV = parseInt(a.match(/<wp:positionV[\s\S]*?<wp:posOffset>(-?\d+)/)?.[1] || '0', 10);
  const hasBlip = a.includes('<a:blip');
  const type = hasBlip ? 'image' : 'textbox';
  // Compute baseH/baseV
  let baseH = 0, baseV = 0;
  // In Word, relativeFrom=column = content area (after margin), margin = page edge (full page)
  // Most "column" interpretations: baseH = 0 (column starts at content area's left)
  // But in many implementations, column == margin for single-column layouts
  // The base in docx-preview is the section's padding edge (= content area's top-left)
  // So if relativeFrom=column and offset=X, the element's left (relative to section padding edge) is just X
  baseH = offH / 9525; // column == padding edge
  baseV = offV / 9525; // paragraph == padding edge (placeholder for now)
  console.log(`  [${i}] ${type}: CSS left=${baseH.toFixed(2)} top=${baseV.toFixed(2)} (relH=${relH} relV=${relV})`);
});
