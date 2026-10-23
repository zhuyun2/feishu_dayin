'use strict';
/**
 * ============================================================
 * 命名隧道核心 · macOS 版（固定域名部署）
 * ============================================================
 * 与 server/namedTunnelCore.js（Windows 版）的关系：
 *   **完全独立的两份实现，互不 require、互不影响。**
 *   Windows 那份一行都没动；本文件只服务 macOS（含 Apple Silicon 与 Intel）。
 *
 * 为什么不直接在原文件里加 if (darwin) 分支：
 *   用户明确要求「单独做一个苹果一键启动，不要改动原有的 WIN 代码」。
 *   加分支意味着动 win32 的执行路径，回归风险不可控；
 *   独立成文件后，mac 逻辑出问题也绝不会连带影响 Windows 那台机器。
 *
 * 与 Windows 版的差异（本文件已处理）：
 *   1. cloudflared 二进制定位/下载 → darwin-arm64 / darwin-amd64 的 .tgz（不是 .exe）
 *   2. 进程发现用 `ps -eo pid=,args=`（原 tunnelCore.js 已实现，直接复用）
 *   3. 终止进程用 SIGTERM → 等 → SIGKILL（不像 Windows 有 taskkill /F）
 *   4. 开机自启 → 原生 launchd plist（~/Library/LaunchAgents），非 Startup 夹的 vbs
 *   5. 路径分隔与权限：下载后必须 chmod +x
 *
 * 配置读取逻辑（profile / 凭据路径 / runtime 产物命名）与 Windows 版保持
 * **逐字一致**，这样同一个项目文件夹在 win / mac 之间来回拷贝时，
 * deploy/ 与 runtime/ 里的结构完全对齐，不会出现「这台认不出那台配的域名」。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const tun = require('./tunnelCore');

const ROOT = path.resolve(__dirname, '..');
const RUN_DIR = path.join(ROOT, '.run');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const CF_DIR = path.join(RUNTIME_DIR, 'cloudflared');
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const PROFILES_DIR = path.join(DEPLOY_DIR, 'profiles');
const CONFIG_PATH = path.join(DEPLOY_DIR, 'tunnel.config.json');
const BUNDLE_DIR = path.join(DEPLOY_DIR, 'cloudflared');
const DEFAULT_PROFILE = 'default';
const METRICS_PORT_BASE = 20241;

/** launchd 服务标签：同一台 mac 上装多个域名时，每个 profile 一个 label */
const LAUNCHD_LABEL_BASE = 'icu.dimeifeishudayin.feishuprint';
const LAUNCHD_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

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

function chmodX(file) {
  try {
    fs.chmodSync(file, 0o755);
  } catch (e) {
    /* 权限设置失败不致命，后续会以「能否执行」为最终判据 */
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return 0;
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
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

/* ----------------------------------------------------- 多固定域名（profile） */

/** profile 名的合法字符集（与 Windows 版同一套规则，防止目录穿越） */
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

/** 某个 profile 的配置与凭据落点（默认 profile 用历史路径，与 Windows 对齐） */
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
      return;
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

function pickMetricsPort(taken) {
  const used = new Set((taken || []).map((n) => Number(n)));
  let p = METRICS_PORT_BASE;
  while (used.has(p)) p += 1;
  return p;
}

/** 「上次用的域名」——与 Windows 版共用同一份 runtime/active-profile.txt */
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
    /* 记不住不影响本次使用 */
  }
}

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

  // 凭据在项目内的绝对路径（随文件夹移动自动跟着变）——mac 上同样是 ~/.cloudflared
  cfg.bundledCredentials = cfg.credentialsFile
    ? path.join(paths.bundleDir, path.basename(cfg.credentialsFile))
    : '';
  cfg.bundledCert = cfg.certFile ? path.join(paths.bundleDir, path.basename(cfg.certFile)) : '';
  cfg.userCfDir = path.join(os.homedir(), '.cloudflared');
  cfg.userCredentials = cfg.tunnelId ? path.join(cfg.userCfDir, cfg.tunnelId + '.json') : '';
  cfg.userConfig = path.join(cfg.userCfDir, 'config.yml');

  // ---- 运行时产物按 profile 隔离（命名规则与 Windows 版逐字一致）----
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

/** 本机架构：返回 'arm64' 或 'amd64'（cloudflared 官方包的命名口径） */
function cfArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

function cfBinaryName() {
  return 'cloudflared';
}

