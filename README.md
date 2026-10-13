# pi-yyp-config

yyp 的个人 pi 配置仓库：**一个 GitHub 私有仓库同步所有 pi 配置**，多机一处维护。

本仓库同时是：

1. **pi 包**（`extensions/` 下的扩展通过 pi 包机制分发，含同步扩展 `pi-sync`）
2. **配置备份库**（`config/` 下存放各机共享的配置快照与合并元数据）

## 快速上手

### 新机器接入（一键）

```bash
pi install git:git@github.com:SomeTestZero/pi-yyp-config
pi          # 启动后执行：
/sync init git@github.com:SomeTestZero/pi-yyp-config.git --mode=remote
```

`--mode=remote` 表示以远端为准（推荐新机器）；在配置最全的主力机上首次建仓用 `--mode=local`。

### 日常：零操作

- **启动 pi** → 自动拉取并合并其他机器的改动（通知栏给摘要）
- **改了配置、装/删了插件** → **退出 pi 时自动推送**
- 两机改了同一配置键 → 下次手动 `/sync` 时弹窗选择保留哪边

### 命令

| 命令 | 作用 |
| --- | --- |
| `/sync` | 一键同步：拉取 → 合并 → 推送（交互解决冲突） |
| `/sync status` | 查看本机与远端差异、待解决冲突、机器列表 |
| `/sync push` / `/sync pull` | 单向操作 |
| `/sync on` / `/sync off` | 开关本机的自动同步 |
| `/sync lan <ssh主机>` | 内网同步：推送到指定主机的 `~/pi-mirror` 镜像并记住，之后退出 pi 自动转发 |
| `/sync lan off` | 清空内网镜像主机，关闭退出自动转发 |

## 内网机器（无外网）

`/sync lan v2x`（`v2x` 为 `~/.ssh/config` 中的 Host 别名）把**配置同步仓库 + 所有已安装 git 插件仓库**推送到该主机的本地 git 镜像，自动完成：

- 目标机建 `~/pi-mirror/<name>.git` 裸仓库 + 无 `.git` 后缀软链（兼容两种 URL 写法）
- 目标机配 `url."$HOME/pi-mirror/".insteadOf`，把 `https://github.com/<org>/`、`git@github.com:<org>/` 透明重写到本地镜像 → 目标机 `pi install` / `pi update --extensions` 全程离线

内网机一次性准备：

```bash
pi install git:git@github.com:SomeTestZero/pi-yyp-config   # 会被 insteadOf 重写到镜像
# settings.json 设（sync 键本机有效，不参与同步）：
#   "sync": { "repo": "/home/<用户>/pi-mirror/pi-yyp-config.git",
#             "excludeKeys": ["defaultProvider","defaultModel"] }
pi                        # 启动即自动拉取合并，补齐全部插件/配置
```

注意：`npm:` 来源的包无法离线安装，把主力机 `~/.pi/agent/npm/` 整目录拷到内网机同路径即可；`auth.json` 按设计永不同步，内网机用 `/infcode-connect` 共享主力机登录态。主力机不在内网时退出转发自动静默跳过。

## REA 逆向工具（rea-assist）

