/**
 * pi-image-budget —— 给每轮请求的图片体积设硬上限，根治 `413 Request Entity Too Large` / `550`（网关掐断）。
 *
 * 背景：读图会把编码后的 base64 永久存进会话历史，之后**每轮请求都整包重发**。
 * 图片字节和 token 完全解耦（35 张图才 ~50k token，却 65.7MB），所以 token 触发的
 * compaction 永远救不了：实测 api.deepseek.com 前置 openresty 上限约 64MB，
 * 61.7MB 还能通、65.7MB 立刻 550（30s 空响应），再重发就是 413。
 *
 * 做法：在 `context` 事件里（每轮 LLM 调用前、只影响本次请求、不改写磁盘历史）
 * 统计所有 image 块体积，超预算就**从最旧的开始**把 base64 换成一行占位文本，
 * 直到降到预算内。最近的图片永远优先保留，所以刚读的图不会被丢掉。
 *
 * 预算：默认 32MB，`PI_IMAGE_BUDGET_MB` 环境变量可覆盖（网关上限未知/更小的模型可调低）。
 * 形状：`{ type:"image", data:<base64>, mimeType }`；同一张图被丢掉的占位文本固定，
 * 便于多轮之间命中 prompt cache（只有跨过阈值那一刻会有一次前缀失效）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MB = 1024 * 1024;
const DEFAULT_BUDGET_MB = 32;
const PLACEHOLDER = "[历史图片已省略：本轮请求图片体积超上限]";

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
  kept: number;
  changed: boolean;
}

/** 纯函数：超预算时从最旧的图片开始替换为占位文本。输入不被修改。 */
export function trimImages(messages: Msg[], budgetBytes: number): TrimResult {
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

  if (totalBytes <= budgetBytes) {
    return { messages, totalBytes, keptBytes: totalBytes, dropped: 0, kept: spots.length, changed: false };
  }

  // 从最旧往后丢，丢到进预算为止；万一单张就超预算，继续丢直到全都不剩。
  const dropAt = new Set<string>();
  let keptBytes = totalBytes;
  let dropped = 0;
  for (const s of spots) {
    if (keptBytes <= budgetBytes) break;
    dropAt.add(`${s.mi}:${s.bi}`);
    keptBytes -= s.bytes;
    dropped += 1;
  }

  const messagesOut = messages.map((m, mi) => {
    const content = m.content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const next = content.map((block, bi) => {
      if (!dropAt.has(`${mi}:${bi}`) || imageBytes(block as Block) === 0) return block;
      touched = true;
      return { type: "text", text: PLACEHOLDER };
    });
    return touched ? { ...m, content: next } : m;
  });

  return { messages: messagesOut, totalBytes, keptBytes, dropped, kept: spots.length - dropped, changed: true };
}

export default function imageBudget(pi: ExtensionAPI) {
  const budgetMb = Number(process.env.PI_IMAGE_BUDGET_MB) || DEFAULT_BUDGET_MB;
  const budgetBytes = budgetMb * MB;
  let lastDropped = -1;

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as unknown as Msg[];
    const result = trimImages(messages, budgetBytes);
    if (!result.changed) {
      lastDropped = 0;
      return;
    }
    if (result.dropped !== lastDropped) {
      lastDropped = result.dropped;
      ctx.ui.notify(
        `图片超预算：丢 ${result.dropped} 张历史图（${(result.totalBytes / MB).toFixed(1)}MB → ` +
          `${(result.keptBytes / MB).toFixed(1)}MB / 上限 ${budgetMb}MB），最近 ${result.kept} 张保留`,
        "warning",
      );
    }
    return { messages: result.messages as never };
  });
}
