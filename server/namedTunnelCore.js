'use strict';
/**
 * ============================================================
 * 命名隧道核心（固定域名部署）
 * ============================================================
 * 与 tunnelCore.js（临时隧道 / *.trycloudflare.com）的区别：
 *   - 临时隧道的域名由 Cloudflare 随机分配、客户端无法指定，只能「进程不重启就复用」；
 *   - 命名隧道绑定**自有域名**，域名写死在 Cloudflare 账号里，重启电脑 / 重装 / 换机器都不变。
 *
 * 本模块负责把「项目文件夹」变成「到哪台电脑都能一键起隧道」：
 *   1. 凭据随身携带：deploy/cloudflared/ 里放着隧道密钥 json 与令牌，
 *      部署时安装到 ~/.cloudflared/，并在项目内渲染一份 config.yml（路径按本机现算）。
 *   2. cloudflared 二进制定位：runtime/cloudflared/ 优先，其次系统 PATH，
 *      都没有就自动下载（可用 --no-download 关闭）。
 *   3. 只认自己那条隧道：按 tunnelId / tunnelName 过滤进程，绝不误杀别的隧道。
 *   4. 开机自启：在「启动」文件夹放一个 VBS，登录后静默拉起（免管理员权限）。
 *
 * 使用方：
 *   - server/setupCore.js  -> 命令行 / 「一键部署.bat」
 *   - server/setupApi.js   -> dev server 的 /api/setup/* 与本地部署页按钮
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const tun = require('./tunnelCore');

const ROOT = path.resolve(__dirname, '..');
const RUN_DIR = path.join(ROOT, '.run');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const CF_DIR = path.join(RUNTIME_DIR, 'cloudflared');
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const PROFILES_DIR = path.join(DEPLOY_DIR, 'profiles');
// 默认 profile 沿用历史路径（deploy/tunnel.config.json + deploy/cloudflared/），
// 老机器、老凭据、老文档都不用动；额外域名放 deploy/profiles/<名字>/。
const CONFIG_PATH = path.join(DEPLOY_DIR, 'tunnel.config.json');
const BUNDLE_DIR = path.join(DEPLOY_DIR, 'cloudflared');
const DEFAULT_PROFILE = 'default';
const METRICS_PORT_BASE = 20241;

const CLOUDFLARED_DL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

/* ------------------------------------------------------------------ 小工具 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function writeTextUtf16(file, text) {
  ensureDir(path.dirname(file));
  // WSH 读 .vbs 默认按 ANSI 解，路径含中文就乱；带 BOM 的 UTF-16LE 能被正确识别
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

/** 取任意 URL 的状态码（拿不到返回 null）。cloudflared 的 /ready 就是靠它探。 */
function httpGetStatus(url, timeoutMs) {
  const http = require('http');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs || 2500 }, (res) => {
        res.resume();
        done(res.statusCode);
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

/* -------------------------------------------------------------- 配置读取 */

const DEFAULT_CONFIG = {
  tunnelName: 'feishuprint',
  tunnelId: '',
  hostname: '',
  fixedUrl: '',
  port: 5173,
  credentialsFile: '',
  certFile: '',
  protocol: 'http2',
  edgeIpVersion: '4',
  metricsPort: 20241,
  startAtLogin: true,
};

/* ----------------------------------------------------- 多固定域名（profile） */

/**
 * profile 名的合法字符集。刻意收紧：这个名字会被拼进目录路径，
 * 放任 `..` 或 `/` 进来就是目录穿越。
 */
function safeProfileName(name) {
  const p = String(name == null ? '' : name).trim();
  if (!p) return DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(p) || p === '.' || p === '..') {
    const err = new Error('域名标识只能含字母/数字/._-（1~40 位），收到：' + p);
    err.code = 'BAD_PROFILE';
    throw err;
  }
  return p;
}

/** 某个 profile 的配置与凭据落点（默认 profile 用历史路径） */
function profilePaths(name) {
  const profile = safeProfileName(name);
  if (profile === DEFAULT_PROFILE) {
    return { profile, configPath: CONFIG_PATH, bundleDir: BUNDLE_DIR };
  }
  const dir = path.join(PROFILES_DIR, profile);
  return {
    profile,
    configPath: path.join(dir, 'tunnel.config.json'),
    bundleDir: path.join(dir, 'cloudflared'),
  };
}