function findCloudflared(cfg) {
  const exe = cfBinaryName();
  // 1) 环境变量显式指定
  const override = process.env.CLOUDFLARED_PATH;
  if (override && fs.existsSync(override)) return override;
  // 2) 随项目携带 / 自动下载的（换机器时最可靠，优先于系统安装）
  const local = path.join(CF_DIR, exe);
  if (fs.existsSync(local) && fs.statSync(local).isFile()) return local;
  // 3) 系统安装（tunnelCore 已覆盖 PATH / /usr/local/bin / /opt/homebrew/bin 等）
  return tun.findCloudflared();
}

/**
 * cloudflared 下载地址候选表（按顺序尝试，第一个成功即用）。
 *
 * macOS 官方发布物是 .tgz（内含不分层的 cloudflared 可执行文件），
 * 与 Windows 的 .exe 不同，所以解包逻辑也单独写在 ensureCloudflared 里。
 */
function cloudflaredDownloadUrls() {
  const override = String(process.env.CLOUDFLARED_DL_URL || '').trim();
  if (override) return [override];
  const asset = 'cloudflared-darwin-' + cfArch() + '.tgz';
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset;
  return [
    base,
    'https://gh-proxy.com/' + base,
    'https://ghproxy.net/' + base,
    'https://ghfast.top/' + base,
  ];
}

/** 下载文件到本地，跟随 30x 跳转，带简单进度提示（与 Windows 版同实现） */
function download(url, dest, opts) {
  const options = opts || {};
  const https = require('https');
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
                  if (total && received !== total) {
                    throw new Error('下载不完整（' + received + '/' + total + ' 字节）');
                  }
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

/**
 * 解包 darwin .tgz。
 * 优先用系统自带的 tar（macOS 10.6+ 一直有 bsdtar），不引入任何 npm 依赖；
 * 解出来的 cloudflared 是单个可执行文件，chmod +x 后直接可用。
 */
function extractTgz(tgzPath, destDir, destName) {
  ensureDir(destDir);
  const tmpDir = tgzPath + '.x';
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    ensureDir(tmpDir);
    execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'ignore', timeout: 120000 });

    // tgz 里通常是平铺的单个 cloudflared，也可能带一层目录，两种都兼容
    const found = findFileDeep(tmpDir, destName, 3);
    if (!found) throw new Error('解包后没有找到 ' + destName);

    const dest = path.join(destDir, destName);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.copyFileSync(found, dest);
    chmodX(dest);
    return dest;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      /* 清理失败无所谓 */
    }
  }
}

