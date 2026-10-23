#!/usr/bin/env bash
# ============================================================
#  feishuprint 一键部署入口 · macOS 版
#
#  与 Windows 的 deploy.bat 一一对应（命令、选项、行为全部对齐）：
#    ./deploy-mac.sh                     一键部署（默认）
#    ./deploy-mac.sh --silent            精简输出、不暂停（launchd 自启用这个）
#    ./deploy-mac.sh --no-autostart      不注册登录自启
#    ./deploy-mac.sh --no-download       禁止联网下载
#    ./deploy-mac.sh --force             强制重启隧道
#    ./deploy-mac.sh status | doctor | stop | restart | url
#    ./deploy-mac.sh profiles            列出已配置的固定域名
#    ./deploy-mac.sh --profile <标识>     指定域名部署
#    ./deploy-mac.sh autostart on | off  开/关登录自启（launchd）
#
#  双击入口：项目根目录的「一键部署.command」（= 本脚本 + 保持窗口）。
#
#  本脚本只做三件事：定位 Node → 交给 server/setupCoreMac.js → 打印结果。
#  所有业务逻辑都在 Node 里（可测试、可排错）；bash 越薄越不容易坏。
#  ⚠️ 它**不会**碰 Windows 的 deploy.bat / _find_node.bat / setupCore.js。
# ============================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG="$SCRIPT_DIR/deploy-log.txt"
CORE="server/setupCoreMac.js"

# macOS 上 GUI 启动（双击 .command）时 PATH 极简，把 Homebrew 两个标准位置补进来
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SILENT=0
for a in "$@"; do
  [[ "$a" == "--silent" ]] && SILENT=1
done

{
  echo "==================== deploy-mac $(date '+%Y-%m-%d %H:%M:%S') ===================="
  echo "[env] CWD=$PWD"
  echo "[env] PATH=$PATH"
  echo "[env] uname=$(uname -m)  arch=$([[ "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '')" == *"Apple M"* ]] && echo arm64 || echo x64)"
} > "$LOG"

say() { [[ "$SILENT" == "1" ]] || printf '%s\n' "$1"; }

# ---------------------------------------------------------------
# 0. 完整性自检
#    交付包若被「拍平」（server/ tools/ 等子目录丢失，所有文件挤在一个
#    文件夹里），后面的路径全会对不上，报出来是晦涩的 No such file。
#    这里提前拦住，直接说清缺什么、该怎么放。
# ---------------------------------------------------------------
MISSING=""
for need in "server/setupCoreMac.js" "server/namedTunnelCoreMac.js" "server/tunnelCore.js" "tools/get-node.sh"; do
  [[ -f "$SCRIPT_DIR/$need" ]] || MISSING="$MISSING $need"
done
if [[ -n "$MISSING" ]]; then
  echo "[step] FAILED: incomplete layout, missing:$MISSING" >> "$LOG"
  if [[ "$SILENT" != "1" ]]; then
    echo ''
    echo '  [错误] 项目文件不完整（目录结构不对），缺少：'
    for m in $MISSING; do echo "           $m"; done
    echo ''
    echo "  当前脚本所在目录：$SCRIPT_DIR"
    echo '  正确结构应当是：'
    echo '         一键部署.command'
    echo '         deploy-mac.sh'
    echo '         server/setupCoreMac.js'
    echo '         server/namedTunnelCoreMac.js'
    echo '         server/tunnelCore.js   ← 项目里本来就有'
    echo '         tools/get-node.sh'
    echo ''
    echo '  常见原因：拷贝时把子目录里的文件都堆到了同一层。'
    echo '  处理：把整个项目文件夹按原样拷过来（保留 server/ tools/ 等子目录），'
    echo '        或者把本更新包整个覆盖到已有项目目录上。'
    echo ''
    read -n 1 -s -r -p '按任意键关闭…'
    echo ''
  fi
  exit 1
fi

# ---------------------------------------------------------------
# 1. 定位 Node（与 Windows 的 _find_node.bat 同序）
#    1) 项目内便携版 runtime/node/bin/node
#    2) 系统 PATH
#    3) Homebrew / 常见安装位置
#    4) node-path.txt 第一行（手工指定）
# ---------------------------------------------------------------
NODE_BIN=""

