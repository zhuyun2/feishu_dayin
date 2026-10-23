# 飞书打印插件 · macOS 一键部署说明

> 本文档只讲 **macOS**。Windows 的用法见 `deploy.bat` / 「一键部署.bat」的头部注释，两者互不影响。

---

## 一、和 Windows 的关系（重要）

mac 侧是**完全独立的一套实现**，不修改、不依赖任何 Windows 代码：

| 平台 | 双击入口 | 命令行入口 | 编排层 | 隧道核心 | 自启 |
|---|---|---|---|---|---|
| Windows | `一键部署.bat` | `deploy.bat` | `server/setupCore.js` | `server/namedTunnelCore.js` | 「启动」夹的 `.vbs` |
| **macOS** | **`一键部署.command`** | **`deploy-mac.sh`** | **`server/setupCoreMac.js`** | **`server/namedTunnelCoreMac.js`** | **launchd plist** |

两套实现**共用**下面这些与平台无关的部分（只读引用，谁都不改谁）：

- `server/tunnelCore.js` —— dev server 拉取、进程列举（已有 `ps` 分支）、公网探测、TCP 探针
- `deploy/tunnel.config.json` 与 `deploy/profiles/*/` —— 域名与凭据**完全通用**，同一个项目文件夹在 win / mac 之间来回拷贝都能直接认（Windows 上配好的凭据在 mac 上照样能用，反之亦然）
- `runtime/active-profile.txt` —— 「上次用的域名」两边共用同一份

> 之所以独立成两份而不是在原文件里加 `if (darwin)` 分支：加分支等于动 Windows 的执行路径，回归风险不可控；独立成文件后，mac 逻辑出问题绝不会连带影响 Windows 那台机器。

---

## 二、首次部署

1. 把整个项目文件夹拷到 mac 上（`deploy/` 目录必须一起带上，里面是隧道凭据）
2. 打开「终端」，`cd` 到项目目录，给三个脚本加可执行权限：

   ```bash
   cd ~/Documents/feishu_dayin        # 换成你的实际路径
   chmod +x "一键部署.command" deploy-mac.sh tools/get-node.sh
   ```

3. **双击「一键部署.command」**

   > 如果第一次双击被 Gatekeeper 拦住，改成：右键 → **打开** → 在弹窗里点「打开」。只需这一次。

脚本会依次自动完成：

1. 定位 Node（`runtime/node/bin/node` → PATH → Homebrew → 自动下载便携版到 `runtime/node/`）
2. 下载 cloudflared（按本机架构取 `darwin-arm64` / `darwin-amd64`，解包到 `runtime/cloudflared/`）
3. 安装隧道凭据到 `~/.cloudflared/`，按本机绝对路径渲染 `config.yml`
4. 缺依赖就 `npm install`
5. 拉起 dev server（`:5173`）
6. 启动固定域名隧道，等到 `/ready` 返回 200
7. 公网回连校验（靠 `instanceId` 确认域名真的连到了本机）
8. 注册 launchd 登录自启

**跑完终端最后会打印固定域名**，把它填进飞书多维表格插件的「插件地址」即可。

---

## 三、命令行用法（与 Windows 版逐字对齐）

```bash
./deploy-mac.sh                       # 一键部署（默认）
./deploy-mac.sh status                # 查看状态
./deploy-mac.sh doctor                # 部署体检（排错首选）
./deploy-mac.sh stop                  # 停隧道（dev server 不动）
./deploy-mac.sh restart               # 重启隧道
./deploy-mac.sh url                   # 只打印固定域名
./deploy-mac.sh profiles              # 列出已配置的固定域名
./deploy-mac.sh --profile print2      # 部署指定域名
./deploy-mac.sh autostart on          # 开登录自启
./deploy-mac.sh autostart off         # 关登录自启
./deploy-mac.sh --no-autostart        # 本次不注册自启
./deploy-mac.sh --no-download         # 禁止联网下载（离线场景）
./deploy-mac.sh --force               # 强制重启隧道
```

也可以绕过 bash 直接调编排层（等价）：

```bash
node server/setupCoreMac.js doctor
node server/setupCoreMac.js status --json
```

---

## 四、登录自启（launchd）

部署成功后会在 `~/Library/LaunchAgents/` 生成一个 plist：

```
~/Library/LaunchAgents/icu.dimeifeishudayin.feishuprint.<profile>.plist
```

- 每个域名（profile）一个 plist，互不干扰
- `RunAtLoad` = 登录即拉起；`KeepAlive` = 进程意外退出自动重来
  （这是 launchd 相对 Windows vbs 的优势：vbs 拉起后就不管了）
- 日志落在 `.run/launchd.out.log` / `.run/launchd.err.log`

常用排查命令：

```bash
launchctl list | grep feishuprint                          # 看是否已加载
launchctl bootout gui/$(id -u)/icu.dimeifeishudayin.feishuprint.print2   # 卸载
./deploy-mac.sh autostart off                              # 关闭并删除 plist
```

> macOS 13+ 建议在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里给 `/bin/bash`
> 或终端放行，否则 launchd 可能在访问外置卷上的项目目录时被拦。

---

## 五、跨平台注意点

| 事项 | 说明 |
|---|---|
| `node_modules` 不能跨架构复制 | Intel 机器上装的 `node_modules`（含原生模块）拷到 M4 上会挂，必须重装：`rm -rf node_modules && npm install` |
| `runtime/` 不入库 | 便携版 node / cloudflared 都是本机产物，换机器会自动重下 |
| 凭据通用 | `deploy/` 里的隧道密钥是纯 JSON，win / mac 通用，不必重新签发 |
| Intel 机器上判断架构 | **不要用 `uname -m`**（Rosetta 下会误报 `x86_64`）；脚本内部已用 `sysctl -n machdep.cpu.brand_string` 判断，见 `tools/get-node.sh` |
| LibreOffice | `server/pdfApi.js` 的 docx→PDF 需要 `soffice`。mac 上装：`brew install --cask libreoffice`（mac 路径已内置识别） |

---

## 六、排查

```bash
./deploy-mac.sh doctor        # 先把这一条的输出看清楚
tail -40 deploy-log.txt
tail -40 .run/named-tunnel.err.log
tail -40 .run/launchd.err.log
```

常见症状对照：

| 症状 | 多半是 | 处理 |
|---|---|---|
| 双击没反应 | 没有执行权限 / Gatekeeper | `chmod +x "一键部署.command"`，或右键 → 打开 |
| `cloudflared` 下载失败 | GitHub 直连被墙 | 脚本会自动试镜像；仍失败则 `brew install cloudflared` |
| 域名 502 / 白屏 | 隧道连上了但 ingress 没生效 | `./deploy-mac.sh doctor` 看「隧道已连边缘」；重跑 deploy |
| 重启后域名打不开 | 登录自启没生效 / 网络未就绪 | `launchctl list \| grep feishuprint`；脚本内置了 90 秒等待网络 |
| 时好时坏、间歇 502 | 同一条隧道被两台电脑同时连 | `doctor` 会报「连接器数量」，在多余那台执行 `stop` |

---

## 七、回归验证

改动 mac 侧代码后，跑一次静态校验（在任意平台都能跑）：

```bash
node scripts/test-mac-port.cjs
```

它会检查：模块依赖图完整、与 Windows 版读同一份 `deploy/` 得到**完全相同**的
profile/fixedUrl/tunnelId/metricsPort、`config.yml` 用 `127.0.0.1` 而非 `localhost`、
plist XML 标签配对正确，以及 **Windows 侧文件未被改动**（内容指纹与耦合检查）。
