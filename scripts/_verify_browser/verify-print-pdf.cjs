// 模拟真实打印流程：在 iframe 中渲染 docx + fallback，注入 @page 样式，导出 PDF 查看分页。
// Run: node scripts/_verify_browser/verify-print-pdf.cjs [file] [outPdf]
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const file = process.argv[2] || '50%苯扎氯铵+货A011.docx';
const outPdf = process.argv[3] || path.join(__dirname, 'print-preview.pdf');
const url = `http://127.0.0.1:5173/templates/_diag/measure-fb.html?file=${encodeURIComponent(file)}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE>', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERR>', err.message));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('info')?.textContent || '';
    return t && !t.startsWith('loading...') && !t.startsWith('js loaded') && !t.startsWith('fetching') && !t.startsWith('rendering') && !t.startsWith('injecting');
  }, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 300));

  // 像 print.ts 一样注入打印样式
  await page.evaluate(() => {
    const section = document.querySelector('section.docx');
    let pageRule = '@page { size: 595.3pt 841.9pt; margin: 0; }';
    if (section) {
      const w = section.style.width;
      const h = section.style.minHeight || section.style.height;
      if (w && h) pageRule = `@page { size: ${w} ${h}; margin: 0; }`;
    }
    const style = document.createElement('style');
    style.textContent = `
      ${pageRule}
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      @media print {
        section.docx { box-shadow: none !important; margin: 0 !important; }
        .docx-wrapper { background: #fff !important; padding: 0 !important; }
        section.docx img { max-width: none; }
      }
    `;
    document.head.appendChild(style);
  });

  await new Promise(r => setTimeout(r, 200));

  // 切换到打印媒体，截图查看打印布局
  await page.emulateMediaType('print');
  await page.screenshot({ path: outPdf.replace(/\.pdf$/i, '_print_media.png'), fullPage: true });
  console.log('Print media screenshot saved to', outPdf.replace(/\.pdf$/i, '_print_media.png'));

  // 导出 PDF，使用 @page 规则
  await page.pdf({
    path: outPdf,
    preferCSSPageSize: true,
    printBackground: true,
    scale: 1,
  });

  // 同时输出页数信息
  const pdfInfo = await page.evaluate(() => {
    const sections = document.querySelectorAll('section.docx');
    const firstSection = sections[0];
    const firstArticle = firstSection ? firstSection.querySelector('article') : null;
    return {
      sectionCount: sections.length,
      pageRule: ((document.querySelector('style')?.textContent || '').match(/@page\s*\{[^}]+\}/) || [])[0] || '',
      firstSectionH: firstSection ? firstSection.offsetHeight : 0,
      firstArticleH: firstArticle ? firstArticle.offsetHeight : 0,
    };
  });
  console.log('PDF info:', pdfInfo);
  console.log('\nPDF saved to', outPdf);

  // 打开 PDF 截图，查看实际分页
  const pdfUrl = 'file:///' + outPdf.replace(/\\/g, '/');
  const pdfPage = await browser.newPage();
  await pdfPage.goto(pdfUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));
  const pages = await pdfPage.evaluate(() => document.querySelectorAll('.page').length);
  console.log('PDF rendered pages in viewer:', pages);
  const pdfPngBase = outPdf.replace(/\.pdf$/i, '');
  await pdfPage.screenshot({ path: `${pdfPngBase}_viewer.png`, fullPage: true });
  console.log('PDF viewer screenshot saved to', `${pdfPngBase}_viewer.png`);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
