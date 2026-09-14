#!/usr/bin/env node
'use strict';
/**
 * ============================================================
 * feishuprint 内网穿透 · 命令行工具
 * ============================================================
 * 它就是「一键部署」本尊 —— 逻辑与 dev server 的 /api/tunnel/* 完全同源
 * （共用 server/tunnelCore.js），**不依赖 dev server 是否在跑**。
 *
 * 什么时候用它：
 *   断网 / 隔夜之后内网穿透地址失效、飞书里插件打不开时，
 *   在跑服务这台电脑上跑一次，就能拿到当下可用的穿透地址。
 *   默认**复用上一次的地址**（地址没失效就不会换，飞书插件配置不用改）。
 *
 * 用法：
 *   node tunnel.js                 一键部署（等价 deploy）
 *   node tunnel.js deploy          同上；先确保本地服务在跑，再复用/生成穿透地址
 *   node tunnel.js new             强制重新生成地址（地址必变，需更新飞书插件配置）
 *   node tunnel.js status          查看隧道 / 地址 / 进程状态
 *   node tunnel.js url             只输出当前地址（便于脚本取值）
 *   node tunnel.js stop            停止隧道（只停本项目的 cloudflared）
 *
 * 选项：
 *   --port <n>      指定端口（默认 5173，或环境变量 PORT）
 *   --no-server     不要把本地 dev server 拉起来（只处理隧道）
 *   --json          以 JSON 输出（便于二次处理）
 *   --quiet         只输出地址
 *   --timeout <s>   等待 dev server 启动的上限秒数（默认 150）
 *
 * 也可直接双击仓库根目录的「一键部署.bat」（= deploy，跑完窗口保留）。
 * ============================================================
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('./server/tunnelCore');

const LINE = '='.repeat(60);
const THIN = '-'.repeat(60);

/**
 * 控制台输出同时留一份到 .run/tunnel-cli.log。
 * 双击 bat 时窗口可能一闪而过/被关掉，日志能保住现场用于排查。
 */
const LOG_FILE = path.join(__dirname, '.run', 'tunnel-cli.log');
(function installTee() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(
      LOG_FILE,
      '\n===== ' + new Date().toISOString() + '  argv: ' + process.argv.slice(2).join(' ') +
        '   node: ' + process.version + '   execPath: ' + process.execPath + ' =====\n',
    );
  } catch (e) {
    return; // 日志不可写不影响主流程
  }
  const wrap = (original) =>
    function tee() {
      original.apply(console, arguments);
      try {
        const line = Array.prototype.map
          .call(arguments, (a) => (typeof a === 'string' ? a : String(a)))
          .join(' ')
          .replace(/\u001b\[[0-9;]*m/g, '');
        fs.appendFileSync(LOG_FILE, line + '\n');
      } catch (e) {
        /* ignore */
      }
    };
  console.log = wrap(console.log);
  console.error = wrap(console.error);
})();

function parseArgs(argv) {
  const out = { command: '', port: 0, noServer: false, json: false, quiet: false, timeout: 0, help: false };
  const commands = ['deploy', 'start', 'restart', 'new', 'force', 'status', 'url', 'stop', 'help'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      out.port = Number(argv[i + 1]);
      i += 1;
    } else if (a.startsWith('--port=')) {
      out.port = Number(a.split('=')[1]);
    } else if (a === '--no-server') {
      out.noServer = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--quiet' || a === '-q') {
      out.quiet = true;
    } else if (a === '--timeout') {
      out.timeout = Number(argv[i + 1]) * 1000;
      i += 1;
    } else if (a.startsWith('--timeout=')) {
      out.timeout = Number(a.split('=')[1]) * 1000;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (!a.startsWith('-') && !out.command) {
      out.command = a.toLowerCase();
    }
  }
  if (!out.command) out.command = 'deploy';
  if (out.command === 'start' || out.command === 'restart') out.command = 'deploy';
  if (out.command === 'force') out.command = 'new';
  if (commands.indexOf(out.command) === -1) {
    console.error('[错误] 未知命令：' + out.command);
    console.error('可用：deploy / new / status / url / stop');
    out.command = '';
  }
  return out;
}

/**
 * 统一退出方式：设置 exitCode 后 return，由 Node 自然收敛。
 * 直接 process.exit() 在 stdout 接管道（如 `node tunnel.js url > a.txt`）时可能截断输出。
 */
function done(code) {
  process.exitCode = code;
}

function printHelp() {
  console.log(LINE);
  console.log(' 飞书打印插件 · 内网穿透工具');
  console.log(LINE);
  console.log(' node tunnel.js [命令] [选项]');
  console.log('');
  console.log('   （无参数）     一键部署：确保本地服务在跑 → 复用/生成穿透地址');
  console.log('   deploy         同上一行');
  console.log('   new            强制换新地址（飞书插件配置需要跟着改）');
  console.log('   status         查看隧道 / 地址 / 进程状态');
  console.log('   url            只输出当前地址');
  console.log('   stop           停止隧道');
  console.log('');
  console.log(' 选项：--port <n>  --no-server  --json  --quiet  --timeout <秒>');
  console.log(LINE);
}

