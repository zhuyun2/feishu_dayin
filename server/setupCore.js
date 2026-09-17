#!/usr/bin/env node
'use strict';
/**
 * ============================================================
 * 一键部署编排（固定域名）
 * ============================================================
 * 目标：把整个项目文件夹复制到任意一台 Windows 电脑，双击「一键部署.bat」，
 *       自动补齐所有依赖并直接把固定域名隧道拉起来 —— 不需要浏览器授权、不需要改配置。
 *
 * 执行顺序（每一步都幂等，重复跑不会破坏现状）：
 *   1. 读 deploy/tunnel.config.json（隧道名 / 域名 / 端口 / 凭据路径）
 *   2. 确保 cloudflared.exe 存在（runtime/ → 系统 PATH → 自动下载）
 *   3. 安装隧道凭据到 ~/.cloudflared/，并按本机绝对路径渲染 config.yml
 *   4. 确保 npm 依赖（node_modules/webpack-cli 缺失才装）
 *   5. 确保 dev server 在 :5173（没跑就拉起来）
 *   6. 启动命名隧道，等到 /ready 200（已连上 Cloudflare 边缘）
 *   7. 公网回连校验（固定域名必须能探到本机的 instanceId）
 *   8. 注册登录自启（可用 --no-autostart 跳过）
 *
 * 命令行：
 *   node server/setupCore.js deploy          一键部署（默认命令）
 *   node server/setupCore.js status          查看状态
 *   node server/setupCore.js doctor          体检（新电脑排错用）
 *   node server/setupCore.js stop            停隧道（dev server 不动）
 *   node server/setupCore.js restart         重启隧道
 *   node server/setupCore.js url             只打印固定域名（脚本取值用）
 *   node server/setupCore.js autostart on|off  开/关开机自启
 *
 * 选项：--json 机器可读输出 | --silent 精简输出 | --no-download 禁止联网下载
 *       --no-autostart 不注册自启 | --force 强制重启隧道
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const tun = require('./tunnelCore');
const named = require('./namedTunnelCore');
// 只给 add-domain 用；日常部署不依赖网络 API（令牌失效也不影响已配好的域名）。
// 刻意不叫 cf：cmdDeploy 里有个局部变量就叫 cf（cloudflared 路径），别互相遮蔽。
const cfApi = require('./cloudflareApi');

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
  // 扁平结构：下面的业务代码直接读 opts.silent / opts.download，不要再套一层 flags，
  // 否则形如 --no-download 的开关会静默失效（曾经踩过）。
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
      // 带值选项：必须把下一个参数吃掉，绝不能让它掉进 rest ——
      // 否则「域名标识」会被当成命令名，部署直接跑到别的分支去。
      out.profile = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (a.indexOf('--profile=') === 0) {
      out.profile = a.slice('--profile='.length).trim();
    } else if (a === '--json') out.json = true;
    else if (a === '--silent') out.silent = true;
    else if (a === '--autostart') out.fromLogin = true; // 登录自启脚本传入的标记，仅作标识
    else if (a === '--no-download') out.download = false;
    else if (a === '--no-autostart') out.autostart = false;
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  if (rest.length) {
    out.command = String(rest[0]).toLowerCase();
    out.autostartOpt = String(rest[1] || '').toLowerCase();
    out.args = rest.slice(1); // add-domain 之类需要位置参数
  }
  return out;
}

/* ---------------------------------------------------------- 依赖自检 */

function findNpm() {
  const exeDir = path.dirname(process.execPath);
  const cands =
    process.platform === 'win32'
      ? [path.join(exeDir, 'npm.cmd'), path.join(exeDir, 'npm')]
      : [path.join(exeDir, 'npm'), '/usr/local/bin/npm', '/usr/bin/npm'];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* ignore */
    }
  }
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
      '\n  也可以直接从旧电脑把 node_modules 目录复制过来，跳过这一步。',
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

