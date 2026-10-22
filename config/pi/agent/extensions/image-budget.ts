/**
 * pi-image-budget —— 给每轮请求的图片体积设硬上限，根治 `413 Request Entity Too Large` / `550`（网关掐断）。
 *
 * 背景：读图会把编码后的 base64 永久存进会话历史，之后**每轮请求都整包重发**。
 * 图片字节和 token 完全解耦（30+ 张图才 ~50k token，却 50MB），所以 token 触发的
 * compaction 永远救不了：实测 api.deepseek.com 前置 openresty，**45.3MB 还能通、
 * 49.3MB 立刻 550**（30s 空响应，重试亦然），再重发就是 413 —— 上限约 48MiB。
 *
 * 做法（两道闸，都在 `context` 事件里、只影响本次请求、不改写磁盘历史）：
 *   1. **历史窗口**：只保留「最后一轮 user 消息之前」最新 `historyKeep` 张图（默认 4，0 = 一张历史图都不发），
 *      更早的全部换成一行占位文本；当前这一轮读的图全部保留（A/B 对比在同一轮内完成）。
 *   2. **体积预算**：窗口内仍然超预算（同一轮读了一堆大图）就从最旧开始继续丢，直到降到预算内。
 *
 * 为什么还要留几张历史图：跨轮对比（“这版和上一版比”）。丢掉也能用——占位文本会告诉模型，
 * 需要时重读源文件的裁切小图（存量图 1600px 后只有 ~0.2MB）。
 *
 * 代价：每次丢弃会让被丢位置之后的 prompt cache 失效；窗口越小越省字节，但每轮新图都会跨过窗口边界。
 *
 * 预算：默认 24MB（约 26MB 请求体，离 48MiB 上限留 2× 余量），`PI_IMAGE_BUDGET_MB`
 * 环境变量可覆盖；`PI_IMAGE_HISTORY_IMAGES` 改历史窗口张数；`PI_IMAGE_BUDGET_DEBUG=1` 打字节数到 stderr；
 * `PI_IMAGE_BUDGET_OFF=1` 彻底关掉（排查/回滚用，图片就整包发了）。
 * 配套：`~/.pi/agent/models.json` 把单图压到 1600px / 1.5MB（编码时生效），
 * 让 24MB 预算内能装 16 张而不是 5 张。
 * 形状：`{ type:"image", data:<base64>, mimeType }`；占位文本是固定字符串，
 * 所以在丢图位置不变时后续请求仍能命中 prompt cache。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MB = 1024 * 1024;
const DEFAULT_BUDGET_MB = 24;
const HISTORY_KEEP = 4;
const PLACEHOLDER = "[历史图片已省略：只保留最近几张，需要时重新读取源文件的裁切小图]";

type Block = { type?: string; data?: unknown; text?: string };
type Msg = { role?: string; content?: unknown };

function imageBytes(block: Block): number {
  return block.type === "image" && typeof block.data === "string" ? block.data.length : 0;
}

export interface TrimResult {
  messages: Msg[];
  totalBytes: number;
  keptBytes: number;
  dropped: number;
  droppedByWindow: number;
  kept: number;
  changed: boolean;
}

/**
 * 纯函数：先按「历史窗口」只留最新 historyKeep 张旧图，再按体积预算从最旧继续丢。
 * 当前轮（最后一条 user 消息之后）的图默认全保留，只有超预算才丢。输入不被修改。
 */
