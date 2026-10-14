# pi-yyp-config

yyp 的个人 pi 配置仓库：**一个 GitHub 私有仓库同步所有 pi 配置**，多机一处维护。

本仓库同时是：

1. **pi 包**（`extensions/` 下的扩展通过 pi 包机制分发，含同步扩展 `pi-sync`）
2. **配置备份库**（`config/` 下存放各机共享的配置快照与合并元数据）

> ⚠️ 复制命令前先分清两类，**不要混在同一个代码块里粘**：
> - **终端命令**：`pi install ...` / `pi update ...`（在 shell 里执行）
> - **pi 内斜杠命令**：`/sync ...` / `/reload`（在 pi 的输入框里敲，shell 里执行会报 command not found）

## 快速上手

### 新机器接入

前置：本机已配置能访问该私有仓库的 SSH key（`ssh -T git@github.com` 有回应，且账号对仓库有权限）。

**① 终端里装包**（含同步扩展 pi-sync）：

```bash
pi install git:git@github.com:SomeTestZero/pi-yyp-config.git
```

**② 启动 pi，在 pi 输入框里执行**：

```text
/sync init git@github.com:SomeTestZero/pi-yyp-config.git --mode=remote
```

它把仓库克隆到 `~/.pi/sync-repo`，按「以远端为准」把共享配置落地本机；看到「配置已就位」后执行 `/reload`（或重开 pi）生效。

- 仓库地址已内置在扩展里，所以只敲 `/sync init` 再回车确认也行（默认就是本仓库）。
- `--mode=remote`：以远端为准（推荐新机器）。`--mode=local`：以本机为准，用于在配置最全的主力机上首次建仓。

### 包资源更新

`extensions/`、`skills/`、`prompts/`、`themes/` 走 pi 包机制分发，配置同步不会替你更新代码，需要时在终端执行：

```bash
pi update --extensions
```

## 日常：零操作

- **启动 pi** → 自动拉取并合并其他机器的改动（通知栏给摘要）
- **改了配置、装/删了插件** → **退出 pi 时自动推送**
- 两机改了同一配置键 → 下次手动 `/sync` 时弹窗选择保留哪边

### 命令

| 命令 | 在哪敲 | 作用 |
| --- | --- | --- |
| `/sync` | pi 内 | 一键同步：拉取 → 合并 → 推送（交互解决冲突） |
| `/sync status` | pi 内 | 查看本机与远端差异、待解决冲突、机器列表 |
| `/sync push` / `/sync pull` | pi 内 | 单向操作 |
| `/sync on` / `/sync off` | pi 内 | 开关本机的自动同步 |
| `/sync init [repo] [--mode=remote\|local]` | pi 内 | 新机器初始化（克隆到 `~/.pi/sync-repo`） |

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

分发：`rea-assist.ts` 放在 `config/pi/agent/extensions/`，经 pi-sync 的 **extensions 文件同步**
分发到各机 `~/.pi/agent/extensions/`（这是 pi-sync 的受管路径，同步合并不会误删）。

⚠️ **版本纪律**：`rea-assist.ts` 的 `REA_PKG_VERSION` 与
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
| 网页搜索设置 | pi-web-access 的生效 `web-search.json` ↔ `config/pi/web-search.json` | pi-sync 扩展（整文件；默认同步） |

**合并语义**：packages 按并集收敛；同包不同版本按最后同步者胜（LWW）；删除通过墓碑传播（任一台机器删了插件/文件/配置键，其他机器下次同步时同样删除）。

**包来源写法**（`packages` 数组）：

- 推荐 `git:git@github.com:SomeTestZero/pi-yyp-config.git`：SSH 克隆，复用本机 SSH key，私有仓库必需。
- `git:git@github.com:SomeTestZero/pi-yyp-config`（不带 `.git`）等价，pi 与 pi-sync 都会归一化成同一个包，不会装重。
- `git:github.com/SomeTestZero/pi-repo`（不带协议）会被 pi 当成 **HTTPS** 克隆，只适用于公开仓库。
- 装的是哪个字符串，`settings.json` 里就存哪个字符串：以你 `pi install` 时敲的为准，想统一写法就统一敲带 `.git` 的 SSH 形式。

**web-search.json 的路径**：pi-web-access 按 `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi`（有则优先，其次历史路径 `~/.pi`）→ `~/.pi/agent` 的顺序解析配置目录，pi-sync 复刻同一规则，只同步本机真正生效的那一份；历史路径文件如果存在，会跟随生效路径保持一致。

默认同步的字段通常只有 `workflow`（`none` = 不弹浏览器策展、`auto-summary` = 模型生成摘要不弹浏览器、`summary-review` = 打开浏览器策展页）。**含疑似密钥的机器会被自动跳过**（不推送、不被远端覆盖、也不传播删除），提示会出现在同步摘要里；如需显式排除用 `sync.excludeFiles`。

**永不同步**：`auth.json`（凭证）、`trust.json`、`sessions/`、`models-store.json`、`npm/`、`git/`（后两者是 packages 清单的派生产物，不入库）。
机器相关设置键（`httpProxy`、`shellPath`、`npmCommand`、`sessionDir`、`externalEditor` 等）自动排除，可用 `sync.excludeKeys` 追加。

## 配置

`~/.pi/agent/settings.json` 的 `sync` 键（**本机有效，不参与同步**）：

```jsonc
{
  "sync": {
    "repo": "git@github.com:SomeTestZero/pi-yyp-config.git",
    "enabled": true,     // 总开关
    "autoSync": true,    // 启动拉取 + 退出推送
    "machineId": "",     // 机器标识，默认取主机名；同名主机会互相覆盖
    "excludeKeys": [],   // 额外排除的 settings 键
    "includeFiles": [],  // 已无实际用途，仅保留兼容（web-search.json 现在默认同步）
    "excludeFiles": []   // 显式排除的文件，如 ["web-search.json"]
  }
}
```

工作克隆固定放在 `~/.pi/sync-repo`（可用 `PI_SYNC_HOME` / `PI_SYNC_WORK` 环境变量覆盖，便于测试）。

## 网页搜索不弹浏览器

pi-web-access 的 `web_search` 默认工作流是 `summary-review`：它会在本机起一个策展页（Windows/Linux 下调用默认浏览器打开，macOS 有 glimpse 时弹 TUI 小窗）等你确认摘要。不想看到浏览器，就在 pi-web-access 真正读取的配置里把工作流设成 `none`（纯搜索结果）或 `auto-summary`（模型生成摘要，不开浏览器）：

```jsonc
// 生效路径（Windows / 未设 XDG_CONFIG_HOME 时）：~/.pi/agent/web-search.json
{ "workflow": "none" }
```

改完 `/reload` 生效；该文件已由 pi-sync 默认同步，配置一次即全机同步。也可以随时用 `/curator off|auto-summary|on` 切换（它会写入同一个文件）。

> 老机器接入：先在那些机器上跑一次 `pi update --extensions`（pi-sync 自身走 pi 包机制分发），下次启动自动同步就会把 `workflow` 落地到它们各自的生效路径。

## 安全须知

- **仓库必须保持私有**。配置快照中虽不含 auth.json，但包含可执行的扩展代码——有仓库写权限等于能在所有机器上执行代码。
- git 认证复用系统 SSH key，扩展不接触任何 token。
- web-search.json 里的 API key 不会被同步（见上），请勿把它手动塞进本仓库。

## 旧脚本

`scripts/pi-sync`（bash）与 `scripts/pi-sync.ps1`（PowerShell）是 v0 方案，已被 pi-sync 扩展取代，保留一个版本周期后移除。