function findFileDeep(dir, filename, depth) {
  if (depth <= 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === filename) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findFileDeep(path.join(dir, e.name), filename, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 找不到 cloudflared 时自动下载到 runtime/cloudflared/（macOS 分支） */
async function ensureCloudflared(cfg, opts) {
  const options = opts || {};
  const found = findCloudflared(cfg);
  if (found) return { path: found, downloaded: false };

  if (process.platform !== 'darwin') {
    const err = new Error(
      '本模块只服务 macOS。Windows 请用 server/namedTunnelCore.js（走 deploy.bat）。',
    );
    err.code = 'WRONG_PLATFORM';
    throw err;
  }

  const dest = path.join(CF_DIR, cfBinaryName());

  // 离线优先：项目里可能已经带了 mac 版二进制（从旧 mac 拷过来），findCloudflared 已覆盖。
  // 这里再兜一层：有些包会把 tgz 一起带过来，直接解包即可。
  const bundledTgz = path.join(CF_DIR, 'cloudflared-darwin-' + cfArch() + '.tgz');
  if (fs.existsSync(bundledTgz)) {
    if (options.log) options.log('发现项目内自带的 cloudflared 压缩包，正在解包…');
    extractTgz(bundledTgz, CF_DIR, cfBinaryName());
    if (fs.existsSync(dest)) return { path: dest, downloaded: false };
  }

  if (options.download === false) {
    const err = new Error('未找到 cloudflared，且已禁用自动下载');
    err.code = 'NO_CLOUDFLARED';
    throw err;
  }

  if (options.log) {
    options.log('未检测到 cloudflared，正在下载（' + cfArch() + ' 版，约 20MB，仅首次需要）…');
  }

  const urls = cloudflaredDownloadUrls();
  const tgzPath = path.join(CF_DIR, 'cloudflared-darwin-' + cfArch() + '.tgz');
  const failures = [];
  let ok = false;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    if (options.log && i > 0) {
      options.log('  直连失败，改用镜像 ' + i + '/' + (urls.length - 1) + '：' + url);
    }
    try {
      await download(url, tgzPath, {
        onProgress: (got, total) => {
          if (!options.log) return;
          const mb = (n) => (n / 1048576).toFixed(1);
          options.log(total ? `  下载中 ${mb(got)} / ${mb(total)} MB` : `  下载中 ${mb(got)} MB`);
        },
      });
      ok = true;
      break;
    } catch (e) {
      failures.push(url + ' -> ' + e.message);
      if (options.log) options.log('  失败：' + e.message);
    }
  }

  if (!ok) {
    const err = new Error(
      'cloudflared 下载失败，已试过 ' + failures.length + ' 个地址：\n  ' + failures.join('\n  ') +
      '\n\n可手动解决（任选其一）：\n' +
      '  1) 从能上网的电脑下载 cloudflared-darwin-' + cfArch() + '.tgz，放到：\n' +
      '     ' + CF_DIR + '\n' +
      '     然后重新双击「一键部署.command」\n' +
      '  2) 用 Homebrew 安装：brew install cloudflared（会自动被识别）\n' +
      '  3) 指定可用镜像后重试：\n' +
      '     export CLOUDFLARED_DL_URL=https://你的镜像/cloudflared-darwin-' + cfArch() + '.tgz\n' +
      '     ./deploy-mac.sh',
    );
    err.code = 'CLOUDFLARED_DOWNLOAD_FAILED';
    throw err;
  }
  if (fileSize(tgzPath) < 5 * 1024 * 1024) {
    const err = new Error(
      '下载到的 cloudflared 体积异常（' + fileSize(tgzPath) + ' 字节），请手动把 cloudflared 放到 ' + CF_DIR,
    );
    err.code = 'CLOUDFLARED_TOO_SMALL';
    throw err;
  }

  if (options.log) options.log('  正在解包…');
  extractTgz(tgzPath, CF_DIR, cfBinaryName());
  try {
    fs.unlinkSync(tgzPath);
  } catch (e) {
    /* 留着也无害 */
  }

  if (!fs.existsSync(dest)) {
    const err = new Error('解包后未找到可执行文件：' + dest);
    err.code = 'CLOUDFLARED_EXTRACT_FAILED';
    throw err;
  }
  chmodX(dest);
  return { path: dest, downloaded: true };
}

/* ------------------------------------------------------------ 凭据与配置 */

function buildConfigYml(cfg, credentialsPath) {
  // 与 Windows 版完全一致的写法：必须写 127.0.0.1，不能写 localhost。
  // dev server 监听 0.0.0.0（仅 IPv4），cloudflared 解析 localhost 时可能优先拿到
  // ::1，于是随机出现 "dial tcp [::1]:5173: connect: connection refused" 502。
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
      '\n  请把整个 deploy/cloudflared/ 目录一并复制过来（Windows 那份可以直接用，凭据是跨平台通用的）。',
    );
    err.code = 'NO_CREDENTIALS';
    throw err;
  }

  // 1) 隧道密钥 json —— 内容不同才覆盖
  const src = readText(cfg.bundledCredentials);
  if (readText(cfg.userCredentials) !== src) {
    fs.copyFileSync(cfg.bundledCredentials, cfg.userCredentials);
    try {
      fs.chmodSync(cfg.userCredentials, 0o600); // 密钥文件收紧权限
    } catch (e) {
      /* ignore */
    }
    actions.push('已安装隧道密钥 → ' + cfg.userCredentials);
  }

  // 2) 令牌（cert.pem）—— 只在缺失时补，绝不覆盖已有的真证书
  const userCert = path.join(cfg.userCfDir, 'cert.pem');
  if (cfg.bundledCert && fs.existsSync(cfg.bundledCert) && !fs.existsSync(userCert)) {
    fs.copyFileSync(cfg.bundledCert, userCert);
    actions.push('已安装隧道令牌 → ' + userCert);
  }

  // 3) config.yml
  // 项目内那份永远按本机路径渲染 —— 启动时用 --config 显式指定，不依赖任何全局状态。
  const yml = buildConfigYml(cfg, cfg.userCredentials);
  if (readText(cfg.runtimeConfig) !== yml) {
    writeText(cfg.runtimeConfig, yml);
    actions.push('已生成项目内配置 → ' + cfg.runtimeConfig);
  }

  // 用户目录那份是「全局单例」，同机多域名时必然互相覆盖。
  // 所以只有默认 profile 才维护它；其它 profile 一律只靠项目内的 --config。
  let ours = true;
  if (cfg.profile !== DEFAULT_PROFILE) {
    ours = false;
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

  return {
    actions,
    userConfig: cfg.userConfig,
    runtimeConfig: cfg.runtimeConfig,
    skipUserConfig: !ours,
  };
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

  // 状态文件里记的 PID 仍然活着（且确实是 cloudflared）→ 认它
  const st = readJsonSafe(cfg.stateFile, {});
  if (st.pid && all.some((p) => p.pid === st.pid)) mine.push(st.pid);

  // 兜底：整机只有一个 cloudflared 且命令行读不出来 → 认定就是我们的
  if (!mine.length && all.length === 1 && !all[0].cmd) mine.push(all[0].pid);

  return { pids: [...new Set(mine)], all };
}

