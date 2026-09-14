#!/usr/bin/env bash
# ============================================================
# feishuprint 一键部署脚本（macOS / Linux 长期挂机用）
#
# 依赖：Node.js 16+、npm、curl、Homebrew
# 本脚本会自动安装：项目依赖、cloudflared、pm2
#
# 用法：
#   ./deploy.sh install    首次安装依赖（项目依赖 + cloudflared + pm2）
#   ./deploy.sh deploy     一键部署（推荐）：拉起 dev server + 复用/生成内网穿透地址
#   ./deploy.sh start      同 deploy（兼容旧用法）
#   ./deploy.sh new        强制换新地址（不使用上一次的地址，谨慎）
#   ./deploy.sh stop       停止服务
#   ./deploy.sh restart    重启服务（复用优先：地址能用就不换）
#   ./deploy.sh status     查看进程状态与穿透地址
#   ./deploy.sh logs       查看实时日志（Ctrl+C 退出）
#   ./deploy.sh startup    配置开机自启（按提示执行 sudo 命令）
#   ./deploy.sh tunnel     查看固定域名的命名隧道配置步骤
#
# 重要说明（内网穿透地址为什么以前每次都变）：
#   cloudflared 临时隧道的域名由 Cloudflare 随机分配，客户端无法指定；但它在
#   cloudflared 进程存活期间**保持不变**。旧版 start 会连同隧道一起 startOrReload，
#   等于每次都重启隧道进程，所以地址每次都变。现在改为「复用优先」：先探测上一次
#   的地址是否仍能回连本机，可用就直接复用，绝不重启隧道。
#   隧道统一由 dev server 提供的 /api/tunnel/* 管理（server/tunnelApi.js）。
#
# 端口：默认 5173，可用 PORT=5199 ./deploy.sh deploy 自定义
# ============================================================
set -eo pipefail

PORT="${PORT:-5173}"
APP_NAME="feishuprint"
LEGACY_TUNNEL_NAME="feishuprint-tunnel"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECOSYSTEM="$APP_DIR/ecosystem.config.cjs"
TUNNEL_API="http://127.0.0.1:$PORT/api/tunnel"

# 颜色
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info() { printf "%s[%s]%s %s\n" "$C_BLUE"  "INFO"  "$C_RESET" "$1"; }
ok()   { printf "%s[%s]%s %s\n" "$C_GREEN" "OK"    "$C_RESET" "$1"; }
warn() { printf "%s[%s]%s %s\n" "$C_YELLOW""WARN"  "$C_RESET" "$1"; }
err()  { printf "%s[%s]%s %s\n" "$C_RED"   "ERROR" "$C_RESET" "$1"; }

has() { command -v "$1" >/dev/null 2>&1; }

# 生成 pm2 进程配置 —— 只守护 dev server；隧道交给 /api/tunnel/* 管理，
# 这样就不会因为 pm2 重启而白白换掉穿透地址。
write_ecosystem() {
  cat > "$ECOSYSTEM" <<EOF
module.exports = {
  apps: [
    {
      name: '$APP_NAME',
      cwd: __dirname,
      script: 'npm',
      args: 'run start',
      env: { PORT: $PORT, NODE_ENV: 'development' },
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
    },
  ],
};
EOF
}

port_listening() {
  if has lsof; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  (exec 3<>/dev/tcp/127.0.0.1/"$PORT") >/dev/null 2>&1
}

wait_port() {
  local deadline=$((SECONDS + ${1:-120}))
  while (( SECONDS < deadline )); do
    sleep 3
    port_listening && return 0
  done
  return 1
}

ensure_dev_server() {
  if port_listening; then
    ok "dev server 已在 :$PORT 运行，复用"
    return
  fi
  pm2 delete "$APP_NAME" 2>/dev/null || true
  info "启动 dev server（端口 $PORT，pm2 守护）..."
  pm2 start "$ECOSYSTEM" --update-env
  wait_port 120 || { err "dev server 120 秒内未能启动，请执行 ./deploy.sh logs"; exit 1; }
  ok "dev server 已就绪 :$PORT"
}

