// Diagnostic: render the docx with docx-preview in jsdom and measure real coords.
// Run: node scripts/_verify_browser/diag-positions.cjs

const path = require('path');
const fs = require('fs');
const { JSDOM, ResourceLoader } = require('jsdom');
const PizZip = require('pizzip');
const ROOT = path.resolve(__dirname, '../..');
const file = process.argv[2] || '10%卡松+货CJ-2-测试模版.docx';
const tplPath = path.join(ROOT, 'templates', 'tbldeXFrTixlf6sB', file);
const buf = fs.readFileSync(tplPath);
const blob = new Blob([buf]);

// 1) parse header anchors with the same logic as fallback
const zip = new PizZip(buf);
function findHeaderAnchors() {
  const out = [];
  const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const paths = Object.keys(zip.files).filter(p => /^word\/header\d+\.xml$/i.test(p));
  for (const p of paths) {
    const xml = zip.file(p).asText();
    const dom = new JSDOM(xml, { contentType: 'application/xml' }).window.document;
    const anchors = dom.getElementsByTagNameNS(NS_WP, 'anchor');
    for (const a of Array.from(anchors)) {
      const extent = a.getElementsByTagNameNS(NS_WP, 'extent')[0];
      const posH = a.getElementsByTagNameNS(NS_WP, 'positionH')[0];
      const posV = a.getElementsByTagNameNS(NS_WP, 'positionV')[0];
      const behindDoc = a.getAttribute('behindDoc') === '1';
      const isImage = a.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip').length > 0;
      const isTextbox = a.getElementsByTagNameNS('http://schemas.microsoft.com/office/word/2010/wordprocessingShape', 'wsp').length > 0;
      out.push({
        file: p,
        behindDoc,
        type: isImage ? 'image' : isTextbox ? 'textbox' : 'unknown',
        cx: parseInt(extent?.getAttribute('cx') || '0', 10),
        cy: parseInt(extent?.getAttribute('cy') || '0', 10),
        relH: posH?.getAttribute('relativeFrom') || 'column',
        relV: posV?.getAttribute('relativeFrom') || 'paragraph',
        offsetH: parseInt(posH?.getElementsByTagNameNS(NS_WP, 'posOffset')[0]?.textContent || '0', 10),
        offsetV: parseInt(posV?.getElementsByTagNameNS(NS_WP, 'posOffset')[0]?.textContent || '0', 10),
      });
    }
  }
  return out;
}

const anchors = findHeaderAnchors();
console.log('=== Header anchors (OOXML) ===');
for (const a of anchors) {
  const h = a.cx / 9525, v = a.cy / 9525;
  const oh = a.offsetH / 9525, ov = a.offsetV / 9525;
  console.log(`  ${a.type} [${a.file}] behindDoc=${a.behindDoc} size=${h.toFixed(1)}x${v.toFixed(1)} relH=${a.relH} relV=${a.relV} offH=${oh.toFixed(2)} offV=${ov.toFixed(2)}`);
}

// 2) Render with docx-preview in jsdom
const html = `<!DOCTYPE html><html><head><style>body{margin:0;padding:0;font-family:serif;}</style></head><body><div id="root" style="width:794px;"></div></body></html>`;
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const document = dom.window.document;
const root = document.getElementById('root');

// Make DOMParser / Image / etc. available to libraries that look for them on global
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.DocumentFragment = dom.window.DocumentFragment;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLImageElement = dom.window.HTMLImageElement;
global.Image = dom.window.Image;
global.window = dom.window;
global.document = document;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.HTMLAnchorElement = dom.window.HTMLAnchorElement;
global.NodeFilter = dom.window.NodeFilter;

(async () => {
  // docx-preview is published as ESM; we use the prebuilt CJS via the React app's dist
  // Instead, emulate what the app does: load the script and call renderAsync.
  const docxPreview = require(path.join(ROOT, 'node_modules', 'docx-preview', 'dist', 'docx-preview.js'));
  // docx-preview needs ArrayBuffer/Buffer
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  console.log('\n=== Render with docx-preview ===');
  await docxPreview.renderAsync(ab, root, undefined, {
    className: 'docx', inWrapper: true, breakPages: true,
    ignoreWidth: false, ignoreHeight: false, ignoreFonts: false,
    useBase64URL: true, experimental: true,
  });

  // Wait a tick for layout
  await new Promise(r => setTimeout(r, 200));

  const section = root.querySelector('section.docx');
  if (!section) {
    console.log('  NO section.docx');
    process.exit(1);
  }
  const cs = dom.window.getComputedStyle(section);
  console.log(`  section offsetWidth x offsetHeight: ${section.offsetWidth} x ${section.offsetHeight}`);
  console.log(`  section padding: L=${cs.paddingLeft} T=${cs.paddingTop} R=${cs.paddingRight} B=${cs.paddingBottom}`);
  console.log(`  section position: ${cs.position}`);

  const header = section.querySelector('header');
  if (!header) {
    console.log('  NO <header>');
  } else {
    const hcs = dom.window.getComputedStyle(header);
    console.log(`  <header> offsetWidth x offsetHeight: ${header.offsetWidth} x ${header.offsetHeight}`);
    console.log(`  <header> computed style: position=${hcs.position} margin-top=${hcs.marginTop} margin-bottom=${hcs.marginBottom} padding-top=${hcs.paddingTop}`);
    console.log(`  <header> child count: ${header.children.length}`);
    header.childNodes.forEach((c, i) => {
      console.log(`    [${i}] ${c.nodeName} class=${c.className || ''} text="${(c.textContent || '').slice(0, 40)}"`);
    });
  }

  // 3) Apply fallback and measure
  // docxHeaderFallback is TS, compile it inline using a quick require of the compiled output
  const { execSync } = require('child_process');
  execSync(
    `npx tsc --target es2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --outDir ${path.join(__dirname, '.cjs-build')} src/services/docxHeaderFallback.ts`,
    { cwd: ROOT, stdio: 'ignore' }
  );
  const fb = require(path.join(__dirname, '.cjs-build', 'docxHeaderFallback.js'));
  await fb.injectHeaderFallback(blob, root);
  // also try arraybuffer
  // await fb.injectHeaderFallback(ab, root);
  console.log('\n=== Fallback injection result ===');
  const layer = root.querySelector('.docx-header-fallback');
  if (!layer) {
    console.log('  NO fallback layer');
  } else {
    console.log(`  fallback layer children: ${layer.children.length}`);
    for (const ch of layer.children) {
      const cs2 = dom.window.getComputedStyle(ch);
      console.log(`  child type=${ch.dataset.fallbackType} style: left=${cs2.left} top=${cs2.top} w=${cs2.width} h=${cs2.height} z-index=${cs2.zIndex}`);
    }
  }

  // Dump rendered HTML to a file for visual inspection
  const outPath = path.join(__dirname, 'diag-rendered.html');
  fs.writeFileSync(outPath, '<!DOCTYPE html>' + root.outerHTML);
  console.log(`\n  Rendered HTML written to ${outPath}`);
})();
