# pi-yyp-config

yyp 的个人 pi 配置仓库：**一个 GitHub 私有仓库同步所有 pi 配置**，多机一处维护。

## 架构（v2，2026-11-19 起）

双通道 + 单写者 + 服务端围栏，根治旧版「旧客户端整树提交静默回退远端源码」的设计缺陷：

| 通道 | 分支 | 内容 | 写者 | 保护 |
|---|---|---|---|---|
| 源码 | `main` | 引擎与包源码（extensions/scripts/skills/…），**不含 config/** | 仅主力机（分支 → PR → 合并） | GitHub ruleset：禁直推/强推/删除 |
| 配置 | `sync`（孤儿分支） | `config/`（settings/keybindings/models/扩展副本/sync-state）+ `SYNC-PROTOCOL.json` | 所有机器（三方合并 + 墓碑） | 无（数据通道，可重建） |

关键性质：

- **包克隆永远干净**：同步逻辑不向包克隆提交任何东西，`pi update --extensions` 永远是纯 fast-forward。
  旧机器因此能自动升级到新引擎——「坏合并逻辑无法自愈」的死锁不复存在。
- **旧客户端推 main 会被 ruleset 直接拒绝**（响亮失败，不再静默破坏）。
- **同步失败不阻塞包更新**：包装脚本 warn-and-continue，源码通道永远可更新。
- **零 token 依赖**：日常同步全是 SSH git。源码推送默认「推分支 + 网页合并 PR」；
  可选放一个 fine-grained PAT 到 `~/.pi/agent/pi-sync-github-token`（仅本仓库，
  Contents/Pull requests/Administration 读写）升级为全自动 PR 合并 + ruleset API 创建。
  该文件本机私有，永不参与同步。

## 快速上手

### 新机器接入

```bash
pi install git:git@github.com:SomeTestZero/pi-yyp-config
pi          # 启动后执行：
/sync init git@github.com:SomeTestZero/pi-yyp-config.git --mode=remote
/sync install-update    # 装本机入口（一次性）
```

之后日常只需：

```bash
pi update --extensions   # 先完整同步（sync 分支），再 ff 更新所有包
```

### 主力机

- 改配置后：`/sync push`（或 `pi update --extensions`）。
- 改源码后：同样 `/sync push` —— 自动提交到 `src/<机器>-<时间戳>` 分支并推送，
  无 token 时给出 PR 链接（网页点两下合并）；有 token 时自动建 PR 并合并。
- 合并后其他机器下次 `pi update --extensions` 自动拿到新源码。

### 一次性迁移（已完成，留档）

```bash
node scripts/pi-sync-cli.mjs migrate-v2          # 播种 sync 分支 + main 移除 config/
node scripts/pi-sync-cli.mjs migrate-v2 --fence  # 启用 main ruleset（无 token 时给网页步骤）
```

其他机器无需手动干预：`pi update` 快进到新引擎后自动切换配置通道。

### 掉队旧机器恢复（围栏启用后）

旧引擎 + 旧包装的机器会「同步推 main 被拒 → 旧包装中止更新」卡住。恢复只需绕过包装直接更新一次：

```bash
~/.pi/agent/bin/pi.pi-real update --extensions   # Linux/macOS
pi.cmd update --extensions                        # Windows（绕过 PowerShell profile 包装）
```

更新到新引擎后一切自动恢复正常。

## 同步语义

- settings.json：顶层键级三方合并，packages 并集，排除键不同步（`sync.excludeKeys` +
  顶层 `syncExcludeKeys`，由 pi-sync-guard 分发）；`defaultProvider`/`defaultModel` 永远本机。
- keybindings.json / models.json：整文件三方合并。
- `~/.pi/agent/extensions/` 松散扩展文件：文件级三方合并（node_modules 除外；
  pi-sync.ts 本体不走文件同步，只走包源码通道，避免双份加载）。
- 删除通过墓碑（tombstone）传播；包卸载按 accepted/墓碑候选精确对账。
- 冲突：交互模式弹窗选择，自动模式跳过并挂起（`pi-sync-pending.json`）。
- 配置通道协议版本：`SYNC-PROTOCOL.json`，远端协议更新时拒绝写入并提示升级。

## 命令一览

```
/sync                 一键同步（拉取→合并→落地→补装→卸载对账→推送）
/sync push | pull | status | on | off
/sync init [repo] [--mode=remote|local]
/sync install-update  安装本机更新入口（包装 pi update --extensions）
/sync migrate-v2 [--fence]   一次性迁移 / 启用 main 保护
/sync lan <ssh主机>   内网镜像同步（注意：镜像需包含 sync 分支，见下）
```

CLI：`node scripts/pi-sync-cli.mjs <sync|install|fix-remotes|migrate-v2 [--fence]>`

## 已知边界

- `/sync lan` 内网镜像：v2 后配置数据在 sync 分支，镜像转发需同时携带 main 与 sync
  两个分支（旧镜像只有 main 时，消费端会提示「配置通道尚未迁移」并仅更新源码）。
- 源码单写者是约定 + 围栏（main 只走 PR），不是技术强制；多台主力机同时推源码 PR
  可能互相冲突，后合并者需 rebase（pi-sync 会保留分支现场并提示）。
- fine-grained PAT（若使用）最长一年过期；过期只影响「自动合并 PR」，
  日常同步与源码拉取不受影响，删掉 token 文件即回到零 token 手动模式。

## 历史教训（为什么是 v2）

v1 时代所有机器向 main 整树提交，旧客户端合并时保留自己的旧树 → 远端源码被静默回退
（2026-11-19 gxy 事故：pi-sync.ts 退回旧版、workbuddy/model-tree/CLI/REA skill 被删）。
且引擎经被合并通道分发，坏逻辑永远无法自愈。v1.5 的 commitMerge（read-tree 远端整树 +
覆盖 config/）只修好了新客户端；v2 用「源码/配置分通道 + main 单写者 + 服务端 ruleset」
把整类 bug 根治，并让旧机器经纯 ff 的源码通道自动收敛。