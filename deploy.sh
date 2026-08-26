#!/usr/bin/env bash
# ============================================================
# feishuprint 一键部署脚本（macOS 服务器长期挂机用）
#
# 依赖：Node.js 16+、npm、Homebrew
# 本脚本会自动安装：项目依赖、cloudflared、pm2
#
# 用法：
#   ./deploy.sh install    首次安装依赖（项目依赖 + cloudflared + pm2）
#   ./deploy.sh start      启动 dev server + 内网穿透（pm2 守护）
#   ./deploy.sh stop       停止服务
#   ./deploy.sh restart    重启服务
#   ./deploy.sh status     查看进程状态与穿透地址
#   ./deploy.sh logs       查看实时日志（Ctrl+C 退出）
#   ./deploy.sh startup    配置开机自启（按提示执行 sudo 命令）
#   ./deploy.sh tunnel     查看固定域名的命名隧道配置步骤
#
# 端口：默认 5173，可用 PORT=5199 ./deploy.sh start 自定义
# ============================================================
set -eo pipefail

PORT="${PORT:-5173}"
APP_NAME="feishuprint"
TUNNEL_NAME="feishuprint-tunnel"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ECOSYSTEM="$APP_DIR/ecosystem.config.cjs"

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

# 生成 pm2 进程配置（端口随 PORT 写入）
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
    {
      name: '$TUNNEL_NAME',
      cwd: __dirname,
      script: 'cloudflared',
      args: 'tunnel --url http://localhost:$PORT',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
    },
  ],
};
EOF
}

# 从 pm2 日志文件提取 cloudflared 穿透地址（兼容各版本 pm2）
show_tunnel_url() {
  info "内网穿透地址："
  local url=""
  local log_dir="$HOME/.pm2/logs"
  # cloudflared 可能写 stdout 或 stderr，两个都读
  if [[ -d "$log_dir" ]]; then
    url=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
          "$log_dir/${TUNNEL_NAME}-out.log" "$log_dir/${TUNNEL_NAME}-error.log" 2>/dev/null \
          | tail -1 || true)
  fi
  if [[ -z "$url" ]]; then
    # 备用：直接跑 pm2 logs（某些版本 --nostream 不支持）
    url=$(pm2 logs "$TUNNEL_NAME" --lines 200 --raw 2>/dev/null \
          | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  fi
  if [[ -n "$url" ]]; then
    ok "$url  ← 把这个填进飞书插件配置"
  else
    warn "尚未获取到地址，cloudflared 可能还在启动中"
    info "手动查看日志：pm2 logs $TUNNEL_NAME --lines 50"
    info "或：tail -n 50 ~/.pm2/logs/${TUNNEL_NAME}-out.log"
  fi
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
  ok "安装完成！下一步：./deploy.sh start"
}

# ---- start ----
cmd_start() {
  [[ -f "$ECOSYSTEM" ]] || write_ecosystem
  info "启动 dev server（端口 $PORT）+ 内网穿透（pm2 守护）..."
  pm2 startOrReload "$ECOSYSTEM" --update-env
  pm2 save
  ok "已启动并由 pm2 守护"
  echo
  sleep 3
  show_tunnel_url
  echo
  warn "临时隧道地址每次重启 cloudflared 会变。长期稳定建议配命名隧道：./deploy.sh tunnel"
  warn "配置开机自启请执行：./deploy.sh startup"
}

# ---- stop ----
cmd_stop() {
  info "停止服务..."
  pm2 delete "$APP_NAME"   2>/dev/null || true
  pm2 delete "$TUNNEL_NAME" 2>/dev/null || true
  pm2 save 2>/dev/null || true
  ok "已停止"
}

# ---- restart ----
cmd_restart() {
  write_ecosystem
  pm2 restart "$ECOSYSTEM" --update-env
  pm2 save
  ok "已重启"
  echo
  sleep 3
  show_tunnel_url
}

# ---- status ----
cmd_status() {
  info "pm2 进程状态："
  pm2 list
  echo
  show_tunnel_url
}

# ---- logs ----
cmd_logs() {
  info "实时日志（Ctrl+C 退出）..."
  pm2 logs
}

# ---- startup ----
cmd_startup() {
  info "配置开机自启（pm2 startup）..."
  warn "pm2 会输出一条 sudo 命令，请复制执行以注册 launchd 服务。"
  pm2 startup
  echo
  info "执行完 sudo 命令后，再运行一次：pm2 save"
  ok "此后服务器重启会自动拉起 feishuprint"
}

# ---- tunnel：固定域名命名隧道步骤 ----
cmd_tunnel() {
  cat <<'EOF'

============================================================
长期稳定方案：cloudflared 命名隧道（固定域名）
============================================================
临时隧道每次重启换地址，团队用起来麻烦。配命名隧道后域名固定：

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

5. 改 ecosystem.config.cjs 里 tunnel 那条的 args 为：
   args: 'tunnel --config ~/.cloudflared/config.yml run feishuprint'

6. 重启：./deploy.sh restart
   之后地址固定为 https://print.你的域名.com
============================================================
EOF
}

# ---- 主入口 ----
case "${1:-help}" in
  install)  cmd_install ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  logs)     cmd_logs ;;
  startup)  cmd_startup ;;
  tunnel)   cmd_tunnel ;;
  help|*)
    sed -n '3,20p' "$0" | sed 's/^# \?//'
    ;;
esac

