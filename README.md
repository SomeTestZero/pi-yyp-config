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

## 同步范围

| 内容 | 位置 | 方式 |
| --- | --- | --- |
| 包资源（extensions/skills/prompts/themes） | 仓库根目录各目录 | pi 包机制（`pi update --extensions`） |
| 全局设置 | `~/.pi/agent/settings.json` ↔ `config/pi/agent/settings.json` | pi-sync 扩展（顶层键级三方合并） |
| 已安装插件清单 | settings.json 的 `packages` 数组 | 并集合并；目标机自动 `pi install` 补装 |
| 键位绑定 | `keybindings.json` | pi-sync 扩展 |
| 本地扩展源码 | `~/.pi/agent/extensions/` ↔ `config/pi/agent/extensions/` | pi-sync 扩展（文件级三方合并） |

**合并语义**：packages 按并集收敛；同包不同版本按最后同步者胜（LWW）；删除通过墓碑传播（任一台机器删了插件/文件/配置键，其他机器下次同步时同样删除）。

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
