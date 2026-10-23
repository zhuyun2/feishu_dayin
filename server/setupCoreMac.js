#!/usr/bin/env node
'use strict';
/**
 * ============================================================
 * 一键部署编排 · macOS 版（固定域名）
 * ============================================================
 * 与 server/setupCore.js（Windows 版）的关系：
 *   **完全独立的两份实现，互不 require 对方的可变部分。**
 *   Windows 那一行都没改；本文件只服务 macOS。
 *
 * 它对应 Windows 的 deploy.bat → server/setupCore.js 这条链路：
 *   ├─ 命令行入口：deploy-mac.sh（bash，含便携 Node 定位）
 *   └─ 双击入口：  一键部署.command（双击即开终端跑 deploy-mac.sh）
 *
 * 执行顺序（每一步幂等，重复跑不会破坏现状）：
 *   1. 读 deploy/tunnel.config.json（隧道名 / 域名 / 端口 / 凭据路径）
 *   2. 确保 cloudflared 存在（runtime/ → PATH/HOMEBREW → 下载 darwin tgz）
 *   3. 安装隧道凭据到 ~/.cloudflared/，并按本机绝对路径渲染 config.yml
 *   4. 确保 npm 依赖（node_modules/webpack-cli 缺失才装）
 *   5. 确保 dev server 在 :5173（没跑就拉起来）
 *   6. 启动命名隧道，等到 /ready 200
 *   7. 公网回连校验（固定域名必须能探到本机的 instanceId）
 *   8. 注册 launchd 登录自启（可用 --no-autostart 跳过）
 *
 * 命令行（与 Windows 版逐字对齐，脚本可互换）：
 *   node server/setupCoreMac.js deploy          一键部署（默认命令）
 *   node server/setupCoreMac.js status          查看状态
 *   node server/setupCoreMac.js doctor          体检（新电脑排错用）
 *   node server/setupCoreMac.js stop            停隧道（dev server 不动）
 *   node server/setupCoreMac.js restart         重启隧道
 *   node server/setupCoreMac.js url             只打印固定域名
 *   node server/setupCoreMac.js autostart on|off
 *   node server/setupCoreMac.js profiles        列出已配置的域名
 *
 * 选项：--json | --silent | --no-download | --no-autostart | --force | --profile <标识>
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const tun = require('./tunnelCore');
const named = require('./namedTunnelCoreMac');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ 输出 */

function makeLogger(opts) {
  const silent = !!opts.silent;
  const json = !!opts.json;
  const lines = [];
  const say = (msg) => {
    const s = String(msg == null ? '' : msg);
    lines.push(s);
    if (!silent && !json) process.stdout.write(s + '\n');
  };
  return {
    say,
    step: (msg) => say('  · ' + msg),
    ok: (msg) => say('  ✓ ' + msg),
    warn: (msg) => say('  ! ' + msg),
    section: (title) => say('\n' + title),
    lines,
  };
}

const HR = '─'.repeat(60);

/* ------------------------------------------------------------ CLI 解析 */

function parseArgs(argv) {
  // 扁平结构：业务代码直接读 opts.silent / opts.download，不再套一层 flags
  const out = {
    command: 'deploy',
    autostartOpt: '',
    profile: '',
    args: [],
    json: false,
    silent: false,
    download: true,
    autostart: true,
    force: false,
    fromLogin: false,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--profile' || a === '-p') {
      out.profile = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (a.indexOf('--profile=') === 0) {
      out.profile = a.slice('--profile='.length).trim();
    } else if (a === '--json') out.json = true;
    else if (a === '--silent') out.silent = true;
    else if (a === '--autostart') out.fromLogin = true;
    else if (a === '--no-download') out.download = false;
    else if (a === '--no-autostart') out.autostart = false;
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  if (rest.length) {
    out.command = String(rest[0]).toLowerCase();
    out.autostartOpt = String(rest[1] || '').toLowerCase();
    out.args = rest.slice(1);
  }
  return out;
}

/* ---------------------------------------------------------- 依赖自检 */

function findNpm() {
  const exeDir = path.dirname(process.execPath);
  const cands = [
    path.join(exeDir, 'npm'),
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* ignore */
    }
  }
  return 'npm';
}

