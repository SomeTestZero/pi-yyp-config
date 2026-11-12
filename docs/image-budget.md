# image-budget：pi 请求体防爆（413 / 550 根治）

2026-10-21 落地。起因：一个 Krea2 出图评审会话跑到后半程突然连续报错，先 `550 status code (no body)`，再 `413 Request Entity Too Large`。

## 症状与定性

| 现象 | 实际含义 |
| --- | --- |
| `550 status code (no body)`，耗时正好 ~30.3s，重试亦然 | DeepSeek 前置网关（openresty）在请求体超限/超时时掐断连接，没有 JSON error body 可读 |
| 紧接着报 `413 <html>...openresty` | 同一件事的明确版：请求体超过网关 `client_max_body_size` |
| 上下文还很空（250k / 1M）、额度正常 | 与 token、余额无关 |

两次 30s 空响应 + 随后 413 = **请求体体积问题**，不是模型、不是密钥、不是上下文超限。

## 根因（三层）

1. **API 无状态**：每轮请求 = `system + 全部历史消息（含每张图的 base64）+ 新消息`。历史里的图每轮重新上传，prompt cache 只省计费和 prefill，**不省上传字节**。
2. **图片字节与 token 脱钩**：DeepSeek 每图最多计 ~1024 token（实测 26 张图 ≈ 23k token，不到上下文 10%），但字节是 **49MB**。而 compaction、上下文告警、`/context` 全部按 token 算 → 保护机制全部失灵，直到撞上网关上限。
3. **上限量级**：官方文档写明请求体 **48 MiB**。实测边界：45.3MB 能通、49.3MB 立刻挂。
   - ⚠️ 别数会话文件大小：文件里 35 张 / 65.7MB，但 compaction 之前的消息（含图）已经不参与发送，实际每轮只发 compaction 之后的 **26 张 / 49.3MB**。

## DeepSeek 视觉侧的硬规矩（决定了"多大才算够"）

来源：官方 `api-docs.deepseek.com/guides/vision`（`deepseek-flash` / V4.1）。

- **推理前必然重采样**：总像素 < 544×544 的会放大；更大的等比缩到总像素约 **1300×1300（≈1.7MP）**；每图 token 上限 **1024**。
- 精确规则是 token 网格：每边补齐到 **14px patch**，**3×3 patch = 1 个 token 格（42px）**，`行×(列+1)+2 ≤ 1024`
  - 方形上限 **1302×1302 / 994 token**
  - 16:9 上限 **1708×966 / 968 token**
- 其它限制：单图 ≤ 32 MiB、请求体 ≤ **48 MiB**、≤ 600 张、单边 8192px（**一轮 ≥15 张时降到 4096**）。
- 图片只能出现在 `user` 消息里（system/assistant 会 400）。pi 把工具结果里的图另包成一条 user 消息再发，所以 `read` 读图不受影响。

**推论**：

| 送出去 | token 格 | 服务端最终 |
| --- | --- | --- |
| 4096×2304（整张渲染图） | 5447 ❌ | 缩到 1708×966，丢掉 80% 像素 |
| 2048×1152 | 1402 ❌ | 缩到 1708×966 |
| 1600×900 | 882 ✅ | 原样（用满网格的 87%） |
| 1600×1600（方形源） | 1562 ❌ | 服务端再缩到 1302×1302（白发约 40% 上传字节） |
| 1000×1000（裁切） | 602 ✅ | 原样 |

→ 读整张大图对模型零信息增量；判细节只能给裁切，裁切有用上限就是 1300×1300（方形）/ 约 1700×950（16:9）。

## 修法：两道闸

### 1）扩展 `~/.pi/agent/extensions/image-budget.ts`

挂 pi 的 `context` 事件（**每轮 LLM 调用前**触发；只改本次请求，不动磁盘历史）：

1. **历史窗口**：最后一条 `user` 消息之前的图，只留最新 `historyKeep` 张（默认 **4**，`PI_IMAGE_HISTORY_IMAGES=0` 即历史图一张不发），更早的换成一行固定占位文本。当前这一轮读的图全保留（A/B 对比在同一轮内完成）。
2. **体积预算**：窗内仍超就从最旧继续丢，直到 ≤ 预算（默认 **24MB**，比 48 MiB 留 2× 余量）。

占位文本：`[历史图片已省略：只保留最近几张，需要时重新读取源文件的裁切小图]`。固定字符串 → 丢图位置不变的后续请求仍能命中 prompt cache。

### 2）配置 `~/.pi/agent/models.json`

