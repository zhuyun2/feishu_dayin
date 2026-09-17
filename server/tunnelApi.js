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
 *
 * 注意：本地部署页 /deploy 已移交 server/setupApi.js（以固定域名为主，
 * 本文件的临时隧道作为页面里的「备用区」）。
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

  // 本地部署页 /deploy 已由 server/setupApi.js 接管
  // （那页以「固定域名」为主，本文件的 /api/tunnel/* 作为临时隧道备用区嵌在里面）。
  // 这里不再注册 /deploy，避免两个 handler 抢同一个路由。

  return { port: defaultPort };
};
