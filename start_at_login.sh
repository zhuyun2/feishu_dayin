#!/bin/bash
# 登录时由 LaunchAgent 调用：恢复（或启动）飞书打印服务
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/dimei/.npm-global/bin:$PATH"
LOG=/tmp/feishu_dayin_launch.log
cd /Users/dimei/Documents/feishu_dayin || exit 1
pm2 resurrect >>"$LOG" 2>&1 || pm2 start ecosystem.config.cjs --update-env >>"$LOG" 2>&1
pm2 save >>"$LOG" 2>&1