```json
{ "providers": { "deepseek": { "modelOverrides": { "deepseek-flash": {
  "inputLimits": { "images": { "resize": {
    "maxWidth": 1600, "maxHeight": 1600,
    "maxBytes": 1572864, "jpegQuality": 82 } } } } } } } }
```

编码入库时生效（不改旧历史）：4096×2304 / 12MB 的 PNG，`read` 结果从 ~4MB 降到 **0.22MB**。24MB 预算内可装 16 张 1.5MB 的图，常规会话根本碰不到上限。

## 为什么不用 pi 内建开关

- `images.autoResize`（默认 true，2000px）— 只控单图，不管历史累积。
- `images.blockImages`（默认 false）— 一刀切全禁，太粗。
- 模型目录可声明 `inputLimits.maxRequestBytes` / `images.maxPerRequest`，但官方文档明确："Pi does not yet rewrite or reject history based on them" —— 只声明，不执行。
- compaction 只看 token，图片字节不进账（见根因 2）。

→ "每轮按体积/窗口裁历史图"只有 `context` 钩子这一个官方入口，所以用扩展，不改 pi 源码、不打 patch，`pi update` 不受影响。

## 用法 / 旋钮

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `/imgbudget` | — | 查本轮图片张数、原体积、送出去多少、窗口丢几张、超预算再丢几张 |
| `PI_IMAGE_HISTORY_IMAGES` | 4 | 历史窗口张数；0 = 历史图全不发；设大（如 60）= 平时根本不裁，只靠预算兜底（缓存零影响） |
| `PI_IMAGE_BUDGET_MB` | 24 | 每轮图片体积硬上限 |
| `PI_IMAGE_BUDGET_DEBUG` | 关 | 每轮把 `images N · X MB → keep M (Y MB) · window -a · budget -b` 打到 stderr |
| `PI_IMAGE_BUDGET_OFF` | 关 | 彻底停用（排查/回滚，图片恢复整包发送） |

## 验证记录（10-21）

- **对照实验**（同一份 49.3MB 会话，`pi --fork <sess> -p ... --no-tools`）：
  - 预算 64MB（相当于关闸）→ `[image-budget] images 26 · 49.3MB → 49.3MB (drop 0)`，然后 **413**
  - 预算 24MB → `49.3MB → 21.6MB`，正常出结果
- **历史窗口**：单轮 `read` 5 张图后再发一轮 → `images 5 · window -1`（留 4 张）；`PI_IMAGE_HISTORY_IMAGES=0` → `window -5`
- **单图编码**：4096×2304 PNG 的 `read` 结果 = 218836 字节（0.22MB）
- **单元测试**：`my_temp_test/test_image_budget.cjs`（jiti 直跑 TS，16 checks）= 窗口留最新 N / 窗口 0 / 窗口+预算叠加 / 当前轮必留 / 单张超预算 / 无 user 消息 / 输入不被改写 / 恰好等于预算

## 与 prompt cache 的关系

缓存是**前缀匹配**：只有"某张图被丢"的那一刻，从那张图往后失效；被丢的总是最旧那张，所以重算是"最近几张图 + 其间文字"这一小段，通常 5k–20k token。按 DeepSeek 价（input $0.3/M、cacheRead $0.006/M）≈ **$0.006/次**。

- 窗口越小 → 翻转点越靠尾 → 失效越短（`HISTORY_IMAGES=0` 对缓存最友好）。
- 但既然单图已压到 0.22MB，24MB 预算本身很难触发；若在意缓存可把窗口设大（如 60），让裁剪只在真攒到大图时才发生。

## 维护与回滚

- 扩展只依赖两个公开 API：`pi.on("context")`（返回替换后的 messages）和 `pi.registerCommand`。上游签名变更时 pi 只会报一条 extension error，不崩会话 —— 改两行适配或直接删文件即可。
- 回滚阶梯：`PI_IMAGE_BUDGET_OFF=1`（临时）→ 删/改名 `image-budget.ts`（停扩展）→ 删 `models.json` 里那段 override（恢复 2000px / 4.5MB 默认编码）。
- 数字口径（48 MiB、1300×1300、1024 token、≥15 张时单边 4096）来自 2026-10-21 的官方文档；官方改规则时以文档为准重新核算。

## 关联

- 本机业务侧记录：`E:\ComfyUI\本地环境备忘.md`「环境坑」
- 事故会话：`~/.pi/agent/sessions/--E--ComfyUI--/2026-10-21T03-22-03-479Z_01a15c7a-*.jsonl`
- 复现/统计口径：扫会话 jsonl 里的 `image` 块，累加 `data.length`，只算最后一个 `compaction` 条目之后
