const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const file = process.argv[2] || '10%卡松+货CJ-2-测试模版.docx';
const subdir = process.argv[3] || 'tbl4rkmTWj4CuLgp';
const url = `http://127.0.0.1:5173/templates/_diag/diag.html?file=${encodeURIComponent(file)}&subdir=${encodeURIComponent(subdir)}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE>', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERR>', err.message));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('info')?.textContent || '';
    return t && !t.startsWith('loading...');
  }, { timeout: 30000 }).catch(e => console.log('waitForFunction err:', e.message));

  const report = await page.evaluate(() => {
    const section = document.querySelector('section.docx');
    if (!section) return 'NO SECTION';
    const header = section.querySelector('header');
    if (!header) return 'NO HEADER';

    const out = [];
    function walk(el, depth = 0) {
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hasBorder = parseFloat(cs.borderBottomWidth) > 0 || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0;
      const hasUnderline = cs.textDecorationLine && cs.textDecorationLine !== 'none';
      if (hasBorder || hasUnderline) {
        out.push({
          tag: el.tagName,
          className: el.className,
          text: (el.textContent || '').slice(0, 60).replace(/\s+/g, ' '),
          border: `${cs.borderTopWidth}/${cs.borderRightWidth}/${cs.borderBottomWidth}/${cs.borderLeftWidth}`,
          borderColor: `${cs.borderBottomColor}`,
          textDecoration: cs.textDecorationLine,
          top: rect.top.toFixed(1),
          left: rect.left.toFixed(1),
          width: rect.width.toFixed(1),
          height: rect.height.toFixed(1),
          depth,
        });
      }
      for (const child of el.children) {
        walk(child, depth + 1);
      }
    }
    walk(header);
    return { headerChildren: header.children.length, borderElements: out };
  });

  console.log('=== Header border/underline report ===');
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