function saveState(cfg, patch) {
  ensureDir(RUN_DIR);
  const next = Object.assign(readJsonSafe(cfg.stateFile, {}), patch, {
    updatedAt: new Date().toISOString(),
  });
  if (!next.createdAt) next.createdAt = next.updatedAt;
  writeText(cfg.stateFile, JSON.stringify(next, null, 2));
  return next;
}

/* ---------------------------------------------------------------- 启停主流程 */

async function probeReady(cfg) {
  return httpGetStatus('http://127.0.0.1:' + cfg.metricsPort + '/ready', 2500);
}

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

/**
 * 等某个本地端口彻底释放。
 * 旧隧道刚被 SIGTERM 掉的那几秒，监听端口可能还占着；此时启动 cloudflared 会
 * 「bind 失败 → 立刻退出」，既白等一轮，又会被误判成「这种写法连不上边缘」。
 */
function waitPortFree(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + Number(timeoutMs || 30000);
    const tryOnce = () => {
      const srv = net.createServer();
      srv.once('error', () => {
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(tryOnce, 500);
      });
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    };
    tryOnce();
  });
}

/**
 * 用户级 config.yml 是否真的能撑起「兼容写法」（不带 --config 直接 run）。
 * 必须同时满足：文件存在、有 ingress、且确实是本隧道/本域名。
 */
function hasUsableUserConfig(cfg) {
  const txt = readText(cfg.userConfig);
  if (!txt || txt.indexOf('ingress') === -1) return false;
  return txt.indexOf(String(cfg.hostname || '')) !== -1 ||
    txt.indexOf(String(cfg.tunnelName || '')) !== -1;
}

async function startNamedTunnel(cfg, opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const cf = await ensureCloudflared(cfg, { download: options.download, log });

  ensureDir(RUN_DIR);
  const { pids } = findNamedTunnelPids(cfg);
  const ready = pids.length ? await probeReady(cfg) : null;

  // 已在跑且边缘已连上 → 什么都不用做
  if (pids.length && ready === 200 && !options.force) {
    return { started: false, reused: true, pid: pids[0], exe: cf.path, readyStatus: ready };
  }

  if (pids.length) {
    log('收掉旧的隧道进程（PID ' + pids.join(', ') + '）…');
    await killPidsGraceful(pids);
  }

  const runArg = cfg.tunnelName || cfg.tunnelId;
  const common = [
    '--protocol', cfg.protocol || 'http2',
    '--edge-ip-version', String(cfg.edgeIpVersion || '4'),
    '--metrics', '127.0.0.1:' + cfg.metricsPort,
    '--pidfile', cfg.pidFile,
  ];
  const projectArgs = ['tunnel', '--config', cfg.runtimeConfig].concat(common, ['run', runArg]);

  // 先试项目内配置（换机器后不依赖任何全局状态）
  const plan = [{ label: '项目内配置', args: projectArgs }];

  // 兼容写法不带 ingress，只有用户级 config.yml 真能用时才有意义
  if (hasUsableUserConfig(cfg)) {
    plan.push({ label: '兼容模式', args: ['tunnel'].concat(common, ['run', runArg]) });
  } else {
    log('用户级 config.yml 不可用，跳过兼容模式（避免得到一条没有 ingress 的隧道）');
  }

  // 项目内配置失败多半是端口没释放 / 时序问题，重试一次比降级可靠
  plan.push({ label: '项目内配置(重试)', args: projectArgs });

  const waitMs = Number(options.waitMs || 75000);
  let lastStatus = null;

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const freed = await waitPortFree(cfg.metricsPort, 30000);
    if (!freed) log('注意：metrics 端口 ' + cfg.metricsPort + ' 仍被占用，仍尝试启动…');
    log('启动隧道（' + step.label + '）：' + path.basename(cf.path) + ' ' + step.args.join(' '));
    const child = spawnTunnel(cf.path, step.args, cfg);
    lastStatus = await waitTunnelReady(cfg, child, waitMs);
    if (lastStatus === 200) {
      saveState(cfg, {
        pid: child.pid,
        url: cfg.fixedUrl,
        source: 'named',
        configMode: step.label,
      });
      return {
        started: true,
        reused: false,
        pid: child.pid,
        exe: cf.path,
        readyStatus: lastStatus,
        configMode: step.label,
      };
    }
    await killPidsGraceful(child.pid ? [child.pid] : []);
    if (i < plan.length - 1) log('该写法未连上边缘（/ready=' + lastStatus + '），换下一种写法重试…');
  }

  const err = new Error('隧道启动后未能连上 Cloudflare 边缘（/ready=' + lastStatus + '）');
  err.code = 'TUNNEL_NOT_READY';
  err.detail = readText(cfg.errFile).split('\n').slice(-10).join('\n');
  throw err;
}