export function trimImages(messages: Msg[], budgetBytes: number, historyKeep = 4): TrimResult {
  const spots: { mi: number; bi: number; bytes: number }[] = [];
  let totalBytes = 0;
  messages.forEach((m, mi) => {
    const content = m.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      const bytes = imageBytes(block as Block);
      if (bytes > 0) {
        spots.push({ mi, bi, bytes });
        totalBytes += bytes;
      }
    });
  });

  if (spots.length === 0) {
    return { messages, totalBytes: 0, keptBytes: 0, dropped: 0, droppedByWindow: 0, kept: 0, changed: false };
  }

  let lastUserIdx = -1;
  messages.forEach((m, mi) => {
    if (m.role === "user") lastUserIdx = mi;
  });
  const turnStart = lastUserIdx < 0 ? 0 : lastUserIdx;

  // 1) 历史窗口：当前轮之前的图只留最新 historyKeep 张
  const key = (s: { mi: number; bi: number }) => `${s.mi}:${s.bi}`;
  const historySpots = spots.filter((s) => s.mi < turnStart);
  const keep = new Set<string>(spots.filter((s) => s.mi >= turnStart).map(key));
  for (const s of historySpots.slice(Math.max(0, historySpots.length - Math.max(0, historyKeep)))) {
    keep.add(key(s));
  }

  const keptSpots = spots.filter((s) => keep.has(key(s)));
  let keptBytes = keptSpots.reduce((sum, s) => sum + s.bytes, 0);
  const droppedByWindow = spots.length - keptSpots.length;

  // 2) 体积预算：从窗内最旧的开始继续丢，直到进预算
  let droppedBudget = 0;
  for (const s of keptSpots) {
    if (keptBytes <= budgetBytes) break;
    keep.delete(key(s));
    keptBytes -= s.bytes;
    droppedBudget += 1;
  }

  if (droppedByWindow === 0 && droppedBudget === 0) {
    return { messages, totalBytes, keptBytes, dropped: 0, droppedByWindow: 0, kept: spots.length, changed: false };
  }

  const messagesOut = messages.map((m, mi) => {
    const content = m.content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const next = content.map((block, bi) => {
      if (keep.has(`${mi}:${bi}`) || imageBytes(block as Block) === 0) return block;
      touched = true;
      return { type: "text", text: PLACEHOLDER };
    });
    return touched ? { ...m, content: next } : m;
  });

  const dropped = droppedByWindow + droppedBudget;
  return {
    messages: messagesOut,
    totalBytes,
    keptBytes,
    dropped,
    droppedByWindow,
    kept: spots.length - dropped,
    changed: true,
  };
}

export default function imageBudget(pi: ExtensionAPI) {
  const budgetMb = Number(process.env.PI_IMAGE_BUDGET_MB) || DEFAULT_BUDGET_MB;
  const budgetBytes = budgetMb * MB;
  const historyKeep = Number(process.env.PI_IMAGE_HISTORY_IMAGES ?? HISTORY_KEEP);
  const off = /^(1|true|yes|on)$/i.test(process.env.PI_IMAGE_BUDGET_OFF ?? "");
  const debug = Boolean(process.env.PI_IMAGE_BUDGET_DEBUG);
  let lastDropped = -1;
  let lastResult: TrimResult | null = null;

  pi.registerCommand("imgbudget", {
    description: "查看本轮请求的图片体积 / 预算使用情况",
    handler: async (_args, ctx) => {
      if (!lastResult) {
        ctx.ui.notify(`图片：历史窗口 ${historyKeep} 张 · 预算 ${budgetMb}MB（本会话还没发过请求）`, "info");
        return;
      }
      const r = lastResult;
      ctx.ui.notify(
        `图片 ${r.kept + r.dropped} 张 · ${(r.totalBytes / MB).toFixed(1)}MB → 本轮送 ` +
          `${(r.keptBytes / MB).toFixed(1)}MB（历史窗口丢 ${r.droppedByWindow} 张 · 超预算再丢 ` +
          `${r.dropped - r.droppedByWindow} 张）· 窗口 ${historyKeep} 张 / 预算 ${budgetMb}MB`,
        r.changed ? "warning" : "info",
      );
    },
  });

  pi.on("context", async (event, ctx) => {
    if (off) return;
    const messages = event.messages as unknown as Msg[];
    const result = trimImages(messages, budgetBytes, historyKeep);
    lastResult = result;
    if (debug) {
      process.stderr.write(
        `[image-budget] images ${result.kept + result.dropped} · ${(result.totalBytes / MB).toFixed(1)}MB` +
          ` → keep ${result.kept} (${(result.keptBytes / MB).toFixed(1)}MB)` +
          ` · window -${result.droppedByWindow} · budget -${result.dropped - result.droppedByWindow}` +
          ` · window ${historyKeep} / budget ${budgetMb}MB\n`,
      );
    }
    if (!result.changed) {
      lastDropped = 0;
      return;
    }
    if (result.dropped !== lastDropped) {
      lastDropped = result.dropped;
      ctx.ui.notify(
        `历史图片只发最近 ${historyKeep} 张：丢 ${result.droppedByWindow} 张旧图` +
          (result.dropped > result.droppedByWindow ? `，超预算再丢 ${result.dropped - result.droppedByWindow} 张` : "") +
          `（${(result.totalBytes / MB).toFixed(1)}MB → ${(result.keptBytes / MB).toFixed(1)}MB，预算 ${budgetMb}MB）`,
        "warning",
      );
    }
    return { messages: result.messages as never };
  });
}
