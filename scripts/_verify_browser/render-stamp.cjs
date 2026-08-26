// 渲染盖章后的 docx，截图验证印章可见。
// 依赖 dev server（5173）与已复制到 templates 目录的盖章文件。
// Run: node scripts/_verify_browser/render-stamp.cjs
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const file = process.argv[2] || '_stamped-test-柏舒逸 Bersulli.docx';
const outPng = process.argv[3] || path.join(__dirname, 'stamp-render.png');
const url = `http://127.0.0.1:5173/scripts/_verify_browser/render-stamp.html?file=${encodeURIComponent(file)}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1400 });
  page.on('console', (msg) => console.log('PAGE>', msg.text()));
  page.on('pageerror', (err) => console.log('PAGE ERR>', err.message));
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  try {
    await page.waitForFunction(() => document.body.dataset.done === '1', { timeout: 30000 });
  } catch (e) {
    console.log('wait failed, continue');
  }
  await new Promise((r) => setTimeout(r, 500));
  const info = await page.$eval('#info', (el) => el.textContent);
  console.log('INFO:\n' + info);
  // 截取整个渲染区
  const el = await page.$('.container');
  if (el) await el.screenshot({ path: outPng });
  await browser.close();
  console.log('screenshot ->', outPng);
})();
