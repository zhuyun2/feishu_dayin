const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const file = process.argv[2] || '巴德士专用_K103S(有谱图).docx';
const subdir = process.argv[3] || 'tbl4rkmTWj4CuLgp';
const url = `http://127.0.0.1:5173/templates/_diag/render-fallback.html?file=${encodeURIComponent(file)}&subdir=${encodeURIComponent(subdir)}`;

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

  const css = await page.evaluate(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.selectorText && rule.selectorText.includes('docx_a7')) {
            out.push(`${rule.selectorText} { ${rule.style.cssText} }`);
          }
        }
      } catch (e) {}
    }
    return out;
  });
  console.log('=== .docx_a7 CSS rules ===');
  console.log(css.join('\n'));

  const pInfo = await page.evaluate(() => {
    const sections = document.querySelectorAll('section.docx');
    const out = [];
    for (let si = 0; si < sections.length; si++) {
      const ps = sections[si].querySelectorAll('header p, header div');
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const cs = window.getComputedStyle(p);
        out.push({
          section: si,
          tag: p.tagName,
          className: p.className,
          text: JSON.stringify(p.textContent),
          borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomStyle + ' ' + cs.borderBottomColor,
          borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
          marginBottom: cs.marginBottom,
          paddingBottom: cs.paddingBottom,
          width: p.getBoundingClientRect().width.toFixed(1),
          height: p.getBoundingClientRect().height.toFixed(1),
        });
      }
    }
    return out;
  });
  console.log('\n=== Header paragraphs/divs ===');
  console.log(JSON.stringify(pInfo, null, 2));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