function copyToClipboard(text) {
  try {
    const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
    const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
    const r = spawnSync(cmd, args, { input: text, windowsHide: true, timeout: 5000 });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

function humanTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch (e) {
    return iso;
  }
}

async function cmdDeploy(args) {
  const port = core.pathsFor(args.port || core.PRIMARY_PORT).port;
  if (!args.quiet && !args.json) {
    console.log(LINE);
    console.log(' 飞书打印插件 · 内网穿透一键部署');
    console.log(LINE);
    console.log(' [端口] ' + port);
    console.log(' [检查] 正在确认本地服务与上一次的穿透地址…');
  }

  let r;
  try {
    r = await core.deploy({
      port,
      force: args.command === 'new',
      ensureServer: !args.noServer,
      serverWaitMs: args.timeout || undefined,
    });
  } catch (e) {
    if (args.json) {
      console.log(JSON.stringify(core.emptyResult({ port, error: e.code || 'DEPLOY_FAILED', message: e.message })));
    } else {
      console.error('');
      console.error('[失败] ' + e.message);
      if (e.detail) console.error(e.detail);
      console.error('');
      console.error('排查建议：');
      console.error('  1) cloudflared 是否已安装：cloudflared --version');
      console.error('  2) 网络是否正常（需要能访问 cloudflare 边缘）。');
      console.error('  3) 本地服务是否起得来：node tunnel.js status');
    }
    return done(1);
  }

  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    return done(r.ok ? 0 : 1);
  }
  if (args.quiet) {
    console.log(r.url || '');
    return done(r.ok && r.url ? 0 : 1);
  }

  const changed = !!r.changed;
  if (changed) copyToClipboard(r.url);

  console.log(' [本地服务] ' + (r.server && r.server.started ? '原本没在跑，已自动拉起' : '已在运行，复用'));
  console.log(' [隧道动作] ' + (r.reused ? '复用上一次的地址（未重启隧道）' : r.action === 'forced' ? '强制重新生成' : '重新生成（旧地址已失效）'));
  console.log(' [公网检查] ' + (r.ready ? '地址可达' : '暂未探测到可达（可能还要几秒）'));
  console.log(THIN);
  console.log(' 内网穿透地址：');
  console.log('');
  console.log('   ' + r.url);
  console.log('');
  console.log(THIN);
  if (r.reused) {
    console.log(' 结论：地址未变，飞书插件配置无需修改。');
  } else if (changed) {
    console.log(' 结论：地址已变更（旧地址：' + (r.previousUrl || '无') + '）');
    console.log('      请到飞书多维表格 → 插件配置里把「插件地址」换成上面的新地址。');
    console.log('      （地址已尝试复制到剪贴板，可直接粘贴）');
  } else {
    console.log(' 结论：已生成内网穿透地址，请填入飞书插件配置。');
  }
  console.log(' 地址同时保存在：' + r.urlFile);
  console.log(LINE);
  return done(0);
}

async function cmdStatus(args) {
  const st = await core.status({ port: args.port || core.PRIMARY_PORT });
  if (args.json) {
    console.log(JSON.stringify(st, null, 2));
    return done(0);
  }
  console.log(LINE);
  console.log(' 飞书打印插件 · 内网穿透状态');
  console.log(LINE);
  console.log(' 本地端口        : ' + st.port);
  console.log(' 本地服务        : ' + (st.devServerUp ? '运行中' : '未运行（部署时会自动拉起）'));
  console.log(
    ' cloudflared     : ' +
      (st.cloudflared.found ? st.cloudflared.path : '未安装') +
      (st.cloudflared.running ? '  |  进程运行中 PID ' + st.cloudflared.pids.join(', ') + (st.cloudflared.ready ? ' (已连上边缘)' : ' (未连上边缘)') : '  |  未运行'),
  );
  console.log(' 内网穿透地址    : ' + (st.url || '（暂无）'));
  console.log(
    ' 地址是否可用    : ' +
      (st.url && st.urlHealthy
        ? '是 —— 再次部署会复用，不会更换'
        : st.url
          ? '否 —— 部署时会重新生成'
          : '—'),
  );
  if (st.tunnelUpdatedAt) console.log(' 上次更新        : ' + humanTime(st.tunnelUpdatedAt));
  console.log(' 提示            : ' + st.hint);
  console.log(LINE);
  return done(0);
}

function cmdUrl(args) {
  const st = core.loadState(args.port || core.PRIMARY_PORT);
  if (st.url) {
    console.log(st.url);
    return done(0);
  }
  console.error('[错误] 还没有可用的内网穿透地址，请先运行：node tunnel.js deploy');
  return done(1);
}

function cmdStop(args) {
  const r = core.stop({ port: args.port || core.PRIMARY_PORT });
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
    return done(0);
  }
  console.log('[完成] ' + r.message);
  return done(0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    printHelp();
    return done(0);
  }
  switch (args.command) {
    case 'deploy':
    case 'new':
      await cmdDeploy(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    case 'url':
      cmdUrl(args);
      break;
    case 'stop':
      cmdStop(args);
      break;
    default:
      printHelp();
      done(2);
  }
}

main()
  .catch((e) => {
    console.error('[错误] ' + (e && e.message ? e.message : String(e)));
    done(1);
  })
  .then(() => {
    // 不强行立刻退出：避免 stdout 接管道时输出被截断。
    // 若仍有残留句柄（unref 的定时器不阻止退出），2 秒后兜底结束进程。
    const t = setTimeout(() => process.exit(process.exitCode === undefined ? 0 : process.exitCode), 2000);
    t.unref();
  });