/** 列出所有已配置的固定域名（默认 profile + deploy/profiles/*） */
function listProfiles() {
  const out = [];
  const push = (profile, configPath) => {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      return; // 配置坏了就跳过，不让它拖垮整个列表
    }
    const hostname = raw.hostname || String(raw.fixedUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    out.push({
      profile,
      configPath,
      hostname,
      fixedUrl: raw.fixedUrl || (hostname ? 'https://' + hostname : ''),
      tunnelName: raw.tunnelName || '',
      tunnelId: raw.tunnelId || '',
      metricsPort: Number(raw.metricsPort) || METRICS_PORT_BASE,
      isDefault: profile === DEFAULT_PROFILE,
    });
  };
  if (fs.existsSync(CONFIG_PATH)) push(DEFAULT_PROFILE, CONFIG_PATH);
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR);
  } catch (e) {
    names = [];
  }
  names.sort().forEach((n) => {
    const cfgPath = path.join(PROFILES_DIR, n, 'tunnel.config.json');
    if (fs.existsSync(cfgPath)) push(n, cfgPath);
  });
  return out;
}

/** 挑一个没被占用的 metrics 端口，避免同机多域名时打架 */
function pickMetricsPort(taken) {
  const used = new Set((taken || []).map((n) => Number(n)));
  let p = METRICS_PORT_BASE;
  while (used.has(p)) p += 1;
  return p;
}

/**
 * 「上次用的域名」记在这里。放在 runtime/（不入库）：
 * 它是这台机器的本地状态，不该跟着项目文件夹复制到别的电脑上。
 * 命令行与 /deploy 管理页共用这一份，避免两边各记一套而对不上。
 */
const ACTIVE_PROFILE_FILE = path.join(RUNTIME_DIR, 'active-profile.txt');