/**
 * 登录自启专用：Windows 刚登录时网络（尤其 Wi-Fi / 需要网页认证的网络）常常还没就绪。
 * 此时直接起隧道，cloudflared 会连不上 Cloudflare 边缘，结果是「进程在跑、
 * 但固定域名打不开」的假成功 —— 而这恰恰是重启后最想避免的情况。
 *
 * 所以先等外网通了再继续。探测用 TCP 直连 443（不依赖 ICMP，很多内网屏蔽 ping）。
 * 注意**不要**用 1.1.1.1 做探针：这个地址在国内网络经常不可达，
 * 会白白等满超时。这里优先探本机自己的固定域名 —— 它本身就是 CDN 边缘，
 * 能连上就说明「到 Cloudflare 的通路」是通的，正是 cloudflared 需要的东西。
 */
const NET_PROBES = [
  { host: 'api.cloudflare.com', port: 443, label: 'Cloudflare API' },
  { host: '223.5.5.5', port: 443, label: '公共 DNS' },
];

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
  log.warn('等待网络超时（' + attempt + ' 次探测均失败），仍继续尝试；若失败请稍后双击「一键部署.bat」');
  return false;
}

/* ------------------------------------------- 多个固定域名的选择（profile） */

// 「上次用的是哪个域名」这份本地状态统一由 namedTunnelCore 维护，
// 让命令行与 /deploy 管理页共用一份，避免两边各记一套而对不上。
const ACTIVE_PROFILE_FILE = named.ACTIVE_PROFILE_FILE;
const readActiveProfile = named.readActiveProfile;
const writeActiveProfile = named.writeActiveProfile;

/** 优先级：命令行 --profile > 上次用的 > 默认 profile */
function defaultProfile(opts) {
  return (opts && opts.profile) || readActiveProfile() || named.DEFAULT_PROFILE;
}

/**
 * 取一个「确实存在」的域名标识。
 *  - 命令行显式指定的标识不存在 → 直接报错（不能默默给你部署到别的域名上）；
 *  - 只是「上次用的那个」被删了 → 退回第一个可用域名，免得命令行被卡死。
 */
function requireProfile(opts) {
  const all = named.listProfiles();
  const want = defaultProfile(opts);
  if (!all.length) return want;
  if (all.filter((p) => p.profile === want)[0]) return want;
  if (opts && opts.profile) {
    const err = new Error(
      '找不到域名标识「' + want + '」。已配置的有：' + all.map((p) => p.profile).join('、') +
      '\n  查看列表：deploy.bat profiles　新增：deploy.bat add-domain <标识> <域名>',
    );
    err.code = 'NO_PROFILE';
    throw err;
  }
  return all[0].profile;
}

/**
 * 只有在「人正坐在电脑前」时才允许提问。
 * 登录自启 / --silent / --json / 被管道调用 一律不许弹 ——
 * 自启是无交互的，一旦在这里等输入就会静默卡死到超时。
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

/**
 * 定下本次部署哪个域名：
 *   - 只有一个域名 → 直接用（保持「一键」体验，不打扰）；
 *   - 多个且能交互 → 列菜单让用户选，默认选上次用过的；
 *   - 多个但不能交互（自启/静默） → 用 --profile 或上次用过的，绝不等待输入。
 */
