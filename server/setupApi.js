'use strict';
/**
 * ============================================================
 * 固定域名部署的 HTTP 接口 +「一键部署」页面
 * ============================================================
 * 逻辑在 server/namedTunnelCore.js（隧道/凭据/自启）与 server/setupCore.js（编排），
 * 本文件只是薄薄一层 HTTP，**与命令行共用同一份实现**，避免两边行为不一致。
 *
 * 接口：
 *   GET  /api/setup/status            整体状态（域名/隧道/凭据/自启/本地服务）
 *   POST /api/setup/deploy            一键部署（幂等，已在跑就直接复用）
 *   POST /api/setup/stop              停隧道（不动 dev server）
 *   POST /api/setup/autostart         { enabled: true|false } 开/关开机自启
 *   GET  /deploy                      本机部署页（隧道挂了也能在本机打开）
 *
 * 为什么按钮在这里、而不放进飞书插件侧边栏：
 *   隧道一断，飞书里根本打不开插件，插件内的按钮也就点不到。
 *   所以真正可靠的入口是「本机浏览器打开 /deploy」或「双击 deploy.bat」。
 * ============================================================
 */

const express = require('express');
const named = require('./namedTunnelCore');
const setup = require('./setupCore');

// 同一时间只允许一个部署在跑（点两下不会起两条隧道）
let deployInFlight = null;

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
  .wrap { max-width: 760px; margin: 40px auto; padding: 0 16px; }
  .card { background:#fff; border:1px solid #e5e6eb; border-radius:12px; padding:20px 22px; margin-bottom:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:14px; margin:0 0 10px; color:#1f2329; font-weight:600; }
  .sub { color:#8f959e; font-size:12px; margin-bottom:18px; }
  .row { display:flex; align-items:center; gap:10px; margin:8px 0; font-size:13px; }
  .k { color:#8f959e; width:96px; flex:0 0 auto; }
  .dot { width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#c9cdd4; }
  .dot.ok { background:#34c724; } .dot.warn { background:#ff8800; } .dot.err { background:#f53f3f; }
  code.url { display:block; word-break:break-all; background:#f5f6f7; border:1px solid #e5e6eb; border-radius:8px; padding:12px; font-family: ui-monospace, Consolas, monospace; font-size:14px; font-weight:600; color:#185FA5; }
  .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  button { font:inherit; padding:8px 18px; border-radius:8px; border:1px solid #e5e6eb; background:#fff; cursor:pointer; }
  button.primary { background:#3370FF; border-color:#3370FF; color:#fff; font-weight:600; }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .msg { margin-top:14px; font-size:13px; white-space:pre-wrap; font-family: ui-monospace, Consolas, monospace; max-height:260px; overflow:auto; }
  .msg.ok { color:#0f8b2e; } .msg.warn { color:#b45a00; } .msg.err { color:#c4262e; }
  .tip { font-size:12px; color:#8f959e; margin-top:8px; }
  .legacy { border-top:1px solid #e5e6eb; margin-top:18px; padding-top:14px; }
  .legacy summary { cursor:pointer; font-size:13px; color:#646a73; }
  .pill { display:inline-block; font-size:11px; padding:1px 7px; border-radius:10px; background:#e8f3ff; color:#185FA5; margin-left:6px; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>飞书打印插件 · 一键部署</h1>
    <div class="sub">
      固定域名隧道：域名永久不变，换电脑、重启都不需要改飞书插件配置。<br />
      等价的命令行入口：双击项目根目录的「一键部署.bat」。<span class="pill">推荐</span>
    </div>

    <div class="row"><span class="dot" id="dot"></span><span id="headline">正在读取状态…</span></div>

    <code class="url" id="url">—</code>
    <div class="tip">把这个地址填进飞书多维表格插件的「插件地址」。</div>

    <div style="margin-top:16px">
      <div class="row"><span class="k">本地服务</span><span class="dot" id="d-local"></span><span id="t-local">—</span></div>
      <div class="row"><span class="k">隧道进程</span><span class="dot" id="d-tunnel"></span><span id="t-tunnel">—</span></div>
      <div class="row"><span class="k">隧道凭据</span><span class="dot" id="d-cred"></span><span id="t-cred">—</span></div>
      <div class="row"><span class="k">开机自启</span><span class="dot" id="d-auto"></span><span id="t-auto">—</span></div>
    </div>

    <div class="btns">
      <button class="primary" id="deployBtn">一键部署</button>
      <button id="copyBtn">复制域名</button>
      <button id="openBtn">打开插件地址</button>
      <button id="autoBtn">切换开机自启</button>
      <button id="stopBtn">停止隧道</button>
    </div>

    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <details class="legacy">
      <summary>旧的临时隧道（*.trycloudflare.com，地址会变，仅备用）</summary>
      <div id="legacyBox" style="margin-top:12px">
        <div class="row"><span class="k">当前地址</span><code id="legacyUrl" style="font-size:12px">—</code></div>
        <div class="row"><span class="k">状态</span><span id="legacyState">—</span></div>
        <div class="btns">
          <button id="legacyDeployBtn">临时隧道一键部署</button>
          <button id="legacyForceBtn">强制换新地址</button>
        </div>
        <div class="tip">临时隧道的域名由 Cloudflare 随机分配，客户端无法指定；只要不重启 cloudflared 进程地址就不会变。</div>
      </div>
    </details>
  </div>

</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = {};
  var busy = false;

  function setMsg(text, kind) {
    $('msg').textContent = text || '';
    $('msg').className = 'msg ' + (kind || '');
  }
  function dot(el, kind) { el.className = 'dot' + (kind ? ' ' + kind : ''); }
  function setBusy(b) {
    busy = b;
    ['deployBtn', 'stopBtn', 'autoBtn', 'legacyDeployBtn', 'legacyForceBtn'].forEach(function (id) {
      $(id).disabled = b;
    });
  }

  function refresh() {
    return fetch('/api/setup/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        state = st || {};
        var cf = st.cloudflared || {};
        $('url').textContent = st.fixedUrl || '—';

        if (st.fixedUrlHealthy && st.devServerUp) {
          dot($('dot'), 'ok');
          $('headline').textContent = '部署正常 —— 固定域名可用，飞书插件可以直接用';
        } else if (cf.running) {
          dot($('dot'), 'warn');
          $('headline').textContent = '隧道进程在跑，但域名还没通；点一次一键部署即可修复';
        } else {
          dot($('dot'), 'err');
          $('headline').textContent = '隧道没在跑；点一次一键部署即可恢复';
        }

        dot($('d-local'), st.devServerUp ? 'ok' : 'err');
        $('t-local').textContent = (st.localOrigin || '') + (st.devServerUp ? ' 正常' : ' 未响应');

        dot($('d-tunnel'), cf.ready ? 'ok' : cf.running ? 'warn' : 'err');
        $('t-tunnel').textContent = cf.running
          ? ('PID ' + (cf.pids || []).join(', ') + '　/ready=' + (cf.readyStatus == null ? '—' : cf.readyStatus))
          : '未运行';

        var cred = st.credentials || {};
        dot($('d-cred'), cred.bundled && cred.installed ? 'ok' : 'warn');
        $('t-cred').textContent = '项目内=' + (cred.bundled ? '有' : '缺') + '　已安装=' + (cred.installed ? '有' : '缺');

        var auto = st.autostart || {};
        dot($('d-auto'), auto.enabled ? 'ok' : 'warn');
        $('t-auto').textContent = auto.enabled ? '已开启' : '未开启';

        $('autoBtn').textContent = auto.enabled ? '关闭开机自启' : '开启开机自启';
      })
      .catch(function (e) {
        dot($('dot'), 'err');
        $('headline').textContent = '无法连接本地服务：' + e.message;
      });
  }

  function refreshLegacy() {
    return fetch('/api/tunnel/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        $('legacyUrl').textContent = st.url || '（未部署）';
        $('legacyState').textContent = st.url && st.urlHealthy ? '可用' : (st.cloudflared && st.cloudflared.running ? '进程在，地址不可用' : '未运行');
      })
      .catch(function () { $('legacyState').textContent = '读取失败'; });
  }

  function post(url, body, waitingText) {
    setBusy(true);
    if (waitingText) setMsg(waitingText, 'warn');
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) { setMsg((r.message || '失败') + (r.log ? '\\n' + r.log : ''), 'err'); return; }
        setMsg((r.log || r.message || '完成') + (r.fixedUrl ? '\\n\\n固定域名：' + r.fixedUrl : ''), 'ok');
        return refresh().then(refreshLegacy);
      })
      .catch(function (e) { setMsg('请求失败：' + e.message, 'err'); })
      ['finally'](function () { setBusy(false); });
  }

  $('deployBtn').onclick = function () {
    post('/api/setup/deploy', {}, '正在部署：检查依赖 → 安装凭据 → 拉起本地服务与隧道…（首次可能需要 1-3 分钟）');
  };
  $('stopBtn').onclick = function () { post('/api/setup/stop', {}, '正在停止隧道…'); };
  $('autoBtn').onclick = function () {
    var on = !((state.autostart || {}).enabled);
    post('/api/setup/autostart', { enabled: on }, on ? '正在开启开机自启…' : '正在关闭开机自启…');
  };
  $('copyBtn').onclick = function () {
    var u = state.fixedUrl || '';
    if (!u) { setMsg('还没有域名可复制', 'warn'); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject())
      .then(function () { setMsg('已复制：' + u, 'ok'); })
      .catch(function () { setMsg('复制失败，请手动选中上面的域名复制', 'warn'); });
  };
  $('openBtn').onclick = function () { if (state.fixedUrl) window.open(state.fixedUrl, '_blank'); };
  $('legacyDeployBtn').onclick = function () {
    setBusy(true); setMsg('正在部署临时隧道…', 'warn');
    fetch('/api/tunnel/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (r) { setMsg((r.message || r.error || '完成') + (r.url ? '\\n地址：' + r.url : ''), r.ok ? 'ok' : 'err'); return refreshLegacy(); })
      .catch(function (e) { setMsg('失败：' + e.message, 'err'); })
      ['finally'](function () { setBusy(false); });
  };
  $('legacyForceBtn').onclick = function () {
    setBusy(true); setMsg('正在强制生成新的临时地址…', 'warn');
    fetch('/api/tunnel/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' })
      .then(function (r) { return r.json(); })
      .then(function (r) { setMsg((r.message || r.error || '完成') + (r.url ? '\\n地址：' + r.url : ''), r.ok ? 'ok' : 'err'); return refreshLegacy(); })
      .catch(function (e) { setMsg('失败：' + e.message, 'err'); })
      ['finally'](function () { setBusy(false); });
  };

  refresh().then(refreshLegacy);
})();
</script>
</body>
</html>`;
}

module.exports = function attachSetupApi(app, options) {
  const opts = options || {};

  // 本机部署页永远服务于「这台机器当前在用的那个域名」。
  // 页面上刻意不做「切换域名」：隧道已经断的时候，切换还得刷新页面重来，
  // 反而是个容易点错的坑。换域名走命令行 `deploy.bat --profile <标识>`。
  const activeCfg = () => named.loadConfig(named.readActiveProfile() || named.DEFAULT_PROFILE);

  app.use('/api/setup', (req, res, next) => {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/setup/status', async (req, res) => {
    cors(res);
    try {
      res.status(200).json(await named.status(activeCfg()));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 本机配了哪些域名 —— 部署页用它显示「本机共 N 个域名」的提示
  app.get('/api/setup/profiles', (req, res) => {
    cors(res);
    try {
      res.status(200).json({
        ok: true,
        active: named.readActiveProfile() || named.DEFAULT_PROFILE,
        profiles: named.listProfiles(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/setup/deploy', express.json(), async (req, res) => {
    cors(res);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (deployInFlight) {
      res.status(409).json({ ok: false, message: '已有一次部署正在进行，请稍候…' });
      return;
    }
    const lines = [];
    const log = {
      say: (m) => lines.push(String(m == null ? '' : m)),
      step: (m) => lines.push('  · ' + m),
      ok: (m) => lines.push('  ✓ ' + m),
      warn: (m) => lines.push('  ! ' + m),
      section: (m) => lines.push(String(m)),
    };
    // dev server 已经在跑，说明本地服务没问题；这里只做隧道侧的动作
    const runOpts = {
      // 显式锁死域名：silent 模式本来就不会弹菜单，但写明了更不容易将来被改坏
      profile: named.readActiveProfile() || named.DEFAULT_PROFILE,
      download: body.download !== false,
      autostart: body.autostart !== false,
      force: body.force === true,
      silent: true,
      json: false,
    };
    deployInFlight = (async () => {
      try {
        return await setup.cmdDeploy(runOpts, log);
      } finally {
        deployInFlight = null;
      }
    })();
    try {
      const result = await deployInFlight;
      res.status(200).json(Object.assign({ log: lines.join('\n') }, result));
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.code || 'DEPLOY_FAILED',
        message: e.message + (e.detail ? '\n' + e.detail : ''),
        log: lines.join('\n'),
      });
    }
  });

  app.post('/api/setup/stop', (req, res) => {
    cors(res);
    try {
      const cfg = activeCfg();
      const r = named.stopNamedTunnel(cfg);
      res.status(200).json(Object.assign({ ok: true, profile: cfg.profile, fixedUrl: cfg.fixedUrl }, r));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/setup/autostart', express.json(), (req, res) => {
    cors(res);
    try {
      const cfg = activeCfg();
      const want = !!(req.body && req.body.enabled);
      const st = want ? named.autostartEnable(cfg) : named.autostartDisable(cfg);
      res.status(200).json({ ok: true, enabled: !!st.enabled, file: st.file, profile: cfg.profile });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 本机部署页：隧道挂了、飞书插件打不开时，在本机浏览器打开它
  app.get(['/deploy', '/deploy.html'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(deployPageHtml());
  });

  return { ok: true, port: opts.port };
};