function readActiveProfile() {
  try {
    return String(fs.readFileSync(ACTIVE_PROFILE_FILE, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function writeActiveProfile(name) {
  try {
    ensureDir(RUNTIME_DIR);
    fs.writeFileSync(ACTIVE_PROFILE_FILE, safeProfileName(name) + '\n', 'utf8');
  } catch (e) {
    /* 记不住不影响本次使用，忽略 */
  }
}

function loadConfig(profileName) {
  const paths = profilePaths(profileName);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  } catch (e) {
    raw = {};
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  cfg.profile = paths.profile;
  cfg.configPath = paths.configPath;
  cfg.bundleDir = paths.bundleDir;
  if (!cfg.fixedUrl && cfg.hostname) cfg.fixedUrl = 'https://' + cfg.hostname;
  cfg.hostname = cfg.hostname || String(cfg.fixedUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  cfg.port = Number(cfg.port) || 5173;

  // 凭据在项目内的绝对路径（随文件夹移动自动跟着变）
  cfg.bundledCredentials = cfg.credentialsFile ? path.join(paths.bundleDir, path.basename(cfg.credentialsFile)) : '';
  cfg.bundledCert = cfg.certFile ? path.join(paths.bundleDir, path.basename(cfg.certFile)) : '';
  cfg.userCfDir = path.join(os.homedir(), '.cloudflared');
  cfg.userCredentials = cfg.tunnelId ? path.join(cfg.userCfDir, cfg.tunnelId + '.json') : '';
  cfg.userConfig = path.join(cfg.userCfDir, 'config.yml');

  // ---- 运行时产物按 profile 隔离 ----
  // 同一台电脑上换域名部署时，pid / 日志 / 状态 / metrics 端口都不能互相踩：
  // metrics 端口撞了会让第二条隧道起不来，状态文件撞了会让 stop 误杀别的域名。
  const tag = cfg.profile === DEFAULT_PROFILE ? '' : cfg.profile + '-';
  cfg.runtimeConfig = cfg.profile === DEFAULT_PROFILE
    ? path.join(CF_DIR, 'config.yml')
    : path.join(CF_DIR, cfg.profile + '.config.yml');
  cfg.pidFile = path.join(RUN_DIR, tag + 'named-tunnel.pid');
  cfg.logFile = path.join(RUN_DIR, tag + 'named-tunnel.log');
  cfg.errFile = path.join(RUN_DIR, tag + 'named-tunnel.err.log');
  cfg.stateFile = path.join(RUN_DIR, tag + 'named-tunnel.json');
  cfg.metricsPort = Number(cfg.metricsPort) || METRICS_PORT_BASE;
  cfg.localOrigin = 'http://127.0.0.1:' + cfg.port;
  return cfg;
}

/* -------------------------------------------------------- cloudflared 定位 */

function findCloudflared(cfg) {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  // 1) 环境变量显式指定
  const override = process.env.CLOUDFLARED_PATH;
  if (override && fs.existsSync(override)) return override;
  // 2) 随项目携带 / 自动下载的（换机器时最可靠，优先于系统安装）
  const local = path.join(CF_DIR, exe);
  if (fs.existsSync(local) && fs.statSync(local).isFile()) return local;
  // 3) 系统安装（tunnelCore 已覆盖 PATH / Program Files / winget 包目录）
  return tun.findCloudflared();
}

/** 下载文件到本地，跟随 30x 跳转，带简单进度提示 */
function download(url, dest, opts) {
  const options = opts || {};
  const maxRedirect = 8;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let received = 0;
    let lastTick = 0;

    const go = (u) => {
      let req;
      try {
        req = https.get(
          u,
          { timeout: 120000, headers: { 'User-Agent': 'feishuprint-setup' } },
          (res) => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
              res.resume();
              redirects += 1;
              if (redirects > maxRedirect) return reject(new Error('重定向次数过多：' + url));
              return go(new URL(res.headers.location, u).toString());
            }
            if (code !== 200) {
              res.resume();
              return reject(new Error('下载失败 HTTP ' + code + '：' + u));
            }
            const total = Number(res.headers['content-length'] || 0);
            const tmp = dest + '.part';
            ensureDir(path.dirname(dest));
            const out = fs.createWriteStream(tmp);
            res.on('data', (c) => {
              received += c.length;
              const now = Date.now();
              if (options.onProgress && now - lastTick > 1000) {
                lastTick = now;
                options.onProgress(received, total);
              }
            });
            res.pipe(out);
            out.on('error', reject);
            out.on('finish', () => {
              out.close(() => {
                try {
                  if (total && received !== total) throw new Error('下载不完整（' + received + '/' + total + ' 字节）');
                  if (fs.existsSync(dest)) fs.unlinkSync(dest);
                  fs.renameSync(tmp, dest);
                  resolve(dest);
                } catch (e) {
                  reject(e);
                }
              });
            });
          },
        );
      } catch (e) {
        return reject(e);
      }
      req.on('timeout', () => {
        req.destroy(new Error('下载超时：' + u));
      });
      req.on('error', reject);
    };
    go(url);
  });
}

/** 找不到 cloudflared 时自动下载到 runtime/cloudflared/ */
async function ensureCloudflared(cfg, opts) {
  const options = opts || {};
  const found = findCloudflared(cfg);
  if (found) return { path: found, downloaded: false };

  if (process.platform !== 'win32') {
    const err = new Error('未找到 cloudflared。请先安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    err.code = 'NO_CLOUDFLARED';
    throw err;
  }
  if (options.download === false) {
    const err = new Error('未找到 cloudflared，且已禁用自动下载');
    err.code = 'NO_CLOUDFLARED';
    throw err;
  }

  const dest = path.join(CF_DIR, 'cloudflared.exe');
  if (options.log) options.log('未检测到 cloudflared，正在下载（约 54MB，仅首次需要）…');
  await download(CLOUDFLARED_DL, dest, {
    onProgress: (got, total) => {
      if (!options.log) return;
      const mb = (n) => (n / 1048576).toFixed(1);
      options.log(total ? `  下载中 ${mb(got)} / ${mb(total)} MB` : `  下载中 ${mb(got)} MB`);
    },
  });
  if (fileSize(dest) < 10 * 1024 * 1024) {
    throw new Error('下载到的 cloudflared 体积异常（' + fileSize(dest) + ' 字节），请手动把 cloudflared.exe 放到 runtime/cloudflared/');
  }
  return { path: dest, downloaded: true };
}

/* ------------------------------------------------------------ 凭据与配置 */

function buildConfigYml(cfg, credentialsPath) {
  // 用「隧道名」而不是 UUID：cloudflared 起隧道时只依赖 credentials-file 里的 TunnelID，
  // 名字仅作标识（本机现状已实证：cert.pem 其实是 token，无法做 API 名字解析，照样跑通）。
  // 写法与用户目录里那份一直可用的 config.yml 完全一致，换成新机器也一样成立。
  //
  // 注意：这里必须写 127.0.0.1，不能写 localhost。
  // 本机 dev server 监听 0.0.0.0（仅 IPv4），而 cloudflared 解析 localhost 时可能优先拿到 ::1，
  // 于是会随机出现 "dial tcp [::1]:5173: connectex: No connection could be made ..." 502。
  // 写死 IPv4 回环可彻底规避这个双栈解析问题。
  return [
    '# 由一键部署自动生成，请勿手工修改（改了会被下一次部署覆盖）',
    '# 隧道：' + (cfg.tunnelName || '') + '　域名：' + cfg.hostname,
    'tunnel: ' + (cfg.tunnelName || cfg.tunnelId),
    'credentials-file: ' + credentialsPath,
    '',
    'ingress:',
    '  - hostname: ' + cfg.hostname,
    '    service: http://127.0.0.1:' + cfg.port,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

/**
 * 安装隧道凭据：把项目里携带的密钥装到 ~/.cloudflared/，
 * 并在项目内（runtime/cloudflared/config.yml）与用户目录各渲染一份 config。
 * credentials-file 用「本机绝对路径」，所以项目文件夹换机器后无需手工改配置。
 */
function installCredentials(cfg, opts) {
  const options = opts || {};
  const actions = [];
  ensureDir(cfg.userCfDir);
  ensureDir(CF_DIR);

  if (!cfg.tunnelId) {
    const err = new Error('deploy/tunnel.config.json 缺少 tunnelId');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!fs.existsSync(cfg.bundledCredentials)) {
    const err = new Error(
      '缺少隧道密钥文件：' + cfg.bundledCredentials +
      '\n  请从旧电脑把整个 deploy/cloudflared/ 目录一并复制过来。',
    );
    err.code = 'NO_CREDENTIALS';
    throw err;
  }

  // 1) 隧道密钥 json —— 内容不同才覆盖
  const src = readText(cfg.bundledCredentials);
  if (readText(cfg.userCredentials) !== src) {
    fs.copyFileSync(cfg.bundledCredentials, cfg.userCredentials);
    actions.push('已安装隧道密钥 → ' + cfg.userCredentials);
  }

  // 2) 令牌（cert.pem）—— 只在缺失时补，绝不覆盖已有的真证书
  if (cfg.bundledCert && fs.existsSync(cfg.bundledCert) && !fs.existsSync(path.join(cfg.userCfDir, 'cert.pem'))) {
    fs.copyFileSync(cfg.bundledCert, path.join(cfg.userCfDir, 'cert.pem'));
    actions.push('已安装隧道令牌 → ' + path.join(cfg.userCfDir, 'cert.pem'));
  }

  // 3) config.yml
  // 项目内那份永远按本机路径渲染 —— 启动时用 --config 显式指定，不依赖任何全局状态。
  const yml = buildConfigYml(cfg, cfg.userCredentials);
  if (readText(cfg.runtimeConfig) !== yml) {
    writeText(cfg.runtimeConfig, yml);
    actions.push('已生成项目内配置 → ' + cfg.runtimeConfig);
  }

  // 用户目录那份 config.yml 是「全局单例」，同一台电脑上放多个域名时必然互相覆盖。
  // 所以只有默认 profile 才维护它；其它 profile 一律只靠项目内的 --config，
  // 行为更可预测（也更符合「一个文件夹 = 一套配置」的直觉）。
  let ours = true;
  if (cfg.profile !== DEFAULT_PROFILE) {
    ours = false; // 非默认域名刻意不碰用户级配置，见下方注释
    if (!options.quiet) {
      actions.push('非默认域名：跳过用户级 config.yml（启动时用 --config 走项目内那份）');
    }
  } else {
    const existingUserCfg = readText(cfg.userConfig);
    ours = !existingUserCfg || existingUserCfg.includes(cfg.hostname) || existingUserCfg.includes(cfg.tunnelName);
    if (ours) {
      if (existingUserCfg !== yml) {
        writeText(cfg.userConfig, yml);
        actions.push('已生成用户级配置 → ' + cfg.userConfig);
      }
    } else if (!options.quiet) {
      actions.push('用户目录已存在其它 config.yml，未改动（本部署用 --config 走项目内配置）');
    }
  }

  return { actions, userConfig: cfg.userConfig, runtimeConfig: cfg.runtimeConfig, skipUserConfig: !ours };
}

/* -------------------------------------------------------- 进程发现与终止 */

/** 只挑出「跑本项目这条命名隧道」的 cloudflared（按 tunnelId / tunnelName 匹配） */
function findNamedTunnelPids(cfg) {
  const all = tun.listCloudflared();
  const needles = [cfg.tunnelId, cfg.tunnelName].filter(Boolean);
  const mine = all
    .filter((p) => {
      const cmd = String(p.cmd || '');
      return needles.some((n) => cmd.includes(n));
    })
    .map((p) => p.pid);

  // 状态文件里记的 PID 仍然活着（且确实是 cloudflared）→ 认它，兼容命令行读不到的情况
  const st = readJsonSafe(cfg.stateFile, {});
  if (st.pid && all.some((p) => p.pid === st.pid)) mine.push(st.pid);

  // 兜底：整机只有一个 cloudflared 且连命令行都读不出来 → 认定就是我们的。
  // （与 tunnelCore 的兜底保持一致；能读到命令行时绝不用这条，避免误杀别的隧道）
  if (!mine.length && all.length === 1 && !all[0].cmd) mine.push(all[0].pid);

  return { pids: [...new Set(mine)], all };
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveState(cfg, patch) {
  ensureDir(RUN_DIR);
  const next = Object.assign(readJsonSafe(cfg.stateFile, {}), patch, { updatedAt: new Date().toISOString() });
  if (!next.createdAt) next.createdAt = next.updatedAt;
  writeText(cfg.stateFile, JSON.stringify(next, null, 2));
  return next;
}

/* ---------------------------------------------------------------- 启停主流程 */

async function probeReady(cfg) {
  return httpGetStatus('http://127.0.0.1:' + cfg.metricsPort + '/ready', 2500);
}

/** 固定域名是否真的回连到本机这套服务（靠 instanceId 校验，避免同名地址其实是别人的） */
async function probeFixed(cfg, timeoutMs) {
  return tun.probePublicUrl(cfg.fixedUrl, timeoutMs || 8000);
}

function spawnTunnel(exe, args, cfg) {
  ensureDir(RUN_DIR);
  try {
    fs.unlinkSync(cfg.pidFile);
  } catch (e) {
    /* ignore */
  }
  writeText(cfg.logFile, '');
  writeText(cfg.errFile, '');

  const outFd = fs.openSync(cfg.logFile, 'a');
  const errFd = fs.openSync(cfg.errFile, 'a');
  let child;
  try {
    child = spawn(exe, args, {
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
  return child;
}

async function waitTunnelReady(cfg, child, waitMs) {
  const deadline = Date.now() + waitMs;
  let readyStatus = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    readyStatus = await probeReady(cfg);
    if (readyStatus === 200) break;
    if (child.exitCode !== null) break; // 进程已退出，不必再等
  }
  return readyStatus;
}

async function startNamedTunnel(cfg, opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const cf = await ensureCloudflared(cfg, { download: options.download, log });

  ensureDir(RUN_DIR);
  const { pids } = findNamedTunnelPids(cfg);
  const ready = pids.length ? await probeReady(cfg) : null;

  // 已在跑且边缘已连上 → 什么都不用做（地址本来就是固定的，不存在"复用"问题）
  if (pids.length && ready === 200 && !options.force) {
    return { started: false, reused: true, pid: pids[0], exe: cf.path, readyStatus: ready };
  }

  if (pids.length) {
    log('收掉旧的隧道进程（PID ' + pids.join(', ') + '）…');
    tun.killPids(pids);
    await sleep(1500);
  }

  const runArg = cfg.tunnelName || cfg.tunnelId;
  const common = [
    '--protocol', cfg.protocol || 'http2',
    '--edge-ip-version', String(cfg.edgeIpVersion || '4'),
    '--metrics', '127.0.0.1:' + cfg.metricsPort,
    '--pidfile', cfg.pidFile,
  ];
  // 先试项目内配置（换机器后不依赖任何全局状态）；万一 cloudflared 版本对
  // `tunnel --config` 的位置敏感，再退回一直可用的兼容写法，保证不会把服务搞挂。
  const plan = [
    { label: '项目内配置', args: ['tunnel', '--config', cfg.runtimeConfig].concat(common, ['run', runArg]) },
    { label: '兼容模式', args: ['tunnel'].concat(common, ['run', runArg]) },
  ];

  const waitMs = Number(options.waitMs || 75000);
  let lastStatus = null;
  let lastChild = null;

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    log('启动隧道（' + step.label + '）：' + path.basename(cf.path) + ' ' + step.args.join(' '));
    lastChild = spawnTunnel(cf.path, step.args, cfg);
    lastStatus = await waitTunnelReady(cfg, lastChild, waitMs);
    if (lastStatus === 200) {
      saveState(cfg, { pid: lastChild.pid, url: cfg.fixedUrl, source: 'named', configMode: step.label });
      return { started: true, reused: false, pid: lastChild.pid, exe: cf.path, readyStatus: lastStatus, configMode: step.label };
    }
    // 本次没连上：把这次留下的进程收掉再试下一种写法
    const alive = lastChild.pid ? [lastChild.pid] : [];
    tun.killPids(alive);
    await sleep(1500);
    if (i < plan.length - 1) log('该写法未连上边缘（/ready=' + lastStatus + '），改用兼容模式重试…');
  }

  const err = new Error('隧道启动后未能连上 Cloudflare 边缘（/ready=' + lastStatus + '）');
  err.code = 'TUNNEL_NOT_READY';
  err.detail = readText(cfg.errFile).split('\n').slice(-10).join('\n');
  throw err;
}

function stopNamedTunnel(cfg) {
  const { pids } = findNamedTunnelPids(cfg);
  const killed = tun.killPids(pids);
  const next = saveState(cfg, { pid: 0, source: killed ? 'stopped' : readJsonSafe(cfg.stateFile, {}).source || '' });
  return {
    ok: true,
    killed,
    pids,
    state: next,
    message: killed ? '已停止固定域名隧道（PID ' + pids.join(', ') + '）' : '固定域名隧道本来就没在跑',
  };
}

/* ------------------------------------------------------------ 开机自启 */

function startupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function autostartFile() {
  return path.join(startupDir(), 'feishuprint-autostart.vbs');
}

function autostartLauncher(cfg) {
  // 指向 ASCII 名的引擎（deploy.bat），不用中文名的包装脚本：
  // VBS 虽然按 UTF-16LE+BOM 写、中文路径没问题，但少一层转发少一个失败点。
  // 中文名的「一键部署.bat」只是给人双击的包装，两者最终都进 server/setupCore.js。
  return path.join(ROOT, 'deploy.bat');
}

function autostartStatus(cfg) {
  const file = autostartFile();
  const exists = fs.existsSync(file);
  // 顺便报出这条自启绑定的是哪个域名 —— 换过域名的机器上一眼就能看出自启跟没跟上。
  let boundProfile = '';
  if (exists) {
    try {
      const txt = fs.readFileSync(file, 'utf16le'); // VBS 是 UTF-16LE(+BOM)
      const m = txt.match(/--profile\s+([A-Za-z0-9._-]+)/);
      boundProfile = m ? m[1] : DEFAULT_PROFILE;
    } catch (e) {
      boundProfile = '';
    }
  }
  return { enabled: exists, file, launcher: autostartLauncher(cfg), profile: boundProfile };
}

function autostartEnable(cfg) {
  const launcher = autostartLauncher(cfg);
  if (!fs.existsSync(launcher)) {
    const err = new Error('找不到启动脚本：' + launcher);
    err.code = 'NO_LAUNCHER';
    throw err;
  }
  ensureDir(startupDir());
  // 保持这个 vbs 极简：只负责「静默启动 deploy.bat」。
  // 网络等待、重试、日志这些都在 server/setupCore.js 里做 —— 那边可测试、可排错，
  // 而 vbs 一旦写复杂了，出问题只会变成一个没有输出的哑失败，最难查。
  const vbs = [
    "' 由一键部署自动生成：登录 Windows 后静默拉起 dev server + 固定域名隧道",
    "' 绑定域名：" + cfg.fixedUrl + '　（域名标识 profile=' + cfg.profile + '）',
    "' 删除本文件即可取消开机自启（或运行 自启开关.bat off）",
    "' 实际逻辑在 deploy.bat → server/setupCore.js（--autostart 表示来自登录自启）",
    'On Error Resume Next',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + ROOT + '"',
    // --profile 必须显式写进来：登录自启是无交互的，
    // 不能指望它去读「上次用了哪个域名」，机器上多域名时那样会静默起错。
    // 0 = 隐藏窗口；False = 不等待，不拖慢登录
    'sh.Run """' + launcher + '"" --silent --autostart --profile ' + cfg.profile + '", 0, False',
    '',
  ].join('\r\n');
  writeTextUtf16(autostartFile(), vbs);
  return autostartStatus(cfg);
}

function autostartDisable(cfg) {
  const file = autostartFile();
  let removed = false;
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
    }
  } catch (e) {
    /* ignore */
  }
  return Object.assign(autostartStatus(cfg), { removed });
}

/* ------------------------------------------------------------------ 状态 */

async function status(cfgOverride) {
  const cfg = cfgOverride || loadConfig();
  const cf = findCloudflared(cfg);
  const { pids, all } = findNamedTunnelPids(cfg);
  const readyStatus = pids.length ? await probeReady(cfg) : null;
  const local = await tun.probeLocal(cfg.localOrigin, 4000);
  const devServerUp = !!(local && local.status === 200);
  const fixed = await probeFixed(cfg, 8000);
  const state = readJsonSafe(cfg.stateFile, {});
  const auto = autostartStatus(cfg);

  return {
    ok: true,
    project: 'feishu-dayin',
    mode: 'named-tunnel',
    profile: cfg.profile,
    instanceId: tun.instanceId(),
    hostname: cfg.hostname,
    fixedUrl: cfg.fixedUrl,
    port: cfg.port,
    devServerUp,
    localOrigin: cfg.localOrigin,
    deployPage: cfg.localOrigin + '/deploy',
    fixedUrlHealthy: !!fixed,
    credentials: {
      bundled: fs.existsSync(cfg.bundledCredentials),
      bundledPath: cfg.bundledCredentials,
      installed: fs.existsSync(cfg.userCredentials),
      installedPath: cfg.userCredentials,
    },
    cloudflared: {
      found: !!cf,
      path: cf || '',
      running: pids.length > 0,
      pids,
      ready: readyStatus === 200,
      readyStatus,
      otherInstances: Math.max(0, all.length - pids.length),
    },
    autostart: auto,
    startedAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
  };
}

module.exports = {
  ROOT,
  RUNTIME_DIR,
  CF_DIR,
  DEPLOY_DIR,
  PROFILES_DIR,
  CONFIG_PATH,
  BUNDLE_DIR,
  DEFAULT_PROFILE,
  METRICS_PORT_BASE,
  safeProfileName,
  profilePaths,
  listProfiles,
  pickMetricsPort,
  ACTIVE_PROFILE_FILE,
  readActiveProfile,
  writeActiveProfile,
  loadConfig,
  findCloudflared,
  ensureCloudflared,
  installCredentials,
  buildConfigYml,
  findNamedTunnelPids,
  probeReady,
  probeFixed,
  startNamedTunnel,
  stopNamedTunnel,
  autostartEnable,
  autostartDisable,
  autostartStatus,
  autostartFile,
  startupDir,
  status,
  saveState,
  readJsonSafe,
  download,
  writeText,
  writeTextUtf16,
  ensureDir,
  sleep,
};
