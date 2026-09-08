const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const file = process.argv[2] || '10%卡松+货CJ-2-测试模版.docx';
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

  const report = await page.evaluate(() => window.__borderReport);
  console.log('=== Border/underline elements in section after fallback ===');
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