[REA](https://github.com/morluto/rea) 是逆向分析 MCP（二进制/App/Electron/网页，170 个工具）。
官方 setup 会把 MCP 注册写成**机器相关的绝对路径**（Windows 上是 node.exe + npx 缓存路径），
不能进同步仓库，因此 `rea-assist` 改为「启动提示 + 按需启用」：

| 命令 | 作用 |
| --- | --- |
| `/rea` | 查看状态（持久注册/本会话/自动开关/skill） |
| `/rea on` | **本会话即时启用**（registerMcpServer，无需重启） |
| `/rea off` | 本会话停用 |
| `/rea auto on\|off` | 启动自动启用；写 settings 的 `reaAssist.autoEnable`，**随 pi-sync 同步到全机** |
| `/rea ghidra install [版本]` | **一键安装 Ghidra**（官方 zip 下载+解压，装完自动接入） |
| `/rea ghidra status` | Ghidra 安装状态 |
| `/rea-setup` | 跑官方安装器做持久注册（机器本地，不同步；与 `/rea auto` 二选一） |

默认形态：启动时若 REA 未启用，提示一条「/rea on」；想要全自动就任一机器 `/rea auto on`，
全机生效。注册形态是 `node + npx-cli.js + rea-agents@固定版本`，Windows/Linux 通用，
不依赖 PATH 里 npx 的解析方式。单机临时关闭：环境变量 `REA_ASSIST=0`。

⚠️ **版本纪律**：`extensions/rea-assist.ts` 的 `REA_PKG_VERSION` 与
`skills/reverse-engineer-anything/` 必须来自同一个 rea-agents 版本，升级时同一提交里一起改。

⚠️ **skill 副本唯一化**：skill 以本仓库 `skills/` 为准。顶层 `~/.agents/skills/` 的同名副本
会**遮蔽**包内副本（导致包内更新不生效），已在仓库的机器请删掉
`~/.agents/skills/reverse-engineer-anything/`；也不要再跑 `rea setup` 的 skill 安装。

### Ghidra（原生分析引擎）接入

JS/.NET/Go/WASM 等静态分析开箱即用；原生二进制（exe/elf/dll）的伪代码级分析
需要 Ghidra（免费）/Hopper/IDA 之一。推荐 Ghidra，**装好后 rea-assist 自动探测接入，
零配置**（扫 `C:\Tools`、`/opt`、`/usr/share`、`~` 等常见位置取最高版本，经
`support/analyzeHeadless` 验证后以 `GHIDRA_INSTALL_DIR` 注入 REA）。

要求：**Ghidra 12.1.x**（验证基准 12.1.4）+ **JDK 21+**（64 位，含 javac）。

- **Windows（本机已装）**：Ghidra 12.1.4 → `C:\Tools\ghidra_12.1.4_PUBLIC`，JDK 21 →
  `C:\Program Files\Microsoft\jdk-21.0.8.9-hotspot`；用户环境变量 `GHIDRA_INSTALL_DIR`
  /`JAVA_HOME` 已写入，`~/.pi/agent/mcp.json` 的 rea 条目也带上了 env（机器本地，不同步）。
  Windows P0 为只读分析（x86/x64 PE，固定本地 NTFS 卷）。
- **其他机器（含 Linux）**：pi 里执行 `/rea ghidra install` 即可——从 GitHub 官方源下载
  ghidra_12.1.4（约 570MB，实测 1 分钟内）解压到 `/opt` 或 `~/Tools`，**装完自动接入**，
  不需要 root（/opt 不可写时自动落用户目录）、不需要跑 rea setup。已有 JDK 21+ 即可
  （Linux：`apt install openjdk-21-jdk`）。
- 升级/换版本：`/rea ghidra install 12.1.5`；探测自动取最高版本。不搞静默自动更新
  （分析引擎版本影响结论可复现性，升级应显式）。

下载：<https://github.com/NationalSecurityAgency/ghidra/releases>（选 12.1.x 的
`ghidra_*_PUBLIC_*.zip`，Windows 用 zip，Linux 用 tar.gz）。

## 同步范围

| 内容 | 位置 | 方式 |
| --- | --- | --- |
| 包资源（extensions/skills/prompts/themes） | 仓库根目录各目录 | pi 包机制（`pi update --extensions`） |
| 全局设置 | `~/.pi/agent/settings.json` ↔ `config/pi/agent/settings.json` | pi-sync 扩展（顶层键级三方合并） |
| 已安装插件清单 | settings.json 的 `packages` 数组 | 并集合并；目标机自动 `pi install` 补装 |
| 键位绑定 | `keybindings.json` | pi-sync 扩展 |
| 本地扩展源码 | `~/.pi/agent/extensions/` ↔ `config/pi/agent/extensions/` | pi-sync 扩展（文件级三方合并） |

**合并语义**：packages 按并集收敛；同包不同版本按最后同步者胜（LWW）；删除通过墓碑传播，但仅当删除方机器**曾拥有**该包/键/文件（`accepted` 记账，v1.3 起）才传播——「从远端合并进树但尚未安装/落盘」不会被误判为删除。

**永不同步**：`auth.json`（凭证）、`web-search.json`（可能含搜索 API key，可用 `sync.includeFiles` 显式加回）、`trust.json`、`sessions/`、`models-store.json`、`npm/`、`git/`（后两者是 packages 清单的派生产物，不入库）。
机器相关设置键（`httpProxy`、`shellPath`、`npmCommand`、`sessionDir`、`externalEditor` 等）自动排除，可用 `sync.excludeKeys` 追加。

## 配置

`~/.pi/agent/settings.json`（`sync` 键本机有效，不参与同步）：

```jsonc
{
  "sync": {
    "repo": "git@github.com:SomeTestZero/pi-yyp-config.git",
    "enabled": true,     // 总开关
    "autoSync": true,    // 启动拉取 + 退出推送
    "excludeKeys": [],   // 额外排除的 settings 键
    "includeFiles": [],  // 额外纳入的文件，如 ["web-search.json"]
    "lanHosts": []       // 内网镜像主机（ssh 别名），退出 pi 时自动转发
  }
}
```

## 安全须知

- **仓库必须保持私有**。配置快照中虽不含 auth.json，但包含可执行的扩展代码——有仓库写权限等于能在所有机器上执行代码。
- git 认证复用系统 SSH key，扩展不接触任何 token。

## 旧脚本

`scripts/pi-sync`（bash/ps1）是 v0 方案，已被 pi-sync 扩展取代，保留一个版本周期后移除。