function depsReady() {
  // webpack-cli 是 dev server 的唯一入口；它在了就认为依赖齐了
  return fs.existsSync(path.join(ROOT, 'node_modules', 'webpack-cli', 'bin', 'cli.js'));
}

function ensureDependencies(log, opts) {
  if (depsReady()) return { installed: false, message: '依赖已就绪' };
  if (opts.download === false) {
    const err = new Error('缺少 npm 依赖且已禁用联网安装。请在项目目录执行：npm install');
    err.code = 'NO_DEPS';
    throw err;
  }
  log.step('缺少 npm 依赖（node_modules），正在 npm install（首次约 1-3 分钟）…');
  const npm = findNpm();
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (r.error || r.status !== 0) {
    const err = new Error(
      'npm install 失败（exit=' + (r.status == null ? 'spawn-error' : r.status) + '）' +
      (r.error ? '：' + r.error.message : '') +
      '\n  也可以从另一台电脑把 node_modules 目录复制过来（CPU 架构不同时不要复制，需重装）。',
    );
    err.code = 'NPM_FAILED';
    throw err;
  }
  if (!depsReady()) {
    const err = new Error('npm install 结束，但 node_modules/webpack-cli 仍不存在');
    err.code = 'NPM_INCOMPLETE';
    throw err;
  }
  return { installed: true, message: '依赖安装完成' };
}

/* ------------------------------------------------- 登录自启前的网络等待 */

const NET_PROBES = [
  { host: 'api.cloudflare.com', port: 443, label: 'Cloudflare API' },
  { host: '223.5.5.5', port: 443, label: '公共 DNS' },
];

/**
 * 登录自启专用：mac 刚唤醒 / 刚连 Wi-Fi 时网络常常还没就绪。
 * 此时直接起隧道，cloudflared 会连不上边缘，结果是「进程在跑、但固定域名打不开」。
 * 探测用 TCP 直连 443（不依赖 ICMP）。
 */