async function resolveProfile(opts, log) {
  const profiles = named.listProfiles();

  if (opts.profile) {
    const hit = profiles.filter((p) => p.profile === opts.profile)[0];
    if (!hit) {
      const err = new Error(
        '找不到域名标识「' + opts.profile + '」。已配置的有：' +
        (profiles.map((p) => p.profile).join('、') || '（无）') +
        '\n  新增：deploy.bat add-domain <标识> <域名>　查看：deploy.bat profiles',
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

  const fallbackIndex = Math.max(
    1,
    profiles.findIndex((p) => p.profile === fallback) + 1,
  );
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
  log.say('飞书打印插件 · 一键部署（固定域名）');
  log.say(HR);

  // 先定下这次部署哪个域名（机器上只有一个时不会打扰用户）
  const profile = await resolveProfile(opts, log);
  const cfg = named.loadConfig(profile);
  if (!cfg.tunnelId) {
    const err = new Error(
      '域名「' + profile + '」的配置里没有 tunnelId：' + cfg.configPath,
    );
    err.code = 'BAD_CONFIG';
    throw err;
  }

  log.say('域名标识：' + cfg.profile + (cfg.profile === named.DEFAULT_PROFILE ? '（默认）' : ''));
  log.say('目标域名：' + cfg.fixedUrl);
  log.say('项目目录：' + ROOT);

  // 登录自启（由 Startup 里的 vbs 以 --autostart 触发）时，先等网络再拉服务。
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
    healthy = !!(await named.probeFixed(cfg, 8000));
    if (healthy) break;
    await named.sleep(3000);
  }
  if (healthy) log.ok('公网访问正常，域名已回连到本机服务');
  else log.warn('公网地址暂时探测不通（DNS 或边缘可能还在生效），稍等 1 分钟再试；也可跑 doctor 排查');

  // 自启
  let autostart = named.autostartStatus(cfg);
  if (opts.autostart !== false && cfg.startAtLogin !== false) {
    try {
      autostart = named.autostartEnable(cfg);
      log.ok('已注册登录自启（重启电脑后自动生效，绑定域名 ' + cfg.profile + '）');
    } catch (e) {
      log.warn('注册自启失败（不影响本次使用）：' + e.message);
    }
  }

  // 记住本次域名，下次部署同机默认还用它（多域名机器上省一次选择）
  writeActiveProfile(cfg.profile);

  const summary = {
    ok: healthy,
    mode: 'named-tunnel',
    profile: cfg.profile,
    fixedUrl: cfg.fixedUrl,
    hostname: cfg.hostname,
    port: cfg.port,
    devServer: server,
    tunnel: started,
    credentials: cred.actions,
    autostart: { enabled: !!autostart.enabled, file: autostart.file, profile: autostart.profile },
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
        '换域名：deploy.bat profiles 查看，或 deploy.bat --profile <标识>）');
    }
    log.say('本机管理页：' + cfg.localOrigin + '/deploy');
    log.say('开机自启：' + (autostart.enabled ? '已开启' : '未开启'));
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
  log.say('飞书打印插件 · 状态');
  log.say(HR);
  log.say('域名标识      ' + (st.profile || named.DEFAULT_PROFILE));
  log.say('固定域名      ' + st.fixedUrl + '  → ' + dot(st.fixedUrlHealthy));
  log.say('本地服务      ' + st.localOrigin + '  → ' + dot(st.devServerUp));
  log.say('cloudflared   ' + (st.cloudflared.found ? st.cloudflared.path : '未找到') +
    '  运行中=' + st.cloudflared.running + '  /ready=' + (st.cloudflared.readyStatus == null ? '—' : st.cloudflared.readyStatus));
  log.say('隧道凭据      项目内=' + dot(st.credentials.bundled) + '  已安装=' + dot(st.credentials.installed));
  log.say('开机自启      ' + (st.autostart.enabled ? '已开启' : '未开启'));
  if (!st.fixedUrlHealthy) log.say('\n提示：跑 `node server/setupCore.js deploy` 可一键恢复。');
  return st;
}

/**
 * 问 Cloudflare 侧要这条隧道当前的连接器条数。
 *
 * 为什么必须查这一项：同一条隧道被两台电脑同时连上时，Cloudflare 会把请求
 * **随机分给两台机器**（每条连接都有机会被选中）。症状是「时好时坏、间歇 502、
 * 打印出来的模板对不上」——而在本机看什么都是正常的，本地根本发现不了。
 * 拿不到令牌 / 断网时返回 skipped，不算失败，doctor 依然可以离线跑。
 */
async function connectorCount(cfg) {
  try {
    const cfApi = require('./cloudflareApi');
    const certPath = cfg.bundledCert && fs.existsSync(cfg.bundledCert)
      ? cfg.bundledCert
      : path.join(cfg.userCfDir, 'cert.pem');
    if (!fs.existsSync(certPath)) return { skipped: true, reason: '没有 cert.pem' };
    const tok = cfApi.parseCertToken(certPath);
    if (!tok || !tok.apiToken || !tok.accountID) return { skipped: true, reason: '令牌解析失败' };
    const list = await cfApi.listTunnels(tok.apiToken, tok.accountID);
    const hit = (list || []).filter((t) => t.id === cfg.tunnelId)[0];
    if (!hit) return { skipped: true, reason: 'Cloudflare 侧找不到这条隧道' };
    return { count: (hit.connections || []).length, status: hit.status };
  } catch (e) {
    return { skipped: true, reason: '联网查询失败' };
  }
}

async function cmdDoctor(opts) {
  const cfg = named.loadConfig(requireProfile(opts));
  const log = makeLogger(opts);
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log.say('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '　' + detail : ''));
  };

  log.say('飞书打印插件 · 部署体检');
  log.say(HR);
  log.say('  域名标识　' + cfg.profile + '　' + (cfg.fixedUrl || '（未配置域名）'));
  add('配置文件', !!cfg.tunnelId, path.relative(ROOT, cfg.configPath) + ' → ' + (cfg.tunnelId || '缺失 tunnelId'));
  add('隧道密钥（项目内）', fs.existsSync(cfg.bundledCredentials), cfg.bundledCredentials);
  add('隧道密钥（已安装）', fs.existsSync(cfg.userCredentials), cfg.userCredentials);
  const cf = named.findCloudflared(cfg);
  add('cloudflared', !!cf, cf || '未找到（deploy 会自动下载）');
  add('npm 依赖', depsReady(), depsReady() ? 'node_modules 就绪' : '缺失（deploy 会自动 npm install）');

  const listening = await tun.isPortListening(cfg.port);
  add('端口 ' + cfg.port + ' 监听', listening, listening ? '有人监听' : '无人监听（deploy 会拉起 dev server）');

  const localProbe = await tun.probeLocal(cfg.localOrigin, 5000);
  const isOurs = !!(localProbe && localProbe.status === 200 && localProbe.json && localProbe.json.instanceId === tun.instanceId());
  add('端口是本项目服务', isOurs, isOurs ? 'instanceId 匹配' : '不是本项目的 dev server，或服务未就绪');

  const { pids, all } = named.findNamedTunnelPids(cfg);
  add('隧道进程', pids.length > 0, pids.length ? 'PID ' + pids.join(', ') : '未运行');
  if (all.length > pids.length) log.warn('检测到 ' + (all.length - pids.length) + ' 个不属于本项目的 cloudflared（不会被误杀）');
  const ready = pids.length ? await named.probeReady(cfg) : null;
  add('隧道已连边缘', ready === 200, '/ready=' + (ready == null ? '—' : ready));

  // 一个连接器 = 4 条连接。超过 4 条说明这条隧道上还挂着别的机器。
  const conns = await connectorCount(cfg);
  if (conns.skipped) {
    log.say('  – 连接器数量　跳过（' + conns.reason + '）');
  } else {
    const dup = conns.count > 4;
    add('连接器数量', !dup,
      conns.count + ' 条连接' + (dup
        ? '　⚠ 这台隧道上还有别的电脑也在连（应该有 ' + (conns.count / 4) + ' 台）。' +
          'Cloudflare 会把请求随机分给它们，症状是间歇 502 / 数据对不上。' +
          '请在多余的那台电脑上执行：deploy.bat stop --profile ' + cfg.profile
        : '（单机正常）'));
  }

  const fixed = await named.probeFixed(cfg, 8000);
  add('固定域名回连本机', !!fixed, fixed ? 'instanceId 匹配' : '探测失败或不是本机');

  const auto = named.autostartStatus(cfg);
  // 自启绑的域名和当前域名不一致是很隐蔽的坑：登录后拉起来的是「另一个域名」，
  // 表面上服务在跑，但你以为的那个地址是 502。这里直接点出来。
  const autoMismatch = !!(auto.enabled && auto.profile && auto.profile !== cfg.profile);
  add('开机自启', !!auto.enabled,
    auto.file + (autoMismatch
      ? '　⚠ 但自启绑的是「' + auto.profile + '」，与当前「' + cfg.profile + '」不一致（再跑一次 deploy 即可纠正）'
      : ''));

  const failed = checks.filter((c) => !c.ok);
  log.say('\n' + HR);
  log.say(failed.length ? '有 ' + failed.length + ' 项未通过：' + failed.map((f) => f.name).join('、')
    : '全部通过，部署是健康的。');
  if (failed.length) log.say('修复：双击「一键部署.bat」，或 `node server/setupCore.js deploy`。');

  return { ok: failed.length === 0, checks };
}

function cmdStop(opts) {
  const cfg = named.loadConfig(requireProfile(opts));
  const r = named.stopNamedTunnel(cfg);
  if (opts.json) return r;
  makeLogger(opts).say(r.message);
  return r;
}

async function cmdRestart(opts, log) {
  // 先把域名定下来再停：否则可能出现「停了 A 域名、却又部署了 B 域名」，
  // 多域名机器上这种错位很难查。
  const profile = await resolveProfile(opts, log);
  const cfg = named.loadConfig(profile);
  log.step('停止现有隧道（' + profile + '）…');
  named.stopNamedTunnel(cfg);
  await named.sleep(1500);
  return cmdDeploy(Object.assign({}, opts, { force: true, profile }), log);
}

function cmdAutostart(opts, log) {
  const cfg = named.loadConfig(requireProfile(opts));
  const on = opts.autostartOpt !== 'off';
  if (opts.autostartOpt !== 'on' && opts.autostartOpt !== 'off') {
    // 不带参数就报告当前状态，不猜用户意图
    const st = named.autostartStatus(cfg);
    log.say('开机自启：' + (st.enabled ? '已开启' : '未开启') + '　' + st.file);
    log.say('用法：autostart on | autostart off');
    return st;
  }
  if (on) {
    const st = named.autostartEnable(cfg);
    log.say('已开启开机自启：登录 Windows 后自动拉起本地服务与隧道');
    log.say('  ' + st.file);
    return st;
  }
  const st = named.autostartDisable(cfg);
  log.say(st.removed ? '已关闭开机自启' : '开机自启本来就是关的');
  return st;
}

/* ------------------------------------------------- 列出 / 新增固定域名 */

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
  log.say('部署指定域名：deploy.bat --profile <标识>');
  log.say('部署时选择：  双击「一键部署.bat」（多域名时会弹菜单）');
  log.say('新增域名：    deploy.bat add-domain <标识> <完整域名>');
  return { profiles, active };
}

