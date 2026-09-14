'use strict';
/**
 * ============================================================
 * 内网穿透核心逻辑（dev server 与命令行工具共用同一份实现）
 * ============================================================
 * 使用方：
 *   - server/tunnelApi.js  -> 挂到 dev server 上，提供 /api/tunnel/* 与本地 /deploy 页面
 *   - tunnel.js（仓库根）  -> 命令行 / 双击「一键部署.bat」，**不依赖 dev server**
 *
 * 先说清楚一条硬事实（决定了本模块的全部设计）：
 *   cloudflared 的「临时隧道 quick tunnel」域名由 Cloudflare 边缘**随机分配**，
 *   客户端没有任何办法指定或要求复用某个域名。
 *   但它的域名在**整个 cloudflared 进程存活期间保持不变**（断网重连也不变，
 *   只要进程不被杀掉）。Cloudflare 只会在隧道断连超过约 5 分钟后回收域名。
 *
 *   所以「取上一次生成的内网穿透地址」的正确做法不是去"指定域名"，而是：
 *     1. 先探测上一次的地址是否仍然可用（进程活着 + 该地址能回连到本机）；
 *     2. 可用 -> 直接复用，绝不重启 cloudflared（地址保持原样）；
 *     3. 只有确认失效（进程退出 / 域名被回收）才重新生成，并持久化新地址。
 *
 *   若需要「重启电脑、断网很久之后地址也永远不变」，必须用
 *   cloudflared 命名隧道 + 自有域名，见 README「固定地址」一节。
 *
 * 多实例隔离：状态/日志/pid 文件按端口区分，默认端口 5173 沿用旧文件名，
 * 其他端口加 -<port> 后缀，避免并行测试时互相覆盖地址。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN_DIR = path.join(ROOT, '.run');
const PRIMARY_PORT = 5173;

// cloudflared 的 --metrics 端口：默认端口沿用 20289（与已运行的隧道进程保持一致），
// 其他端口按偏移派生，避免并行实例抢同一个端口。
const BASE_METRICS_PORT = 20289;

const URL_RE = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
const PROBE_PATH = '/api/tunnel/probe';

/* ------------------------------------------------------------ 路径与端口工具 */

function normalizePort(port) {
  const n = Number(port);
  return Number.isFinite(n) && n > 0 ? n : PRIMARY_PORT;
}