if [[ -x "$SCRIPT_DIR/runtime/node/bin/node" ]]; then
  NODE_BIN="$SCRIPT_DIR/runtime/node/bin/node"
  echo "[step] node from runtime/: $NODE_BIN" >> "$LOG"
fi

if [[ -z "$NODE_BIN" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  echo "[step] node from PATH: $NODE_BIN" >> "$LOG"
fi

if [[ -z "$NODE_BIN" ]]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$c" ]]; then
      NODE_BIN="$c"
      echo "[step] node from fallback: $NODE_BIN" >> "$LOG"
      break
    fi
  done
fi

if [[ -z "$NODE_BIN" ]] && [[ -f "$SCRIPT_DIR/node-path.txt" ]]; then
  CAND="$(head -1 "$SCRIPT_DIR/node-path.txt" | tr -d '\r\n' || true)"
  if [[ -n "$CAND" && -x "$CAND" ]]; then
    NODE_BIN="$CAND"
    echo "[step] node from node-path.txt: $NODE_BIN" >> "$LOG"
  fi
fi

# 2. 都没有 → 下载便携版（相当于 Windows 的 tools/get-node.ps1）
if [[ -z "$NODE_BIN" ]]; then
  say ''
  say '  未检测到 Node.js —— 正在下载便携版到 runtime/node/（约 45MB，仅首次需要）…'
  echo "[step] node not found, running tools/get-node.sh" >> "$LOG"
  bash "$SCRIPT_DIR/tools/get-node.sh" 2>&1 | tee -a "$LOG"
  if [[ -x "$SCRIPT_DIR/runtime/node/bin/node" ]]; then
    NODE_BIN="$SCRIPT_DIR/runtime/node/bin/node"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  say ''
  say '  [错误] 未找到 Node.js，且自动下载失败。'
  say ''
  say '  两种修复方式：'
  say '    1) 连上网重试，或手动下载便携版 tar.gz，解压后放到：'
  say "         $SCRIPT_DIR/runtime/node/"
  say '    2) 用 Homebrew 安装：brew install node'
  say ''
  echo "[step] FAILED: no node" >> "$LOG"
  [[ "$SILENT" == "1" ]] || read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "[step] NODE_BIN=$NODE_BIN  ($("$NODE_BIN" -v 2>/dev/null))" >> "$LOG"

# ---------------------------------------------------------------
# 3. 转发给 Node 编排层（与 Windows 的 setupCore.js 同命令语义）
#    第一个参数是已知子命令 → 直接透传；否则视为 deploy 加选项
# ---------------------------------------------------------------
SUB=""
case "${1:-}" in
  status|doctor|stop|restart|url|autostart|profiles|list-domains) SUB=1 ;;
esac

if [[ -n "$SUB" ]]; then
  echo "[step] run: setupCoreMac $*" >> "$LOG"
  "$NODE_BIN" "$SCRIPT_DIR/$CORE" "$@"
  RC=$?
else
  echo "[step] run: setupCoreMac deploy $*" >> "$LOG"
  "$NODE_BIN" "$SCRIPT_DIR/$CORE" deploy "$@"
  RC=$?
fi

echo "[step] setupCoreMac exit=$RC" >> "$LOG"

# ---------------------------------------------------------------
# 4. 结果提示（与 deploy.bat 的收尾一致）
# ---------------------------------------------------------------
if [[ "$SILENT" == "1" ]]; then
  exit $RC
fi

say ''
if [[ "$RC" != "0" ]]; then
  say '  [失败] 部署未完成 —— 上面的固定域名现在很可能不可用。'
  say '         先看 deploy-log.txt，别只看上面的成功措辞。'
  say '         快速检查：./deploy-mac.sh doctor'
else
  say '  [完成] 部署结束，上面的固定域名现在应该可以访问了。'
fi
say '  [提示] 日志：deploy-log.txt ，.run/named-tunnel.err.log'
say '         排查：./deploy-mac.sh doctor'
say ''
exit $RC
