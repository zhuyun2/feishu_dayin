'use strict';
/**
 * ============================================================
 * 内网穿透 HTTP 接口（挂到 dev server 的 express 实例上）
 * ============================================================
 * 真正的逻辑在 server/tunnelCore.js —— 同一份实现同时被：
 *   - 本文件（/api/tunnel/* 与本地 /deploy 页面）
 *   - 仓库根的 tunnel.js /「一键部署.bat」（命令行，不依赖 dev server）
 * 复用，避免两处实现不一致。
 *
 * 接口：
 *   GET  /api/tunnel/probe     存活探针（返回 instanceId，用于判断某公网地址是否回连本机）
 *   GET  /api/tunnel/status    隧道/地址/进程状态
 *   POST /api/tunnel/deploy    一键部署（复用优先，{"force":true} 强制换新地址）
 *   GET  /api/tunnel/last-url  只读上一次的地址
 *   POST /api/tunnel/stop      停止隧道（只停属于本项目端口的那个 cloudflared）
 *   GET  /deploy               本地部署页（隧道挂了、飞书插件打不开时在本机浏览器操作）
 *
 * 命令行的等价物（推荐，断网时也能用）：双击「一键部署.bat」或 `node tunnel.js deploy`
 * ============================================================
 */

const express = require('express');
const core = require('./tunnelCore');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function deployPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>飞书打印插件 · 一键部署</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background:#f5f6f7; color:#1f2329; }
  .wrap { max-width: 720px; margin: 48px auto; padding: 0 16px; }
  .card { background:#fff; border:1px solid #e5e6eb; border-radius:12px; padding:20px 22px; margin-bottom:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8f959e; font-size:12px; margin-bottom:18px; }
  .row { display:flex; align-items:center; gap:10px; margin:10px 0; }
  .dot { width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#c9cdd4; }
  .dot.ok { background:#34c724; } .dot.warn { background:#ff8800; } .dot.err { background:#f53f3f; }
  code.url { display:block; word-break:break-all; background:#f5f6f7; border:1px solid #e5e6eb; border-radius:8px; padding:10px 12px; font-family: ui-monospace, Consolas, monospace; font-size:13px; }
  .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  button { font:inherit; padding:8px 18px; border-radius:8px; border:1px solid #e5e6eb; background:#fff; cursor:pointer; }
  button.primary { background:#3370FF; border-color:#3370FF; color:#fff; font-weight:600; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .msg { margin-top:14px; font-size:13px; white-space:pre-wrap; }
  .msg.ok { color:#0f8b2e; } .msg.warn { color:#b45a00; } .msg.err { color:#c4262e; }
  .kv { color:#8f959e; font-size:12px; }
  .tip { font-size:12px; color:#8f959e; margin-top:6px; }
  label.force { font-size:12px; color:#4e5969; display:flex; gap:6px; align-items:center; margin-top:12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>飞书打印插件 · 一键部署</h1>
    <div class="sub">网络恢复后点一次即可。能复用上一次的地址就绝不换地址。<br />等价命令行：双击项目根目录的「一键部署.bat」。</div>

    <div class="row"><span class="dot" id="statusDot"></span><span id="statusText">正在读取状态…</span></div>
    <code class="url" id="url">—</code>
    <div class="tip">把上面的地址填进飞书多维表格插件的「插件地址」即可。</div>

    <div class="btns">
      <button class="primary" id="deployBtn">一键部署</button>
      <button id="copyBtn">复制地址</button>
      <button id="forceBtn">强制换新地址</button>
      <button id="openBtn">打开本地服务</button>
    </div>
    <label class="force"><input type="checkbox" id="forceChk" /> 部署时强制重新生成（不使用上一次的地址）</label>

    <div class="msg" id="msg"></div>
    <div class="kv" id="kv"></div>
  </div>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var currentUrl = '';
  var pagePort = location.port || '5173';

  function setMsg(text, kind) {
    $('msg').textContent = text || '';
    $('msg').className = 'msg ' + (kind || '');
  }

  function render(st) {
    var dot = $('statusDot');
    var cf = st.cloudflared || {};
    dot.className = 'dot';
    if (st.url && st.urlHealthy) {
      dot.className = 'dot ok';
      $('statusText').textContent = '内网穿透正常 —— 一键部署会复用当前地址，不会更换';
    } else if (cf.running) {
      dot.className = 'dot warn';
      $('statusText').textContent = st.hint || '隧道进程在，但地址已不可用';
    } else if (!cf.found) {
      dot.className = 'dot err';
      $('statusText').textContent = '未检测到 cloudflared，请先安装';
    } else {
      dot.className = 'dot err';
      $('statusText').textContent = st.hint || '隧道未运行';
    }
    if (st.port) pagePort = st.port;
    currentUrl = st.url || '';
    $('url').textContent = currentUrl || '—';
    $('kv').textContent = '本地端口 ' + pagePort + '　·　cloudflared ' +
      (cf.found ? '已安装' : '未安装') + (cf.path ? '（' + cf.path + '）' : '') +
      (st.tunnelUpdatedAt ? '　·　上次更新 ' + new Date(st.tunnelUpdatedAt).toLocaleString() : '');
  }

  function fetchStatus() {
    return fetch('/api/tunnel/status', { cache: 'no-store' }).then(function (r) { return r.json(); });
  }

  function refresh() {
    fetchStatus().then(render).catch(function (e) { setMsg('无法连接本地服务：' + e.message, 'err'); });
  }

  function deploy(force) {
    $('deployBtn').disabled = true;
    $('forceBtn').disabled = true;
    setMsg(force ? '正在重新生成地址…' : '正在部署，优先复用上一次的地址…', 'warn');
    fetch('/api/tunnel/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { setMsg(r.message || r.error || '部署失败', 'err'); return; }
        var kind = r.reused ? 'ok' : (r.changed ? 'warn' : 'ok');
        setMsg((r.message || '部署完成') + '\\n地址：' + r.url +
          (r.ready === false ? '\\n（地址刚生成，可能还要几秒才可访问）' : ''), kind);
        currentUrl = r.url || '';
        $('url').textContent = currentUrl || '—';
        refresh();
      })
      .catch(function (e) { setMsg('部署失败：' + e.message, 'err'); })
      ['finally'](function () { $('deployBtn').disabled = false; $('forceBtn').disabled = false; });
  }

  $('deployBtn').onclick = function () { deploy($('forceChk').checked); };
  $('forceBtn').onclick = function () { deploy(true); };
  $('copyBtn').onclick = function () {
    if (!currentUrl) { setMsg('还没有地址可复制', 'warn'); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(currentUrl) : Promise.reject())
      .then(function () { setMsg('已复制：' + currentUrl, 'ok'); })
      .catch(function () { setMsg('复制失败，请手动选中上面的地址复制', 'warn'); });
  };
  $('openBtn').onclick = function () { window.open('http://localhost:' + pagePort, '_blank'); };

  fetchStatus().then(render).catch(function () { render({ port: 0, cloudflared: {} }); });
})();
</script>
</body>
</html>`;
}

module.exports = function attachTunnelApi(app, options) {
  const opts = options || {};
  const defaultPort = core.normalizePort(opts.port || process.env.PORT || core.PRIMARY_PORT);
  const portOf = (req) => {
    const host = String(req.headers.host || '');
    const m = host.match(/:(\d+)$/);
    return m ? Number(m[1]) : defaultPort;
  };

  core.instanceId();

  // 统一加 CORS 并处理预检请求。
  // 注意：dev server 内置的是 Express 5，路径通配符写法与 Express 4 不同
  // （Express 5 里 '/api/tunnel/*' 会直接抛 PathError），所以这里用无通配符的
  // 挂载路径，两个大版本都兼容。
  app.use('/api/tunnel', (req, res, next) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // 存活探针：用来判断某个公网地址是否真的回连到了本机这套服务
  app.get(core.PROBE_PATH, (req, res) => {
    cors(res);
    res.status(200).json({
      ok: true,
      project: 'feishu-dayin',
      instanceId: core.instanceId(),
      port: Number(portOf(req)),
      ts: new Date().toISOString(),
    });
  });

  app.get('/api/tunnel/status', async (req, res) => {
    cors(res);
    try {
      res.status(200).json(await core.status({ port: portOf(req) }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 一键部署：复用优先，失效才重新生成
  app.post('/api/tunnel/deploy', express.json(), (req, res) => {
    cors(res);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const force = body.force === true || req.query.force === '1';
    const port = portOf(req);
    // dev server 在跑，说明服务肯定是活的，不必再探
    core
      .deploy({ port, force, ensureServer: false })
      .then((r) => res.status(200).json(r))
      .catch((e) => {
        res.status(500).json(
          core.emptyResult({
            port,
            error: e.code || 'DEPLOY_FAILED',
            message: e.message + (e.detail ? '\n' + e.detail : ''),
          }),
        );
      });
  });

  // 只看不动：读取上一次保存的地址
  app.get('/api/tunnel/last-url', (req, res) => {
    cors(res);
    const st = core.loadState(portOf(req));
    res.status(200).json({ ok: true, url: st.url, createdAt: st.createdAt, updatedAt: st.updatedAt });
  });

  // 停止隧道（只停属于本项目端口的那个 cloudflared，不碰别的工具）
  app.post('/api/tunnel/stop', (req, res) => {
    cors(res);
    try {
      res.status(200).json(core.stop({ port: portOf(req) }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 本地部署页：隧道挂了、飞书插件打不开时，直接在服务器上开这个页面点部署
  app.get(['/deploy', '/deploy.html'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(deployPageHtml());
  });

  return { port: defaultPort };
};