function pathsFor(port) {
  const p = normalizePort(port);
  const primary = p === PRIMARY_PORT;
  const suffix = primary ? '' : '-' + p;
  return {
    port: p,
    primary,
    stateFile: path.join(RUN_DIR, 'tunnel' + suffix + '.json'),
    // 兼容早期脚本写下的 tunnel-url.txt（只有默认端口写这个固定名字）
    urlFile: primary ? path.join(ROOT, 'tunnel-url.txt') : path.join(RUN_DIR, 'tunnel-url-' + p + '.txt'),
    logFile: path.join(RUN_DIR, 'tunnel' + suffix + '.log'),
    errFile: path.join(RUN_DIR, 'tunnel' + suffix + '.err.log'),
    pidFile: path.join(RUN_DIR, 'cloudflared' + suffix + '.pid'),
    serverLog: path.join(RUN_DIR, 'server' + suffix + '.log'),
    metricsPort: BASE_METRICS_PORT + (p - PRIMARY_PORT),
    localOrigin: 'http://127.0.0.1:' + p,
    deployPage: 'http://localhost:' + p + '/deploy',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureRunDir() {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function writeText(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) {
    /* ignore */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// 让每个项目目录有一枚稳定 ID：用来确认「某个公网地址确实回连到了本机这套服务」，
// 避免复用一个属于别人/别的项目的域名。
function instanceId() {
  ensureRunDir();
  const INSTANCE_FILE = path.join(RUN_DIR, 'instance-id.txt');
  let id = readText(INSTANCE_FILE).trim();
  if (!id) {
    id = crypto.randomBytes(8).toString('hex');
    writeText(INSTANCE_FILE, id);
  }
  return id;
}

/* ------------------------------------------------------------------ 状态文件 */

function loadState(port) {
  const P = pathsFor(port);
  const st = readJson(P.stateFile, null) || {};
  const state = {
    url: typeof st.url === 'string' ? st.url : '',
    pid: Number.isInteger(st.pid) ? st.pid : 0,
    createdAt: st.createdAt || null,
    updatedAt: st.updatedAt || null,
    source: st.source || '',
  };
  // 兼容早期脚本写下的 tunnel-url.txt
  if (!state.url) {
    const legacy = readText(P.urlFile).trim();
    const m = legacy.match(URL_RE);
    if (m) {
      state.url = m[0];
      state.source = state.source || 'url-file';
    }
  }
  return state;
}

function saveState(port, patch) {
  const P = pathsFor(port);
  ensureRunDir();
  const next = Object.assign(loadState(port), patch, { updatedAt: new Date().toISOString() });
  if (!next.createdAt) next.createdAt = next.updatedAt;
  writeText(P.stateFile, JSON.stringify(next, null, 2));
  // 同步写人类可读的地址文件，兼容既有脚本 / README 用法
  if (next.url) writeText(P.urlFile, next.url + '\n');
  return next;
}

function clearStateUrl(port, reason) {
  const P = pathsFor(port);
  ensureRunDir();
  const next = Object.assign(loadState(port), {
    url: '',
    pid: 0,
    source: reason || 'invalidated',
    updatedAt: new Date().toISOString(),
  });
  writeText(P.stateFile, JSON.stringify(next, null, 2));
  writeText(P.urlFile, '');
  return next;
}

/**
 * 状态文件丢了也不要白白换掉地址：从上次的隧道日志里把地址捞回来。
 * （日志里会有 "Your quick Tunnel has been created! Visit it at ..." 之类的行）
 */
function lastUrlFromLogs(port) {
  const P = pathsFor(port);
  let last = '';
  for (const file of [P.logFile, P.errFile]) {
    const text = readText(file);
    if (!text) continue;
    const matches = text.match(URL_RE);
    if (matches && matches.length) last = matches[matches.length - 1];
  }
  return last;
}

/* ---------------------------------------------------------------- 二进制定位 */

function shallowFind(dir, filename, depth) {
  if (depth <= 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === filename.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = shallowFind(path.join(dir, e.name), filename, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function findCloudflared() {
  const override = process.env.CLOUDFLARED_PATH;
  if (override && fs.existsSync(override)) return override;

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [];

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const roaming = process.env.APPDATA || '';
    candidates.push(
      path.join(local, 'Microsoft', 'WinGet', 'Links', exe),
      path.join(roaming, 'npm', exe),
      'C:\\Program Files\\cloudflared\\' + exe,
      'C:\\Program Files (x86)\\cloudflared\\' + exe,
    );
  } else {
    candidates.push('/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe, '/usr/bin/' + exe, '/opt/local/bin/' + exe);
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) {
      /* ignore */
    }
  }

  // winget 包目录：<localappdata>\Microsoft\WinGet\Packages\Cloudflare.cloudflared_*\cloudflared.exe
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const pkgs = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    let dirs = [];
    try {
      dirs = fs.readdirSync(pkgs);
    } catch (e) {
      dirs = [];
    }
    for (const d of dirs) {
      if (!/cloudflared/i.test(d)) continue;
      const hit = shallowFind(path.join(pkgs, d), exe, 3);
      if (hit) return hit;
    }
  }
  return null;
}

/* ------------------------------------------------------------ 进程发现与终止 */

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// 列出 cloudflared 进程（含命令行，便于只挑出「服务本项目端口的那一个」）
function listCloudflared() {
  const out = [];
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: 'utf8', timeout: 20000, windowsHide: true },
      ).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of arr) out.push({ pid: Number(p.ProcessId), cmd: String(p.CommandLine || '') });
      }
    } else {
      const raw = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 20000 });
      for (const line of raw.split('\n')) {
        if (!line.includes('cloudflared')) continue;
        if (line.includes('cloudflared-pm') || /ps -eo/.test(line)) continue;
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
      }
    }
  } catch (e) {
    /* 拿不到进程列表时退化为「只信任状态文件里的 PID」 */
  }
  return out.filter((p) => p.pid && p.pid !== process.pid);
}

// 只锁定向本项目端口的那个 cloudflared，避免误杀别的工具（例如 QClaw）的隧道
function findOurTunnelPids(port) {
  const p = normalizePort(port);
  const all = listCloudflared();
  const needleA = 'localhost:' + p;
  const needleB = '127.0.0.1:' + p;
  const mine = all.filter((pr) => pr.cmd.includes(needleA) || pr.cmd.includes(needleB)).map((pr) => pr.pid);

  const state = loadState(p);
  if (state.pid && isAlive(state.pid) && !mine.includes(state.pid)) {
    const rec = all.find((pr) => pr.pid === state.pid);
    // 状态文件里记的 PID 仍然活着，就认它（可能是命令行读取失败）
    if (!rec || !rec.cmd || rec.cmd.includes('cloudflared')) mine.push(state.pid);
  }
  // 兜底：整机只有一个 cloudflared 时，认定就是我们的
  if (!mine.length && all.length === 1 && !all[0].cmd) mine.push(all[0].pid);
  return { pids: [...new Set(mine)], all };
}