/** 找一份可用的 ARGO TUNNEL TOKEN（cert.pem）：默认域名优先，其次任意 profile */
function findCertFile() {
  const dirs = [named.BUNDLE_DIR];
  named.listProfiles().forEach((p) => {
    const dir = p.isDefault ? named.BUNDLE_DIR : path.join(named.PROFILES_DIR, p.profile, 'cloudflared');
    if (dirs.indexOf(dir) < 0) dirs.push(dir);
  });
  for (let i = 0; i < dirs.length; i += 1) {
    const f = path.join(dirs[i], 'cert.pem');
    if (fs.existsSync(f)) return f;
  }
  return '';
}

/**
 * 自动新增一个固定域名：建隧道 + 配 DNS + 落盘配置，全程不需要去 Cloudflare 后台点。
 * 失败时抛出可读错误，调用方负责提示「可改用手动创建」。
 */
async function cmdAddDomain(opts, log) {
  const profile = String(opts.args[0] || '').trim();
  const hostname = String(opts.args[1] || '').trim().toLowerCase();
  if (!profile || !hostname) {
    log.say('用法：deploy.bat add-domain <域名标识> <完整域名>');
    log.say('例如：deploy.bat add-domain print2 print2.dimeifeishudayin.icu');
    log.say('（域名标识是给机器看的短名，也是 deploy/profiles/ 下的目录名）');
    return { ok: false, reason: 'MISSING_ARGS' };
  }

  const safeProfile = named.safeProfileName(profile); // 非法名在这一步就拦住
  const all = named.listProfiles();

  const dupProfile = all.filter((p) => p.profile === safeProfile)[0];
  if (dupProfile) {
    log.warn('域名标识「' + safeProfile + '」已存在（' + dupProfile.fixedUrl + '），不重复创建。');
    log.say('  如需改域名，请手工编辑：' + dupProfile.configPath);
    return { ok: false, reason: 'PROFILE_EXISTS' };
  }
  const dupHost = all.filter((p) => p.hostname === hostname)[0];
  if (dupHost) {
    log.warn('域名 ' + hostname + ' 已属于标识「' + dupHost.profile + '」，不重复创建。');
    return { ok: false, reason: 'HOSTNAME_EXISTS' };
  }

  log.section('[1/4] 读取 Cloudflare 令牌');
  const certFile = findCertFile();
  if (!certFile) {
    const err = new Error('找不到 cert.pem（ARGO TUNNEL TOKEN），无法自动建隧道。可在 Cloudflare 后台手动创建后把凭据放进 deploy/profiles/。');
    err.code = 'NO_CERT';
    throw err;
  }
  const tok = cfApi.parseCertToken(certFile);
  log.ok('令牌来源：' + path.relative(ROOT, certFile));
  const verified = await cfApi.verifyToken(tok.apiToken);
  log.ok('令牌有效（' + ((verified && verified.status) || 'active') + '）');
  const zone = await cfApi.getZone(tok.apiToken, tok.zoneID);
  const zoneName = zone && zone.name;
  log.ok('域名 zone：' + zoneName);
  if (!zoneName || hostname.indexOf('.' + zoneName) < 0) {
    const err = new Error(
      '新域名必须是 ' + zoneName + ' 的子域（例如 print2.' + zoneName + '），收到：' + hostname,
    );
    err.code = 'BAD_HOSTNAME';
    throw err;
  }

  log.section('[2/4] 创建隧道');
  const paths = named.profilePaths(safeProfile);
  const secret = cfApi.newTunnelSecret();
  let tunnel;
  try {
    tunnel = await cfApi.createTunnel(tok.apiToken, tok.accountID, safeProfile, secret, true);
  } catch (e) {
    // 个别 API 版本不认 config_src，去掉再试一次（我们要的就是「配置在本地」）
    log.step('首次创建未通过（' + e.message + '），去掉 config_src 重试…');
    tunnel = await cfApi.createTunnel(tok.apiToken, tok.accountID, safeProfile, secret, false);
  }
  log.ok('隧道已创建：' + tunnel.id + '（名称 ' + tunnel.name + '）');

  named.ensureDir(paths.bundleDir);
  const credFile = path.join(paths.bundleDir, tunnel.id + '.json');
  named.writeText(credFile, JSON.stringify({
    AccountTag: tok.accountID,
    TunnelSecret: secret,
    TunnelID: tunnel.id,
    Endpoint: '',
  }));
  log.ok('凭据已写入：' + path.relative(ROOT, credFile));

  const certDst = path.join(paths.bundleDir, 'cert.pem');
  if (!fs.existsSync(certDst)) {
    fs.copyFileSync(certFile, certDst);
    log.ok('令牌已复制：' + path.relative(ROOT, certDst));
  }

  const metricsPort = named.pickMetricsPort(all.map((p) => p.metricsPort));
  const cfgObj = {
    tunnelName: safeProfile,
    tunnelId: tunnel.id,
    hostname,
    fixedUrl: 'https://' + hostname,
    port: 5173,
    credentialsFile: 'cloudflared/' + tunnel.id + '.json',
    certFile: 'cloudflared/cert.pem',
    protocol: 'http2',
    edgeIpVersion: '4',
    metricsPort,
    startAtLogin: true,
  };
  named.writeText(paths.configPath, JSON.stringify(cfgObj, null, 2) + '\n');
  log.ok('域名配置已写入：' + path.relative(ROOT, paths.configPath));
  log.ok('metrics 端口：' + metricsPort + '（与其它域名错开，同机并存也不打架）');

  log.section('[3/4] 配置 DNS');
  const target = tunnel.id + '.cfargotunnel.com';
  const rec = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 };
  const found = await cfApi.listDnsRecords(tok.apiToken, tok.zoneID, hostname);
  if (found && found.length) {
    const r = await cfApi.updateDnsRecord(tok.apiToken, tok.zoneID, found[0].id, rec);
    log.ok('DNS 已更新：' + r.name + ' → ' + target);
  } else {
    const r = await cfApi.createDnsRecord(tok.apiToken, tok.zoneID, rec);
    log.ok('DNS 已创建：' + r.name + ' → ' + target);
  }

  log.section('[4/4] 完成');
  log.say('\n' + HR);
  log.say('新域名已就绪：https://' + hostname);
  log.say('');
  log.say('部署它（在那台电脑上）：');
  log.say('   双击「一键部署.bat」，菜单里选 ' + safeProfile);
  log.say('   或命令行：deploy.bat --profile ' + safeProfile);
  log.say(HR);
  return { ok: true, profile: safeProfile, hostname, tunnelId: tunnel.id, metricsPort };
}

