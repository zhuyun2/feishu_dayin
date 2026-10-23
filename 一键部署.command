#!/usr/bin/env bash
# ============================================================
#  一键部署.command —— macOS 双击入口
#
#  这就是 Windows「一键部署.bat」在 mac 上的等价物：
#  Finder 里双击本文件 → 自动打开「终端」并执行部署。
#
#  它本身只做两层包装：
#    1. 双击时把工作目录切到脚本所在目录（Finder 双击的 CWD 是家目录）
#    2. 跑完暂停，等你看清结果再关窗口（等价于 deploy.bat 的 pause）
#
#  真正的逻辑在 deploy-mac.sh → server/setupCoreMac.js。
#
#  ⚠️ 首次使用前请确保本文件有可执行权限：
#        chmod +x "一键部署.command" deploy-mac.sh tools/get-node.sh
#     （若双击提示「没有权限」，在终端跑上面这条即可；也可以用
#      右键 → 打开 → 确认，绕过 Gatekeeper 的首次拦截。）
# ============================================================

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

bash ./deploy-mac.sh "$@"
RC=$?

echo ''
read -n 1 -s -r -p "按任意键关闭此窗口…"
echo ''
exit $RC