function killPids(pids) {
  let killed = 0;
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000, windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed += 1;
    } catch (e) {
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch (e2) {
        /* ignore */
      }
    }
  }
  return killed;
}

/* ------------------------------------------------------------------ 网络探测 */

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const lib = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: true }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 16384) req.destroy();
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (e) {
            /* 非 JSON */
          }
          done({ status: res.statusCode, json });
        });
      });
    } catch (e) {
      done(null);
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
  });
}

// 探测某个公网地址是否回连到「本机这一套服务」：靠 instanceId 校验，避免误用别人的域名
async function probePublicUrl(baseUrl, timeoutMs) {
  if (!baseUrl) return null;
  const res = await httpGetJson(baseUrl.replace(/\/+$/, '') + PROBE_PATH, timeoutMs);
  if (!res || res.status !== 200 || !res.json || res.json.instanceId !== instanceId()) return null;
  return res.json;
}

/**
 * 复用判定专用：**多试几次**再下结论。
 * 单次探测很脆弱 —— 本地服务刚重启、隧道正在重连、边缘短暂抖动，都会让一次探测失败。
 * 如果据此就换地址，用户就得改飞书插件配置，代价远比多等十几秒大。
 */
async function probeForReuse(url, opts) {
  const options = opts || {};
  if (options.serverStarted) {
    // dev server 是刚被拉起来的：给隧道几秒重建到本地的连接（cloudflared 自己会重试）
    await sleep(5000);
  }
  const attempts = Number(options.attempts || 3);
  for (let i = 0; i < attempts; i += 1) {
    const hit = await probePublicUrl(url, Number(options.timeoutMs || 7000));
    if (hit) return true;
    if (i < attempts - 1) await sleep(3000);
  }
  return false;
}

async function probeLocal(localOrigin, timeoutMs) {
  return httpGetJson(localOrigin + PROBE_PATH, timeoutMs);
}

// cloudflared 自带的就绪端点：200 = 已连上边缘，503 = 进程在但没连上（断网后的僵尸态）
async function probeReady(port) {
  const P = pathsFor(port);
  const res = await httpGetJson('http://127.0.0.1:' + P.metricsPort + '/ready', 2500);
  return res ? res.status : null;
}

// 端口是否有人监听（纯 TCP，不依赖具体路由）
function tcpPing(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs || 1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(Number(port), host || '127.0.0.1');
    } catch (e) {
      finish(false);
    }
  });
}

async function isPortListening(port) {
  return tcpPing(port, '127.0.0.1', 1500);
}

/* ------------------------------------------------------------------ 隧道启动 */

function tunnelArgs(P) {
  // 国内网络 QUIC(UDP) 常被限速/拦截，强制 http2(TCP 443) 更稳（与既有脚本一致）
  return [
    'tunnel',
    '--protocol',
    'http2',
    '--edge-ip-version',
    '4',
    '--url',
    'http://localhost:' + P.port,
    '--metrics',
    '127.0.0.1:' + P.metricsPort,
    '--pidfile',
    P.pidFile,
  ];
}

function tailOf(file, max) {
  const txt = readText(file);
  const lines = txt.split('\n');
  return lines.slice(-max).join('\n');
}

async function waitForTunnelUrl(P, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const file of [P.errFile, P.logFile]) {
      const matches = readText(file).match(URL_RE);
      if (matches && matches.length) return matches[matches.length - 1];
    }
    await sleep(1200);
  }
  return null;
}