async function waitForNetwork(cfg, log, maxWaitMs) {
  const probes = [{ host: cfg.hostname, port: 443, label: '本机固定域名' }].concat(NET_PROBES);
  const deadline = Date.now() + (maxWaitMs || 90000);
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    for (let i = 0; i < probes.length; i += 1) {
      const p = probes[i];
      // eslint-disable-next-line no-await-in-loop
      if (await tun.tcpPing(p.port, p.host, 4000)) {
        log.step('网络已就绪（' + p.label + ' 可达，第 ' + attempt + ' 次探测）');
        return true;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await named.sleep(5000);
  }
  log.warn('等待网络超时（' + attempt + ' 次探测均失败），仍继续尝试；若失败请稍后重新运行「一键部署.command」');
  return false;
}

/* ------------------------------------------- 多个固定域名的选择（profile） */

const ACTIVE_PROFILE_FILE = named.ACTIVE_PROFILE_FILE;
const readActiveProfile = named.readActiveProfile;
const writeActiveProfile = named.writeActiveProfile;

function defaultProfile(opts) {
  return (opts && opts.profile) || readActiveProfile() || named.DEFAULT_PROFILE;
}

function requireProfile(opts) {
  const all = named.listProfiles();
  const want = defaultProfile(opts);
  if (!all.length) return want;
  if (all.filter((p) => p.profile === want)[0]) return want;
  if (opts && opts.profile) {
    const err = new Error(
      '找不到域名标识「' + want + '」。已配置的有：' + all.map((p) => p.profile).join('、') +
      '\n  查看列表：./deploy-mac.sh profiles　新增：见 README「新增固定域名」',
    );
    err.code = 'NO_PROFILE';
    throw err;
  }
  return all[0].profile;
}

/**
 * 只有在「人正坐在电脑前」时才允许提问。
 * launchd 自启 / --silent / --json / 被管道调用 一律不许弹 —— 否则会静默卡死。
 */
function canPrompt(opts) {
  return !opts.silent && !opts.json && !opts.fromLogin && !!process.stdin.isTTY;
}

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (buf.indexOf('\n') >= 0) {
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(buf.trim());
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function resolveProfile(opts, log) {
  const profiles = named.listProfiles();

  if (opts.profile) {
    const hit = profiles.filter((p) => p.profile === opts.profile)[0];
    if (!hit) {
      const err = new Error(
        '找不到域名标识「' + opts.profile + '」。已配置的有：' +
        (profiles.map((p) => p.profile).join('、') || '（无）'),
      );
      err.code = 'NO_PROFILE';
      throw err;
    }
    return hit.profile;
  }

  if (profiles.length === 0) return named.DEFAULT_PROFILE;
  if (profiles.length === 1) return profiles[0].profile;

  const fallback = requireProfile(opts);
  if (!canPrompt(opts)) return fallback;

  const fallbackIndex = Math.max(1, profiles.findIndex((p) => p.profile === fallback) + 1);
  log.say('');
  log.say('检测到 ' + profiles.length + ' 个固定域名，请选择本次要部署的：');
  profiles.forEach((p, i) => {
    const mark = p.profile === fallback ? '   ← 上次用的' : '';
    log.say('  ' + (i + 1) + ') ' + p.profile + '　' + p.fixedUrl + mark);
  });
  const answer = await ask('输入序号（直接回车 = ' + fallbackIndex + '）: ');
  const n = parseInt(answer, 10);
  const picked = n >= 1 && n <= profiles.length ? profiles[n - 1].profile : fallback;
  log.say('已选择：' + picked + '　' + (profiles.filter((p) => p.profile === picked)[0] || {}).fixedUrl);
  return picked;
}

/* ------------------------------------------------------------ 主流程 */

async function cmdDeploy(opts, log) {
  log.say('飞书打印插件 · 一键部署（macOS · 固定域名）');
  log.say(HR);

  const profile = await resolveProfile(opts, log);
  const cfg = named.loadConfig(profile);
  if (!cfg.tunnelId) {
    const err = new Error('域名「' + profile + '」的配置里没有 tunnelId：' + cfg.configPath);
    err.code = 'BAD_CONFIG';
    throw err;
  }

  log.say('域名标识：' + cfg.profile + (cfg.profile === named.DEFAULT_PROFILE ? '（默认）' : ''));
  log.say('目标域名：' + cfg.fixedUrl);
  log.say('项目目录：' + ROOT);
  log.say('本机架构：darwin-' + named.cfArch() + '（' + process.arch + '）');

  if (opts.fromLogin) {
    log.section('[0/6] 等待网络');
    await waitForNetwork(cfg, log);
  }

  log.section('[1/6] 运行环境');
  log.ok('Node.js ' + process.version + '（' + process.execPath + '）');

  const cf = await named.ensureCloudflared(cfg, { download: opts.download, log: log.step });
  log.ok('cloudflared：' + cf.path + (cf.downloaded ? '（本次自动下载）' : ''));

  log.section('[2/6] 隧道凭据');
  const cred = named.installCredentials(cfg, { quiet: opts.silent });
  if (cred.actions.length) cred.actions.forEach((a) => log.ok(a));
  else log.ok('凭据与配置已是最新，无需改动');

  log.section('[3/6] 项目依赖');
  const deps = ensureDependencies(log, opts);
  log.ok(deps.message);

  log.section('[4/6] 本地服务');
  const server = await tun.ensureDevServer(cfg.port, { waitMs: 150000 });
  log.ok(server.message);

  log.section('[5/6] 隧道');
  const started = await named.startNamedTunnel(cfg, {
    download: opts.download,
    force: opts.force,
    log: log.step,
  });
  log.ok(started.reused
    ? '隧道已在运行且已连上 Cloudflare 边缘（PID ' + started.pid + '），无需重启'
    : '隧道已启动（PID ' + started.pid + '，/ready=200）');

  log.section('[6/6] 公网校验');
  let healthy = false;
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    healthy = !!(await named.probeFixed(cfg, 8000));
    if (healthy) break;
    // eslint-disable-next-line no-await-in-loop
    await named.sleep(3000);
  }
  if (healthy) log.ok('公网访问正常，域名已回连到本机服务');
  else log.warn('公网地址暂时探测不通（DNS 或边缘可能还在生效），稍等 1 分钟再试；也可跑 doctor 排查');

  // 自启（launchd）
  let autostart = named.autostartStatus(cfg);
  if (opts.autostart !== false && cfg.startAtLogin !== false) {
    try {
      autostart = named.autostartEnable(cfg);
      log.ok('已注册 launchd 登录自启（重启电脑后自动生效，绑定域名 ' + cfg.profile + '）');
    } catch (e) {
      log.warn('注册自启失败（不影响本次使用）：' + e.message);
    }
  }

  writeActiveProfile(cfg.profile);

  const summary = {
    ok: healthy,
    platform: 'darwin',
    mode: 'named-tunnel',
    profile: cfg.profile,
    fixedUrl: cfg.fixedUrl,
    hostname: cfg.hostname,
    port: cfg.port,
    devServer: server,
    tunnel: started,
    credentials: cred.actions,
    autostart: {
      enabled: !!autostart.enabled,
      file: autostart.file,
      label: autostart.label,
      profile: autostart.profile,
    },
    fixedUrlHealthy: healthy,
  };

  if (!opts.silent && !opts.json) {
    const allProfiles = named.listProfiles();
    log.say('\n' + HR);
    log.say('固定域名（填进飞书插件的「插件地址」，永久不变）：');
    log.say('');
    log.say('   ' + cfg.fixedUrl);
    log.say('');
    if (allProfiles.length > 1) {
      log.say('域名标识：' + cfg.profile + '　（本机已配 ' + allProfiles.length + ' 个域名，' +
        '换域名：./deploy-mac.sh profiles 查看，或 ./deploy-mac.sh --profile <标识>）');
    }
    log.say('本机管理页：' + cfg.localOrigin + '/deploy');
    log.say('开机自启：' + (autostart.enabled ? '已开启（launchd）' : '未开启'));
    log.say(HR);
    log.say(healthy ? '结论：部署完成，可以直接用了。' : '结论：服务已起来，但公网校验未通过，请稍后重试或跑 doctor。');
  }
  return summary;
}

async function cmdStatus(opts) {
  const st = await named.status(named.loadConfig(requireProfile(opts)));
  if (opts.json) return st;
  const log = makeLogger(opts);
  const dot = (b) => (b ? '正常' : '异常');
  log.say('飞书打印插件 · 状态（macOS）');
  log.say(HR);
  log.say('域名标识      ' + (st.profile || named.DEFAULT_PROFILE));
  log.say('固定域名      ' + st.fixedUrl + '  → ' + dot(st.fixedUrlHealthy));
  log.say('本地服务      ' + st.localOrigin + '  → ' + dot(st.devServerUp));
  log.say('cloudflared   ' + (st.cloudflared.found ? st.cloudflared.path : '未找到') +
    '  运行中=' + st.cloudflared.running +
    '  /ready=' + (st.cloudflared.readyStatus == null ? '—' : st.cloudflared.readyStatus));
  log.say('隧道凭据      项目内=' + dot(st.credentials.bundled) + '  已安装=' + dot(st.credentials.installed));
  log.say('登录自启      ' + (st.autostart.enabled ? '已开启（launchd）' : '未开启') +
    (st.autostart.enabled ? '  loaded=' + st.autostart.loaded : ''));
  if (!st.fixedUrlHealthy) log.say('\n提示：跑 `./deploy-mac.sh deploy` 可一键恢复。');
  return st;
}

async function cmdDoctor(opts) {
  const cfg = named.loadConfig(requireProfile(opts));
  const log = makeLogger(opts);
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log.say('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '　' + detail : ''));
  };

  log.say('飞书打印插件 · 部署体检（macOS）');
  log.say(HR);
  log.say('  域名标识　' + cfg.profile + '　' + (cfg.fixedUrl || '（未配置域名）'));
  log.say('  本机架构　darwin-' + named.cfArch() + '（' + process.arch + '）');
  add('配置文件', !!cfg.tunnelId, path.relative(ROOT, cfg.configPath) + ' → ' + (cfg.tunnelId || '缺失 tunnelId'));
  add('隧道密钥（项目内）', fs.existsSync(cfg.bundledCredentials), cfg.bundledCredentials);
  add('隧道密钥（已安装）', fs.existsSync(cfg.userCredentials), cfg.userCredentials);
  const cf = named.findCloudflared(cfg);
  add('cloudflared', !!cf, cf || '未找到（deploy 会自动下载）');
  add('npm 依赖', depsReady(), depsReady() ? 'node_modules 就绪' : '缺失（deploy 会自动 npm install）');

  const listening = await tun.isPortListening(cfg.port);
  add('端口 ' + cfg.port + ' 监听', listening, listening ? '有人监听' : '无人监听（deploy 会拉起 dev server）');

  const localProbe = await tun.probeLocal(cfg.localOrigin, 5000);
  const isOurs = !!(localProbe && localProbe.status === 200 &&
    localProbe.json && localProbe.json.instanceId === tun.instanceId());
  add('端口是本项目服务', isOurs, isOurs ? 'instanceId 匹配' : '不是本项目的 dev server，或服务未就绪');

  const { pids, all } = named.findNamedTunnelPids(cfg);
  add('隧道进程', pids.length > 0, pids.length ? 'PID ' + pids.join(', ') : '未运行');
  if (all.length > pids.length) {
    log.warn('检测到 ' + (all.length - pids.length) + ' 个不属于本项目的 cloudflared（不会被误杀）');
  }
  const ready = pids.length ? await named.probeReady(cfg) : null;
  add('隧道已连边缘', ready === 200, '/ready=' + (ready == null ? '—' : ready));

  const fixed = await named.probeFixed(cfg, 8000);
  add('固定域名回连本机', !!fixed, fixed ? 'instanceId 匹配' : '探测失败或不是本机');

  const auto = named.autostartStatus(cfg);
  const autoMismatch = !!(auto.enabled && auto.profile && auto.profile !== cfg.profile);
  add('登录自启（launchd）', !!auto.enabled,
    auto.file + (autoMismatch
      ? '　⚠ 但自启绑的是「' + auto.profile + '」，与当前「' + cfg.profile + '」不一致（再跑一次 deploy 即可纠正）'
      : ''));

  const failed = checks.filter((c) => !c.ok);
  log.say('\n' + HR);
  log.say(failed.length
    ? '有 ' + failed.length + ' 项未通过：' + failed.map((f) => f.name).join('、')
    : '全部通过，部署是健康的。');
  if (failed.length) log.say('修复：双击「一键部署.command」，或 `./deploy-mac.sh deploy`。');

  return { ok: failed.length === 0, checks };
}

async function cmdStop(opts) {
  const cfg = named.loadConfig(requireProfile(opts));
  const r = await named.stopNamedTunnel(cfg);
  if (opts.json) return r;
  makeLogger(opts).say(r.message);
  return r;
}

async function cmdRestart(opts, log) {
  const profile = await resolveProfile(opts, log);
  const cfg = named.loadConfig(profile);
  log.step('停止现有隧道（' + profile + '）…');
  await named.stopNamedTunnel(cfg);
  await named.sleep(1500);
  return cmdDeploy(Object.assign({}, opts, { force: true, profile }), log);
}

function cmdAutostart(opts, log) {
  const cfg = named.loadConfig(requireProfile(opts));
  const on = opts.autostartOpt !== 'off';
  if (opts.autostartOpt !== 'on' && opts.autostartOpt !== 'off') {
    const st = named.autostartStatus(cfg);
    log.say('登录自启：' + (st.enabled ? '已开启' : '未开启') + '　' + st.file);
    log.say('机制：launchd（' + st.label + '）');
    log.say('用法：autostart on | autostart off');
    return st;
  }
  if (on) {
    const st = named.autostartEnable(cfg);
    log.say('已开启登录自启：登录 macOS 后由 launchd 自动拉起本地服务与隧道');
    log.say('  ' + st.file);
    return st;
  }
  const st = named.autostartDisable(cfg);
  log.say(st.removed ? '已关闭登录自启' : '登录自启本来就是关的');
  return st;
}

/* ------------------------------------------------- 列出固定域名 */

function cmdProfiles(opts) {
  const profiles = named.listProfiles();
  const active = readActiveProfile();
  if (opts.json) return { profiles, active };
  const log = makeLogger(opts);
  log.say('飞书打印插件 · 已配置的固定域名');
  log.say(HR);
  if (!profiles.length) {
    log.say('（还没有任何域名配置）');
    return { profiles, active };
  }
  profiles.forEach((p, i) => {
    const marks = [];
    if (p.profile === active) marks.push('当前');
    if (p.isDefault) marks.push('默认');
    log.say('  ' + (i + 1) + ') ' + p.profile + '　' + p.fixedUrl +
      (marks.length ? '　[' + marks.join(' / ') + ']' : ''));
  });
  log.say('');
  log.say('部署指定域名：./deploy-mac.sh --profile <标识>');
  log.say('部署时选择：  双击「一键部署.command」（多域名时会弹菜单）');
  return { profiles, active };
}

function printHelp() {
  process.stdout.write(
    [
      '用法：node server/setupCoreMac.js <命令> [选项]',
      '',
      '命令：',
      '  deploy                    一键部署（默认）',
      '  status                    查看状态',
      '  doctor                    部署体检（新电脑排错用）',
      '  stop                      停隧道（不影响 dev server）',
      '  restart                   重启隧道',
      '  url                       只打印当前固定域名',
      '  profiles                  列出已配置的固定域名',
      '  autostart on|off          开/关登录自启（launchd）',
      '',
      '选项：',
      '  --profile <标识>  指定用哪个固定域名（多域名时必须；自启用它锁定）',
      '  --json            机器可读输出',
      '  --silent          精简输出（自启用）',
      '  --no-download     禁止联网下载',
      '  --no-autostart    不注册登录自启',
      '  --force           强制重启隧道',
      '',
      '日常入口：双击「一键部署.command」，或 ./deploy-mac.sh',
      '',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ 入口 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = makeLogger(opts);

  if (opts.help) {
    printHelp();
    return 0;
  }

  try {
    let result;
    switch (opts.command) {
      case 'deploy':
        result = await cmdDeploy(opts, log);
        break;
      case 'status':
        result = await cmdStatus(opts);
        break;
      case 'doctor':
        result = await cmdDoctor(opts);
        break;
      case 'stop':
        result = await cmdStop(opts);
        break;
      case 'restart':
        result = await cmdRestart(opts, log);
        break;
      case 'url': {
        const cfg = named.loadConfig(requireProfile(opts));
        result = { ok: true, url: cfg.fixedUrl, profile: cfg.profile };
        if (!opts.json) process.stdout.write(cfg.fixedUrl + '\n');
        break;
      }
      case 'profiles':
      case 'list-domains':
        result = cmdProfiles(opts);
        break;
      case 'autostart':
        result = cmdAutostart(opts, log);
        break;
      default:
        process.stderr.write('未知命令：' + opts.command + '\n');
        printHelp();
        return 2;
    }
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result && result.ok === false && opts.command === 'deploy') return 1;
    return 0;
  } catch (e) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(
        { ok: false, code: e.code || 'FAILED', message: e.message }, null, 2,
      ) + '\n');
    } else {
      process.stderr.write('\n[错误] ' + e.message + '\n');
      if (e.detail) process.stderr.write('\n--- 进程输出末尾 ---\n' + e.detail + '\n');
    }
    return 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write('\n[未捕获错误] ' + (e && e.stack ? e.stack : e) + '\n');
      process.exit(1);
    },
  );
}

module.exports = {
  main,
  parseArgs,
  makeLogger,
  cmdDeploy,
  cmdStatus,
  cmdDoctor,
  cmdStop,
  cmdRestart,
  cmdAutostart,
  ensureDependencies,
  depsReady,
  findNpm,
};