# 调用一键部署接口（复用优先，真正的逻辑在 server/tunnelApi.js）
invoke_deploy() {
  local force="$1"
  local resp
  resp=$(curl -sS -X POST "$TUNNEL_API/deploy" \
          -H 'Content-Type: application/json' \
          --max-time 300 \
          -d "{\"force\":$force}") || { err "调用部署接口失败，请确认 dev server 正在运行"; exit 1; }

  local url message reused changed prev
  url=$(printf '%s' "$resp"   | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
  message=$(printf '%s' "$resp" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
  reused=$(printf '%s' "$resp" | grep -c '"reused":true' || true)
  changed=$(printf '%s' "$resp" | grep -c '"changed":true' || true)
  prev=$(printf '%s' "$resp"   | sed -n 's/.*"previousUrl":"\([^"]*\)".*/\1/p')

  if ! printf '%s' "$resp" | grep -q '"ok":true'; then
    err "部署失败：$resp"
    exit 1
  fi

  echo
  ok "$message"
  if [[ "$changed" != "0" && -n "$prev" ]]; then
    warn "地址已变更（旧地址：$prev）"
    warn "请到飞书多维表格 → 插件配置里把「插件地址」改成新地址"
  fi
  echo
  ok "内网穿透地址：$url"
  echo
  info "地址也保存在 tunnel-url.txt；本地部署页： http://localhost:$PORT/deploy"
}

# ---- install ----
cmd_install() {
  info "检查 Node.js..."
  if ! has node; then
    err "未检测到 Node.js，请先安装 Node.js 16+（推荐 brew install node 或 nvm）"
    exit 1
  fi
  local major
  major=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$major" -lt 16 ]]; then
    err "Node.js 版本过低（$(node -v)），需 16+"
    exit 1
  fi
  ok "Node.js $(node -v)"

  info "安装项目依赖（npm install）..."
  (cd "$APP_DIR" && npm install)
  ok "项目依赖安装完成"

  info "检查 cloudflared..."
  if ! has cloudflared; then
    if has brew; then
      brew install cloudflared
    else
      warn "未检测到 Homebrew，请手动安装 cloudflared："
      warn "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      exit 1
    fi
  fi
  ok "cloudflared 已就绪"

  info "检查 pm2..."
  if ! has pm2; then
    npm install -g pm2
  fi
  ok "pm2 $(pm2 --version)"

  write_ecosystem
  ok "已生成 pm2 配置：$ECOSYSTEM"
  echo
  ok "安装完成！下一步：./deploy.sh deploy"
}

# ---- deploy / start ----
cmd_deploy() {
  local force="$1"
  [[ -f "$ECOSYSTEM" ]] || write_ecosystem
  # 清掉历史遗留的 pm2 隧道进程，避免两个隧道打架
  pm2 delete "$LEGACY_TUNNEL_NAME" 2>/dev/null || true
  ensure_dev_server
  if [[ "$force" == "true" ]]; then
    info "强制重新生成地址（不使用上一次的地址）..."
  else
    info "正在部署（优先复用上一次的内网穿透地址）..."
  fi
  invoke_deploy "$force"
  pm2 save 2>/dev/null || true
}

# ---- stop ----
cmd_stop() {
  info "停止服务..."
  if port_listening; then
    curl -sS -X POST "$TUNNEL_API/stop" --max-time 60 >/dev/null 2>&1 || true
  fi
  pm2 delete "$APP_NAME" 2>/dev/null || true
  pm2 delete "$LEGACY_TUNNEL_NAME" 2>/dev/null || true
  pm2 save 2>/dev/null || true
  ok "已停止"
}

# ---- restart ----
cmd_restart() {
  write_ecosystem
  pm2 delete "$LEGACY_TUNNEL_NAME" 2>/dev/null || true
  if port_listening; then
    pm2 restart "$ECOSYSTEM" --update-env
  else
    ensure_dev_server
  fi
  info "正在重启（复用优先：地址仍可用就不换）..."
  invoke_deploy false
  pm2 save 2>/dev/null || true
}

# ---- status ----
cmd_status() {
  info "pm2 进程状态："
  pm2 list
  echo
  if ! port_listening; then
    warn "dev server 未运行，无法读取隧道状态。请执行 ./deploy.sh deploy"
    return
  fi
  curl -sS "$TUNNEL_API/status" --max-time 120 | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch (e) { console.log(s); return; }
      const cf = j.cloudflared || {};
      console.log("  cloudflared      " + (cf.running ? "运行中 (PID " + (cf.pids || []).join(", ") + ")" : "未运行"));
      console.log("  内网穿透地址     " + (j.url || "（暂无）"));
      console.log("  地址可用         " + (j.urlHealthy ? "是（部署时会复用，不会更换）" : "否（部署时会重新生成）"));
      console.log("  提示             " + (j.hint || ""));
      console.log("");
      console.log("[INFO] 本地部署页： http://localhost:" + j.port + "/deploy");
    });
  '
}

# ---- logs ----
cmd_logs() {
  info "实时日志（Ctrl+C 退出）..."
  pm2 logs "$APP_NAME"
  info "隧道日志： tail -n 50 \"$APP_DIR/.run/tunnel.err.log\""
}

# ---- startup ----
cmd_startup() {
  info "配置开机自启（pm2 startup）..."
  warn "pm2 会输出一条 sudo 命令，请复制执行以注册 launchd/systemd 服务。"
  pm2 startup
  echo
  info "执行完 sudo 命令后，再运行一次：pm2 save"
  ok "此后服务器重启会自动拉起 feishuprint（重启后隧道地址需重新部署生成）"
}

# ---- tunnel：固定域名命名隧道步骤 ----
cmd_tunnel() {
  cat <<'EOF'

============================================================
长期稳定方案：cloudflared 命名隧道（固定域名）
============================================================
临时隧道的域名由 Cloudflare 随机分配，只能「尽量复用」（本脚本已做到：只要地址
还能用就不换），但做不到「重启电脑后仍然不变」。要永久固定域名需要一个托管在
Cloudflare 的域名：

1. 登录 Cloudflare（会打开浏览器，需你的域名已托管在 Cloudflare）：
   cloudflared tunnel login

2. 创建隧道：
   cloudflared tunnel create feishuprint

3. 绑定到你的子域名：
   cloudflared tunnel route dns feishuprint print.你的域名.com

4. 编辑 ~/.cloudflared/config.yml：
   tunnel: <第2步生成的隧道ID>
   credentials-file: /Users/你的用户名/.cloudflared/<隧道ID>.json
   ingress:
     - hostname: print.你的域名.com
       service: http://localhost:5173
     - service: http_status:404

5. 用命名隧道启动（可交给 pm2 长期守护）：
   cloudflared tunnel run feishuprint

6. 飞书插件地址填 https://print.你的域名.com，之后永远不用再改。
============================================================
EOF
}

# ---- 主入口 ----
case "${1:-help}" in
  install)   cmd_install ;;
  deploy)    cmd_deploy false ;;
  start)     cmd_deploy false ;;
  new)       cmd_deploy true ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  startup)   cmd_startup ;;
  tunnel)    cmd_tunnel ;;
  help|*)
    sed -n '4,29p' "$0" | sed 's/^# \?//'
    ;;
esac