async function startTunnel(port) {
  const P = pathsFor(port);
  const exe = findCloudflared();
  if (!exe) {
    const err = new Error('未找到 cloudflared，请先安装（Windows: winget install Cloudflare.cloudflared）');
    err.code = 'NO_CLOUDFLARED';
    throw err;
  }

  ensureRunDir();
  try {
    fs.unlinkSync(P.pidFile);
  } catch (e) {
    /* ignore */
  }
  // 清空旧日志，保证解析到的地址一定来自本次启动
  writeText(P.logFile, '');
  writeText(P.errFile, '');

  const outFd = fs.openSync(P.logFile, 'a');
  const errFd = fs.openSync(P.errFile, 'a');
  let child;
  try {
    child = spawn(exe, tunnelArgs(P), {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.unref();

  const url = await waitForTunnelUrl(P, 60000);
  if (!url) {
    const err = new Error('启动 cloudflared 后 60 秒内未取得公网地址');
    err.code = 'TUNNEL_TIMEOUT';
    err.detail = tailOf(P.errFile, 8);
    throw err;
  }
  return { url, pid: child.pid, exe };
}

// 新地址拿到后可能还要几秒才真正可访问（DNS 生效 + 边缘就绪）
async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await probePublicUrl(url, 6000);
    if (hit) return true;
    await sleep(2000);
  }
  return false;
}

/* -------------------------------------------------------------- dev server */

/**
 * 确保本地 dev server 在跑 —— 隧道指向一个没人监听的端口，地址就是废的。
 * 用 node 直接拉 webpack-cli（不依赖 npm，绕过 PowerShell 执行策略限制），
 * 其次退化为 `npm run start`。detached 启动，本进程退出后依然存活。
 */
async function ensureDevServer(port, opts) {
  const P = pathsFor(port);
  const options = opts || {};
  if (await isPortListening(P.port)) {
    return { started: false, up: true, pid: 0, message: 'dev server 已在 :' + P.port + ' 运行，复用' };
  }

  ensureRunDir();
  const cli = path.join(ROOT, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  let cmd;
  let args;
  if (fs.existsSync(cli)) {
    cmd = process.execPath;
    args = [cli, 'serve', '--mode', 'development'];
  } else if (process.platform === 'win32') {
    cmd = 'npm.cmd';
    args = ['run', 'start'];
  } else {
    cmd = 'npm';
    args = ['run', 'start'];
  }

  const env = Object.assign({}, process.env, { PORT: String(P.port) });
  const fd = fs.openSync(P.serverLog, 'a');
  let child;
  try {
    child = spawn(cmd, args, {
      cwd: ROOT,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();

  const waitMs = Number(options.waitMs || 150000);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await isPortListening(P.port)) {
      return { started: true, up: true, pid: child.pid, message: 'dev server 已启动 :' + P.port };
    }
  }
  const err = new Error('dev server 在 ' + Math.round(waitMs / 1000) + ' 秒内未能启动（日志：' + P.serverLog + '）');
  err.code = 'SERVER_TIMEOUT';
  throw err;
}

/* -------------------------------------------------------------------- 主流程 */

function emptyResult(extra) {
  return Object.assign({ ok: false, url: '', reused: false, changed: false, ready: false }, extra || {});
}

/** 当前状态（只读，不改动任何进程） */
async function status(opts) {
  const P = pathsFor((opts && opts.port) || PRIMARY_PORT);
  const state = loadState(P.port);
  const exe = findCloudflared();
  const { pids, all } = findOurTunnelPids(P.port);
  const readyStatus = pids.length ? await probeReady(P.port) : null;

  const local = await probeLocal(P.localOrigin, 4000);
  const devServerUp = !!(local && local.status === 200);

  let urlHealthy = false;
  if (state.url && pids.length) {
    urlHealthy = !!(await probePublicUrl(state.url, 6000));
  }

  return {
    ok: true,
    project: 'feishu-dayin',
    instanceId: instanceId(),
    port: P.port,
    devServerUp,
    localOrigin: P.localOrigin,
    localDeployPage: P.deployPage,
    url: state.url,
    urlHealthy,
    cloudflared: {
      found: !!exe,
      path: exe || '',
      running: pids.length > 0,
      pids,
      otherInstances: Math.max(0, all.length - pids.length),
      ready: readyStatus === 200,
      readyStatus,
    },
    tunnelCreatedAt: state.createdAt,
    tunnelUpdatedAt: state.updatedAt,
    source: state.source,
    hint: buildHint({ state, pids, urlHealthy, exe }),
  };
}

function buildHint(ctx) {
  const { state, pids, urlHealthy, exe } = ctx;
  if (!exe) return '未检测到 cloudflared，请先安装后再部署（winget install Cloudflare.cloudflared）。';
  if (!state.url && !pids.length) return '尚未部署，运行一键部署生成内网穿透地址。';
  if (state.url && urlHealthy) return '内网穿透正常，再次部署会复用当前地址，不会更换。';
  if (pids.length) return '隧道进程还在，但地址已不可用（多半是断网超过 5 分钟被回收），部署会重新生成地址。';
  return '隧道进程已退出，部署会重新生成地址。';
}

/**
 * 一键部署：能复用就复用，复用不了才重新生成。
 * @param {{port?:number|string, force?:boolean, ensureServer?:boolean}} opts
 */
async function deploy(opts) {
  const options = opts || {};
  const P = pathsFor(options.port || PRIMARY_PORT);
  const force = !!options.force;

  // 隧道指向没人监听的端口 = 废地址，先确保 dev server 起来
  let server = { started: false, up: true, pid: 0 };
  if (options.ensureServer !== false) {
    server = await ensureDevServer(P.port, { waitMs: options.serverWaitMs });
  }

  const before = loadState(P.port);
  const { pids, all } = findOurTunnelPids(P.port);
  const processAlive = pids.length > 0;
  const readyStatus = processAlive ? await probeReady(P.port) : null;

  // 「上一次生成的地址」：优先状态文件；状态文件丢了就从上次日志里捞，尽量别白换地址
  const lastUrl = before.url || lastUrlFromLogs(P.port);

  // 1) 不强制换地址时，先看上一次的地址还在不在（多试几次，避免瞬时抖动导致白换地址）
  if (!force && lastUrl && processAlive) {
    // 隧道本身已连上 Cloudflare 边缘（/ready 200）却探测不通，多半是本地服务刚重启、
    // 或边缘短暂抖动 —— 这种情况更值得多等一会儿，而不是急着换地址。
    const edgeConnected = readyStatus === 200;
    const ok = await probeForReuse(lastUrl, {
      serverStarted: server.started,
      attempts: edgeConnected ? 5 : 3,
      timeoutMs: 7000,
    });
    if (ok) {
      saveState(P.port, { url: lastUrl, pid: pids[0], source: 'reuse' });
      return {
        ok: true,
        action: 'reuse',
        reused: true,
        changed: false,
        ready: true,
        url: lastUrl,
        previousUrl: lastUrl,
        pid: pids[0],
        port: P.port,
        urlFile: P.urlFile,
        server,
        message: '复用上一次的内网穿透地址（未重启隧道，地址保持不变）',
      };
    }
  }

  // 2) 需要重新生成：先把属于本机本端口的旧进程收干净
  const killed = killPids(pids);
  if (killed) await sleep(1500);

  const started = await startTunnel(P.port);
  const ready = await waitUntilReachable(started.url, 40000);
  saveState(P.port, { url: started.url, pid: started.pid, source: force ? 'force' : 'regenerate' });

  const changed = !!lastUrl && lastUrl !== started.url;
  return {
    ok: true,
    action: force ? 'forced' : 'regenerated',
    reused: false,
    changed,
    ready,
    url: started.url,
    previousUrl: lastUrl,
    pid: started.pid,
    port: P.port,
    urlFile: P.urlFile,
    killed,
    ready503Before: readyStatus === 503,
    exe: started.exe,
    server,
    message: changed
      ? '旧地址已失效，已重新生成新地址 —— 请把新地址更新到飞书插件配置里'
      : force
        ? '已强制生成新地址 —— 请把新地址更新到飞书插件配置里'
        : '已生成内网穿透地址',
    allCloudflared: all.length,
  };
}

/** 停止隧道（只停属于本项目端口的那个 cloudflared，不碰别的工具） */
function stop(opts) {
  const P = pathsFor((opts && opts.port) || PRIMARY_PORT);
  const { pids } = findOurTunnelPids(P.port);
  const killed = killPids(pids);
  // 只有确实有隧道或有历史状态时才写状态文件，避免给没部署过的端口留下空文件
  if (killed || fs.existsSync(P.stateFile)) clearStateUrl(P.port, 'stopped');
  return {
    ok: true,
    killed,
    pids,
    port: P.port,
    message: killed ? '已停止隧道（PID ' + pids.join(', ') + '）' : '没有正在运行的隧道',
  };
}

module.exports = {
  ROOT,
  RUN_DIR,
  PRIMARY_PORT,
  PROBE_PATH,
  pathsFor,
  normalizePort,
  instanceId,
  loadState,
  saveState,
  clearStateUrl,
  lastUrlFromLogs,
  findCloudflared,
  listCloudflared,
  findOurTunnelPids,
  killPids,
  probePublicUrl,
  probeForReuse,
  probeLocal,
  probeReady,
  isPortListening,
  startTunnel,
  waitUntilReachable,
  ensureDevServer,
  status,
  deploy,
  stop,
  emptyResult,
};
