# pi-yyp-config

yyp 的个人 pi 配置仓库：**一个 GitHub 仓库同步所有 pi 配置**，多机一处维护。

- **包资源**（extensions / skills / prompts / themes）：pi 原生机制自动同步
- **全局配置文件**（settings.json / keybindings.json / web-search.json）：由 `pi-sync` 脚本同步

## 新机器一键恢复

```bash
bash <(curl -sL https://raw.githubusercontent.com/SomeTestZero/pi-yyp-config/main/scripts/pi-sync) restore
```

或者手动：

```bash
git clone git@github.com:SomeTestZero/pi-yyp-config ~/.pi/agent/git/github.com/SomeTestZero/pi-yyp-config
bash ~/.pi/agent/git/github.com/SomeTestZero/pi-yyp-config/scripts/pi-sync restore
```

`restore` 会克隆仓库、还原 `~/.pi` 下的配置文件（覆盖前自动备份为 `*.bak-时间戳`）。
settings.json 中的 `packages` 列表随配置一起还原，重启 pi 即加载本包。

## 日常使用

```bash
pi-sync save      # 本机 -> GitHub：导出配置 + 提交推送（含扩展改动）
pi-sync pull      # GitHub -> 本机：还原配置（自动备份）
pi-sync status    # 查看本机与仓库的差异
```

脚本位于 `scripts/pi-sync`（bash，Git Bash / Linux / macOS 通用），Windows 另有 PowerShell 入口 `scripts/pi-sync.ps1`。建议加别名：

```bash
# ~/.bashrc 或 ~/.bash_profile
alias pi-sync='bash ~/.pi/agent/git/github.com/SomeTestZero/pi-yyp-config/scripts/pi-sync'
```

```powershell
# PowerShell $PROFILE
Set-Alias pi-sync "$env:USERPROFILE\.pi\agent\git\github.com\SomeTestZero\pi-yyp-config\scripts\pi-sync.ps1"
```

在 pi 会话里也可以直接让 agent 执行 `pi-sync save`。

## 同步范围

| 内容 | 位置 | 方式 |
| --- | --- | --- |
| 扩展、技能、提示词、主题 | `extensions/ skills/ prompts/ themes/` | pi 包机制（`pi update --extensions`） |
| 全局设置 | `~/.pi/agent/settings.json` → `config/pi/agent/` | `pi-sync save/pull` |
| 键位绑定 | `~/.pi/agent/keybindings.json` → `config/pi/agent/` | `pi-sync save/pull` |
| web-search 配置 | `~/.pi/web-search.json` → `config/pi/` | `pi-sync save/pull` |

**永不同步**（敏感或与机器绑定）：

- `auth.json`（登录凭证 / API key）—— 除非显式 `pi-sync pull --with-auth` 且仓库为私有
- `trust.json`（项目信任决策，每台机器应独立确认）
- `sessions/`、`models-store.json`（缓存）、`npm/`、`git/`、`web-search-cache/`

## 注意事项

1. **先 save 再 update**：pi 的 `pi update --extensions` 会把包克隆重置到远端分支，
   未推送的本地改动会被清掉。养成改完就 `pi-sync save` 的习惯即可（save 自动提交推送）。
2. **当前仓库是 public**：不要用 `--with-auth` 同步凭证，也不要在 settings.json
   里写明文 apiKey。想要同步凭证，先把仓库改为 Private（`gh repo edit --visibility private`）。
3. 本仓库以 `git:git@github.com:SomeTestZero/pi-yyp-config` 安装（无固定 ref），
   `pi update --extensions` 会自动跟进 main 最新提交。

## 当前包含

| 资源 | 说明 |
| --- | --- |
| `extensions/wheel-scroll.ts` | 全屏模式滚轮速度修复，`/wheel <n>` 设置每次滚动的行数（默认 3） |

## 安装（首次作为 pi 包使用）

```bash
pi install git:git@github.com:SomeTestZero/pi-yyp-config   # SSH
pi install git:github.com/SomeTestZero/pi-yyp-config       # 或 HTTPS
```
