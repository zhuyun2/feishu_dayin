// 服务端 docx → PDF 转换，用于「打印输出与 Word 打开的分页/排版完全一致」。
// 原理：由 LibreOffice（headless）在服务端完成版面计算，浏览器只负责把 PDF 送打印机。
// 依赖：服务端需安装 LibreOffice。
//   macOS：brew install --cask libreoffice
//   Linux：sudo apt install libreoffice 或 dnf install libreoffice
// 路由：
//   POST /api/print/pdf           —— 接收 docx 二进制，返回 application/pdf
//   GET  /api/print/pdf/status    —— 探测 LibreOffice 是否可用（前端诊断用）
// 由 webpack.config.js 的 devServer.setupMiddlewares 挂载。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');

const TMP_BASE = path.join(os.tmpdir(), 'feishuprint-pdf');
// 大文档转换可能较慢，默认 60s 超时，可通过环境变量调大
const CONVERT_TIMEOUT_MS = Number(process.env.PDF_CONVERT_TIMEOUT_MS) || 60000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 探测 LibreOffice 可执行文件（覆盖 macOS / Linux / Windows 常见安装位置，
// 也可通过环境变量 LIBREOFFICE_PATH 显式指定）。找不到返回 null。
function findSoffice() {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice', // macOS
    '/opt/homebrew/bin/soffice',                            // macOS Apple Silicon (brew)
    '/usr/local/bin/soffice',                               // macOS Intel (brew) / Linux
    '/usr/bin/soffice',                                     // Linux (apt/dnf)
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe', // Windows
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) { /* 忽略个别路径不可访问 */ }
  }
  return null;
}

// 转换单个文件。LibreOffice 同一 user profile 不可并发执行，
// 调用方必须经 enqueue 串行化。
function convertDocxToPdf(docxPath, outDir) {
  return new Promise((resolve, reject) => {
    const soffice = findSoffice();
    if (!soffice) {
      return reject(httpError(500, '服务端未安装 LibreOffice，无法转换 PDF。请在 Mac 服务器执行：brew install --cask libreoffice，然后重启服务'));
    }
    execFile(
      soffice,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, docxPath],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        if (err) {
          const timedOut = /ETIMEDOUT|SIGTERM/.test(err.message || '');
          return reject(httpError(500, timedOut
            ? `LibreOffice 转换超时（${CONVERT_TIMEOUT_MS / 1000}s），文档过大或 LibreOffice 未就绪`
            : 'LibreOffice 转换失败：' + (err.message || err)));
        }
        const pdfPath = path.join(outDir, path.basename(docxPath).replace(/\.docx$/i, '.pdf'));
        if (!fs.existsSync(pdfPath)) {
          return reject(httpError(500, 'LibreOffice 执行完成但未生成 PDF 文件'));
        }
        resolve(pdfPath);
      }
    );
  });
}

// 串行队列：LibreOffice 单实例限制，转换任务逐个执行，避免并发锁冲突。
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});
  return run;
}

module.exports = function attach(app) {
  // POST /api/print/pdf —— docx 二进制 → PDF 二进制
  app.post('/api/print/pdf', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: '上传内容为空' });
    }
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return res.status(400).json({ error: '不是有效的 docx 文件（缺少 ZIP 头）' });
    }

    const jobId = crypto.randomBytes(6).toString('hex');
    const jobDir = path.join(TMP_BASE, jobId);
    const docxPath = path.join(jobDir, 'input.docx');
    const cleanup = () => {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    };

    enqueue(async () => {
      try {
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(docxPath, buf);
        const pdfPath = await convertDocxToPdf(docxPath, jobDir);
        const pdf = fs.readFileSync(pdfPath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="print.pdf"');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(pdf);
      } catch (e) {
        const status = e.status || 500;
        if (!res.headersSent) res.status(status).json({ error: e.message || 'PDF 转换失败' });
      } finally {
        cleanup();
      }
    });
  });

  // GET /api/print/pdf/status —— 探测 LibreOffice 是否可用（前端诊断）
  app.get('/api/print/pdf/status', (req, res) => {
    const soffice = findSoffice();
    res.status(200).json({ available: !!soffice, soffice: soffice || null });
  });
};
