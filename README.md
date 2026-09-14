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

**web-search.json 的路径**：pi-web-access 按 `PI_CODING_AGENT_DIR` → `$XDG_CONFIG_HOME/pi`（有则优先，其次历史路径 `~/.pi`）→ `~/.pi/agent` 的顺序解析配置目录，pi-sync 复刻同一规则，只同步本机真正生效的那一份；历史路径文件如果存在，会跟随生效路径保持一致。

默认同步的字段通常只有 `workflow`（`none` = 不弹浏览器策展、`auto-summary` = 模型生成摘要不弹浏览器、`summary-review` = 打开浏览器策展页）。**含疑似密钥的机器会被自动跳过**（不推送、不被远端覆盖、也不传播删除），提示会出现在同步摘要里；如需显式排除用 `sync.excludeFiles`。

**永不同步**：`auth.json`（凭证）、`trust.json`、`sessions/`、`models-store.json`、`npm/`、`git/`（后两者是 packages 清单的派生产物，不入库）。
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
    "includeFiles": [],  // （已无实际用途，保留兼容；web-search.json 现在默认同步）
    "excludeFiles": []   // 显式排除的文件，如 ["web-search.json"]
  }
}
```

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

## 旧脚本

`scripts/pi-sync`（bash/ps1）是 v0 方案，已被 pi-sync 扩展取代，保留一个版本周期后移除。