function printHelp() {
  process.stdout.write(
    [
      '用法：node server/setupCore.js <命令> [选项]',
      '',
      '命令：',
      '  deploy                    一键部署（默认）',
      '  status                    查看状态',
      '  doctor                    部署体检（新电脑排错用）',
      '  stop                      停隧道（不影响 dev server）',
      '  restart                    重启隧道',
      '  url                       只打印当前固定域名',
      '  profiles                  列出已配置的固定域名',
      '  add-domain <标识> <域名>   新增一个固定域名（自动建隧道 + 配 DNS）',
      '  autostart on|off          开/关开机自启',
      '',
      '选项：',
      '  --profile <标识>  指定用哪个固定域名（多域名时必须；自启用它锁定）',
      '  --json            机器可读输出',
      '  --silent          精简输出（自启用）',
      '  --no-download     禁止联网下载',
      '  --no-autostart    不注册开机自启',
      '  --force           强制重启隧道',
      '',
      '多域名用法：',
      '  deploy.bat profiles                          看有哪些域名',
      '  deploy.bat --profile print2                  部署指定域名',
      '  deploy.bat add-domain print2 print2.xxx.icu  新增一个域名',
      '  双击「一键部署.bat」时，若配了多个域名会弹菜单让你选',
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
        result = cmdStop(opts);
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
      case 'add-domain':
      case 'add':
        result = await cmdAddDomain(opts, log);
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
      process.stdout.write(JSON.stringify({ ok: false, code: e.code || 'FAILED', message: e.message }, null, 2) + '\n');
    } else {
      process.stderr.write('\n[错误] ' + e.message + '\n');
      if (e.detail) process.stderr.write('\n--- 进程输出末尾 ---\n' + e.detail + '\n');
    }
    return 1;
  }
}

// 被 require（dev server 的 /api/setup/* 复用同一套流程）时不要自动执行
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