/**
 * macOS 优雅终止：先 SIGTERM 给 5 秒收尾，仍存活再 SIGKILL。
 * （Windows 版是 taskkill /T /F 一步到位；这里保留优雅退出的机会，
 *   因为 cloudflared 收到 SIGTERM 会主动注销到边缘的连接，重启更快。）
 */
async function killPidsGraceful(pids) {
  let killed = 0;
  for (const pid of pids) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killed += 1;
    } catch (e) {
      /* 进程可能已经没了 */
    }
  }
  if (killed) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const alive = pids.filter((p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch (e) {
          return false;
        }
      });
      if (!alive.length) break;
      await sleep(400);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        /* 已退出 */
      }
    }
  }
  return killed;
}

async function stopNamedTunnel(cfg) {
  const { pids } = findNamedTunnelPids(cfg);
  const killed = await killPidsGraceful(pids);
  const next = saveState(cfg, {
    pid: 0,
    source: killed ? 'stopped' : readJsonSafe(cfg.stateFile, {}).source || '',
  });
  return {
    ok: true,
    killed,
    pids,
    state: next,
    message: killed
      ? '已停止固定域名隧道（PID ' + pids.join(', ') + '）'
      : '固定域名隧道本来就没在跑',
  };
}

/* -------------------------------------------------- 开机自启（launchd 原生） */

/**
 * launchd 服务标签。每个 profile 一个，互不干扰。
 * 用反序域名风格（icu.xxx.feishuprint.<profile>）——launchd 惯例。
 */
function launchdLabel(profile) {
  const p = safeProfileName(profile);
  return p === DEFAULT_PROFILE ? LAUNCHD_LABEL_BASE : LAUNCHD_LABEL_BASE + '.' + p;
}

function launchdFile(profile) {
  return path.join(LAUNCHD_DIR, launchdLabel(profile) + '.plist');
}

/**
 * 自启的落点：deploy-mac.sh（bash 入口）。
 * 与 Windows 的 vbs 语义完全一致 —— 都是「静默拉起、不弹窗、不阻塞登录」。
 */
function autostartLauncher() {
  return path.join(ROOT, 'deploy-mac.sh');
}

/**
 * 渲染 plist。
 *
 * 关键点：
 *   - RunAtLoad=true  → 登录即拉起
 *   - KeepAlive      → 进程意外退出（比如断网重连失败）自动重来，
 *                      这是 launchd 相对 vbs 的优势：vbs 拉起就不管了
 *   - StandardOut/ErrPath → 日志落到 .run/，与手动部署同一套排查路径
 *   - 显式带上 --profile，与 Windows vbs 同样「锁定域名」
 *
 * 注意 Bash 用 /bin/bash 的绝对路径，PATH 里塞上 Homebrew 的两个标准位置
 * （launchd 的环境极简，不写清楚会找不到 brew 装的 node / cloudflared）。
 */
