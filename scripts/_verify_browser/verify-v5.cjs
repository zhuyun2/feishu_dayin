// Verify the v5 fallback fix with real Edge: dump measurements + screenshot header region
// Run: node scripts/_verify_browser/verify-v5.cjs [file] [outPng]
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '../..');
const file = process.argv[2] || '10%卡松+货CJ-2-测试模版.docx';
const outPng = process.argv[3] || path.join(__dirname, 'v5-fallback-check.png');
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
  }, { timeout: 30000 }).catch(e => console.log('waitForFunction err:', e.message));
  await new Promise(r => setTimeout(r, 300));

  const text = await page.$eval('#info', el => el.textContent).catch(e => 'NO INFO: ' + e.message);
  console.log('=== INFO ===');
  console.log(text);

  // Screenshot: full page so the section is always captured regardless of scroll
  await page.screenshot({ path: outPng, fullPage: true });
  console.log('\nFull-page screenshot saved to', outPng);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
