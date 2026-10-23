#!/usr/bin/env bash
# ============================================================
#  get-node.sh —— macOS 版：新电脑没有 Node.js 时，自动下载便携版到 runtime/node/
#
#  对应 Windows 的 tools/get-node.ps1，但目标包与目录结构不同：
#    - 下载 node-vX.Y.Z-darwin-arm64.tar.gz（M 系列）或 darwin-x64.tar.gz（Intel）
#    - 解压后把 bin/ 与 lib/、include/、share/ 平铺到 runtime/node/
#      于是运行时路径统一为：runtime/node/bin/node 与 runtime/node/bin/npm
#
#  下载源按顺序尝试：
#    1) https://nodejs.org/dist/                （官方）
#    2) https://npmmirror.com/mirrors/node/      （国内镜像，快）
#  版本取官方 index.json 里最新的 LTS，不写死版本号。
#
#  **只解压运行时，不装到系统、不改 PATH、不需要 sudo。**
#  解压后项目内会出现 runtime/node/bin/node，后续一键部署直接复用它。
#
#  用法：bash tools/get-node.sh [--force]
#    --force  即使 runtime/node/bin/node 已存在也重新下载
# ============================================================

set -euo pipefail

FORCE=0
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$ROOT/runtime"
NODE_DIR="$RUNTIME_DIR/node"
TMP_DIR="$RUNTIME_DIR/_node_dl"

info() { printf '  · %s\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; }

# ---------- 0. 已存在就不重复下载 ----------
if [[ -x "$NODE_DIR/bin/node" && "$FORCE" != "1" ]]; then
  ok "runtime/node/bin/node 已存在，跳过下载（$( "$NODE_DIR/bin/node" -v 2>/dev/null || echo '未知版本' )）"
  exit 0
fi

# ---------- 1. 判断 CPU 架构 ----------
# ⚠️ 不能在 Rosetta 环境下用 uname -m 判断：转译运行的终端会始终返回 x86_64。
# 用 sysctl 读 CPU 品牌串才是真话。
RAW_ARCH="$(uname -m)"
BRAND="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '')"
if [[ "$BRAND" == *"Apple M"* ]]; then
  ARCH_TAG="arm64"
else
  ARCH_TAG="x64"
fi
info "本机架构：$ARCH_TAG（uname -m=$RAW_ARCH，CPU=$BRAND）"

mkdir -p "$RUNTIME_DIR" "$TMP_DIR"

# ---------- 2. 解析最新 LTS 版本号 ----------
info '正在查询 Node.js 最新 LTS 版本…'
VER=""
for SRC in "https://nodejs.org/dist/index.json" "https://npmmirror.com/mirrors/node/index.json"; do
  # 取 index.json 里第一个 lts != false 的 version
  V="$(curl -fsSL --max-time 25 "$SRC" 2>/dev/null \
        | tr '}' '\n' \
        | grep -v '"lts":false' \
        | grep -o '"version":"v[0-9.]*"' \
        | head -1 \
        | sed 's/.*"v\([0-9.]*\)".*/\1/' || true)"
  if [[ -n "$V" ]]; then
    VER="$V"
    break
  fi
  warn "取版本列表失败（$SRC）"
done
if [[ -z "$VER" ]]; then
  fail '无法获取 Node.js 版本列表，请检查网络后重试，或手动安装 Node.js（brew install node）后重新运行一键部署'
  exit 1
fi
info "目标版本：Node v$VER (darwin-$ARCH_TAG)"

# ---------- 3. 下载 tar.gz ----------
FILE_NAME="node-v$VER-darwin-$ARCH_TAG.tar.gz"
TARBALL="$TMP_DIR/$FILE_NAME"
URLS=(
  "https://nodejs.org/dist/v$VER/$FILE_NAME"
  "https://npmmirror.com/mirrors/node/v$VER/$FILE_NAME"
)

DOWNLOADED=0
for U in "${URLS[@]}"; do
  info "下载中：$U"
  if curl -fL --connect-timeout 20 --max-time 900 --retry 2 --progress-bar -o "$TARBALL" "$U"; then
    # 体积必须 > 10MB，否则视为下到了错误页面
    SIZE="$(stat -f%z "$TARBALL" 2>/dev/null || echo 0)"
    if [[ "$SIZE" -gt 10485760 ]]; then
      DOWNLOADED=1
      break
    fi
    warn "下载到的文件体积异常（$SIZE 字节），换下一个源重试"
  else
    warn "下载失败，换下一个源重试"
  fi
done
if [[ "$DOWNLOADED" != "1" ]]; then
  fail 'Node.js 下载失败。可手动下载便携版 tar.gz，解压后把其中的 bin/ 等目录放到 runtime/node/ 下'
  exit 1
fi
SIZE_MB="$(( $(stat -f%z "$TARBALL") / 1048576 ))"
ok "下载完成（${SIZE_MB} MB）"

# ---------- 4. 解压到 runtime/node ----------
info '正在解压…'
EXTRACT="$TMP_DIR/x"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
tar -xzf "$TARBALL" -C "$EXTRACT"

INNER="$(find "$EXTRACT" -maxdepth 1 -type d -name 'node-v*' | head -1)"
if [[ -z "$INNER" ]]; then
  fail '解压结果异常，没有找到 node-v* 目录'
  exit 1
fi

# 平铺：直接把 inner 下的内容搬到 runtime/node
rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"
# 用 / 结尾保证连同隐藏文件一起搬
for item in "$INNER"/*; do
  [[ -e "$item" ]] || continue
  mv "$item" "$NODE_DIR/"
done
rm -rf "$TMP_DIR"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  fail "解压后没有找到可执行的 node：$NODE_DIR/bin/node"
  exit 1
fi

# 便携版里 npm 是 symlink（bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js），
# mac 上解压/搬运后 symlink 可能失效，检查并在必要时修复。
if [[ -L "$NODE_DIR/bin/npm" && ! -e "$NODE_DIR/bin/npm" ]]; then
  warn 'npm 符号链接失效，正在修复…'
  ln -sf "../lib/node_modules/npm/bin/npm-cli.js" "$NODE_DIR/bin/npm"
  ln -sf "../lib/node_modules/npm/bin/npx-cli.js" "$NODE_DIR/bin/npx"
fi

ok "Node.js 已就绪：$NODE_DIR/bin/node（$( "$NODE_DIR/bin/node" -v )）"
ok "（便携版，只放在项目 runtime/ 下，没有改动系统环境）"
exit 0
