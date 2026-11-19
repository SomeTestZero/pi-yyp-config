/**
 * pi-sync-guard —— 让 pi-sync 的「排除键清单」本身也能跨机同步。
 *
 * 背景：pi-sync 的 sync.excludeKeys 是本机配置（"sync" 键不参与同步），
 * 想在每台机器上排除 defaultProvider / defaultModel 就得逐台手改，机器一多必漏。
 *
 * 做法（本扩展零配置，且会随 pi-sync 的「本地扩展文件同步」自动分发到各机）：
 *   1. 内置底线 FLOOR：defaultProvider、defaultModel 永远视为机器相关键，
 *      强制并入本机 settings.json 的 sync.excludeKeys；
 *   2. 追加读取 settings.json 顶层键 "syncExcludeKeys"（普通键，随 settings
 *      三方合并同步），与 FLOOR 取并集后一并并入本机 excludeKeys。
 *      以后想加排除键，在任意一台机器上改 syncExcludeKeys 数组即可全局生效；
 *   3. 只维护「守卫加过的键」：用户在 excludeKeys 里手加的键不受影响；
 *      从 syncExcludeKeys 里移除的键会被同步移除（靠 agent 目录下的
 *      pi-sync-guard-state.json 区分，状态文件本机有效、不参与同步）。
 *
 * 时序：扩展工厂在 session_start 之前执行完毕，因此本机 excludeKeys 在
 * pi-sync 的启动同步读取配置前就已落盘生效。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FLOOR = ["defaultProvider", "defaultModel"];
const STATE_FILE = "pi-sync-guard-state.json";

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let added: string[] = [];
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = readJson(settingsPath);
    if (!settings || typeof settings !== "object") return;

    // 期望由守卫维护的键集合 = 内置底线 ∪ 同步来的 syncExcludeKeys
    const synced: string[] = Array.isArray(settings.syncExcludeKeys)
      ? settings.syncExcludeKeys.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    const desired = new Set<string>([...FLOOR, ...synced]);

    // 上次守卫写入的键，用于区分「守卫加的」与「用户手加的」
    const statePath = path.join(agentDir, STATE_FILE);
    const prevManagedRaw = readJson(statePath);
    const prevManaged: string[] = Array.isArray(prevManagedRaw?.managed) ? prevManagedRaw.managed : [];

    const sync = settings.sync && typeof settings.sync === "object" ? settings.sync : (settings.sync = {});
    const local: string[] = Array.isArray(sync.excludeKeys)
      ? sync.excludeKeys.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    const manual = local.filter((k) => !prevManaged.includes(k));
    const next = [...new Set([...manual, ...desired])];

    const same = next.length === local.length && next.every((k, i) => k === local[i]);
    if (!same) {
      sync.excludeKeys = next;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      added = next.filter((k) => !local.includes(k));
    }
    fs.writeFileSync(statePath, JSON.stringify({ managed: [...desired] }, null, 2) + "\n");
  } catch {
    // 守卫失败不阻塞 pi 启动
  }

  if (added.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      try {
        ctx.ui.notify(`pi-sync-guard：已将 ${added.join("、")} 加入本机同步排除键`, "info");
      } catch {}
    });
  }
}