function buildPlist(cfg) {
  const launcher = autostartLauncher();
  const outLog = path.join(RUN_DIR, 'launchd.out.log');
  const errLog = path.join(RUN_DIR, 'launchd.err.log');
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xml(launchdLabel(cfg.profile)) + '</string>',
    '',
    '  <!-- 由「一键部署.command」自动生成：登录 macOS 后静默拉起 dev server + 固定域名隧道 -->',
    '  <!-- 绑定域名：' + xml(cfg.fixedUrl) + '（域名标识 profile=' + xml(cfg.profile) + '） -->',
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/bash</string>',
    '    <string>' + xml(launcher) + '</string>',
    '    <string>--silent</string>',
    '    <string>--autostart</string>',
    '    <string>--profile</string>',
    '    <string>' + xml(cfg.profile) + '</string>',
    '  </array>',
    '',
    '  <key>WorkingDirectory</key>',
    '  <string>' + xml(ROOT) + '</string>',
    '',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    '    <key>PORT</key>',
    '    <string>' + xml(String(cfg.port)) + '</string>',
    '  </dict>',
    '',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '',
    '  <key>StandardOutPath</key>',
    '  <string>' + xml(outLog) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + xml(errLog) + '</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function launchdLoaded(label) {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 10000 });
    return out.split('\n').some((l) => l.split('\t').some((c) => c.trim() === label));
  } catch (e) {
    return false;
  }
}

function autostartStatus(cfg) {
  const file = launchdFile(cfg.profile);
  const exists = fs.existsSync(file);
  let boundProfile = '';
  if (exists) {
    const txt = readText(file);
    const m = txt.match(/<string>--profile<\/string>\s*<string>([A-Za-z0-9._-]+)<\/string>/);
    boundProfile = m ? m[1] : DEFAULT_PROFILE;
  }
  return {
    enabled: exists,
    loaded: exists ? launchdLoaded(launchdLabel(cfg.profile)) : false,
    file,
    label: launchdLabel(cfg.profile),
    launcher: autostartLauncher(),
    profile: boundProfile,
    mechanism: 'launchd',
  };
}

function autostartEnable(cfg) {
  const launcher = autostartLauncher();
  if (!fs.existsSync(launcher)) {
    const err = new Error('找不到启动脚本：' + launcher);
    err.code = 'NO_LAUNCHER';
    throw err;
  }
  ensureDir(LAUNCHD_DIR);
  ensureDir(RUN_DIR);
  chmodX(launcher);
  writeText(launchdFile(cfg.profile), buildPlist(cfg));

  // 先 bootout 再 bootstrap：幂等，重复部署不会因为「已在运行」而失败。
  // launchctl 在现代 macOS（10.10+）上都有，旧写法 load/unload 已废弃但仍可用，
  // 这里两种都试一遍，以最终「load 成功」为准。
  const label = launchdLabel(cfg.profile);
  const plist = launchdFile(cfg.profile);
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const domain = 'gui/' + uid;

  safeExec('launchctl', ['bootout', domain + '/' + label]);
  const r = safeExec('launchctl', ['bootstrap', domain, plist]);
  if (r.ok) {
    safeExec('launchctl', ['enable', domain + '/' + label]);
  } else {
    // 老系统 / 非 gui session 兜底
    safeExec('launchctl', ['unload', plist]);
    safeExec('launchctl', ['load', plist]);
  }

  return autostartStatus(cfg);
}

function autostartDisable(cfg) {
  const file = launchdFile(cfg.profile);
  const label = launchdLabel(cfg.profile);
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  safeExec('launchctl', ['bootout', 'gui/' + uid + '/' + label]);
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

/** 跑一条命令但绝不让它抛异常（自启注册失败不该中断整个部署） */
function safeExec(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
    platform: 'darwin',
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
  LAUNCHD_DIR,
  LAUNCHD_LABEL_BASE,
  safeProfileName,
  profilePaths,
  listProfiles,
  pickMetricsPort,
  ACTIVE_PROFILE_FILE,
  readActiveProfile,
  writeActiveProfile,
  loadConfig,
  cfArch,
  findCloudflared,
  ensureCloudflared,
  extractTgz,
  installCredentials,
  buildConfigYml,
  findNamedTunnelPids,
  probeReady,
  probeFixed,
  startNamedTunnel,
  stopNamedTunnel,
  killPidsGraceful,
  launchdLabel,
  launchdFile,
  buildPlist,
  autostartLauncher,
  autostartEnable,
  autostartDisable,
  autostartStatus,
  status,
  saveState,
  readJsonSafe,
  download,
  writeText,
  ensureDir,
  chmodX,
  sleep,
};
