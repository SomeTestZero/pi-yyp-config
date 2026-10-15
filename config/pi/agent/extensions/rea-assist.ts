import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * rea-assist — REA（Reverse Engineer Anything）逆向工具的启用助手
 *
 * 背景：REA 的官方 setup 会把 MCP 注册写成「机器相关的绝对路径」
 * （Windows 上是 node.exe + npx 缓存路径），放进 pi-sync 同步必然互相打坏，
 * 所以这里改为「启动提示 + 按需启用」：
 *
 *   - 启动时若 REA 未启用 → 提示一条：/rea on
 *   - /rea on       本会话即时启用（registerMcpServer，无需重启）
 *   - /rea off      本会话停用
 *   - /rea auto on  写 settings.json 的 reaAssist.autoEnable=true；该键随
 *                   pi-sync 同步到所有机器 → 全机每次启动自动启用（全自动）
 *   - /rea          状态
 *
 * 注册形态用「node + npx-cli.js + rea-agents@固定版本」的可移植写法，
 * Windows/Linux 同一份配置均可用，不依赖 PATH 里 npx 的解析方式。
 *
 * 版本纪律：REA_PKG_VERSION 与仓库 skills/reverse-engineer-anything/ 必须
 * 来自同一个 rea-agents 版本，升级时同一提交里一起改（skill 的 metadata
 * version/tool_count 会和工具实际数量对不上）。
 *
 * 环境变量：REA_ASSIST=0 临时禁用本扩展的自动启用（单机逃生口）。
 */

const REA_PKG_VERSION = "6.4.0";
const REA_SERVER = "rea";
const REA_SKILL = "reverse-engineer-anything";

// ---------- 路径 ----------

function agentDir(): string {
  const d = process.env.PI_CODING_AGENT_DIR;
  if (d && path.isAbsolute(d)) return d;
  return path.join(os.homedir(), ".pi", "agent");
}
function mcpJsonPath(): string {
  return path.join(agentDir(), "mcp.json");
}
function settingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

// ---------- JSON 小工具 ----------

function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p: string, v: unknown): void {
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

// ---------- 状态探测 ----------

function persistentRea(): boolean {
  const j = readJson(mcpJsonPath());
  return !!(j && j.mcpServers && typeof j.mcpServers === "object" && REA_SERVER in j.mcpServers);
}

function autoEnabled(): boolean {
  const s = readJson(settingsPath());
  return !!(s && s.reaAssist && s.reaAssist.autoEnable === true);
}

function setAuto(on: boolean): void {
  const p = settingsPath();
  const s = readJson(p) ?? {};
  s.reaAssist = { ...(s.reaAssist ?? {}), autoEnable: on };
  writeJson(p, s);
}

function skillPaths(): string[] {
  const out = [
    path.join(agentDir(), "skills", REA_SKILL, "SKILL.md"),
    path.join(os.homedir(), ".agents", "skills", REA_SKILL, "SKILL.md"),
  ];
  try {
    // 本扩展位于 <包根>/extensions/，skill 随包在 <包根>/skills/ 分发
    if (typeof __dirname !== "undefined") {
      out.push(path.join(__dirname, "..", "skills", REA_SKILL, "SKILL.md"));
    }
  } catch {
    /* ESM 环境没有 __dirname，忽略 */
  }
  return out;
}

function skillFound(): string | null {
  return skillPaths().find((p) => fs.existsSync(p)) ?? null;
}

// ---------- Ghidra 探测 ----------

/**
 * 自动探测 Ghidra 12.1.x 安装（含 support/analyzeHeadless），返回安装目录。
 * 已设 GHIDRA_INSTALL_DIR 环境变量时优先；否则扫常见安装位置取最高版本。
 * 这样任何机器装好 Ghidra 就零配置接上，无需跑 rea setup。
 */
function detectGhidra(): string | null {
  const env = process.env.GHIDRA_INSTALL_DIR;
  if (env && fs.existsSync(path.join(env, "support"))) return env;
  const roots =
    process.platform === "win32"
      ? ["C:\\Tools", "C:\\tools", "C:\\", path.join(os.homedir(), "Tools"), path.join(os.homedir(), "tools"), os.homedir(), "C:\\Program Files"]
      : ["/opt", "/usr/share", "/usr/local", path.join(os.homedir(), "tools"), path.join(os.homedir(), "Tools"), os.homedir()];
  let best: { dir: string; ver: string } | null = null;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/^ghidra/i.test(e)) continue;
      const dir = path.join(root, e);
      const ok = ["analyzeHeadless.bat", "analyzeHeadless"].some((f) =>
        fs.existsSync(path.join(dir, "support", f)),
      );
      if (!ok) continue;
      const m = e.match(/(\d+\.\d+(?:\.\d+)?)/);
      const ver = m ? m[1] : "0";
      if (!best || ver.localeCompare(best.ver, undefined, { numeric: true }) > 0) best = { dir, ver };
    }
  }
  return best?.dir ?? null;
}

/** JDK 主目录：JAVA_HOME 优先，否则扫常见位置（java 在 PATH 时 REA 也能自找）。 */
function detectJava(): string | null {
  const env = process.env.JAVA_HOME;
  if (env && fs.existsSync(path.join(env, "bin"))) return env;
  const roots =
    process.platform === "win32"
      ? ["C:\\Program Files\\Microsoft", "C:\\Program Files\\Java", "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Zulu"]
      : ["/usr/lib/jvm", "/usr/java", "/opt/java"];
  let best: { dir: string; ver: string } | null = null;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!/(jdk|jre|java|zulu|temurin|adoptium)/i.test(e)) continue;
      const dir = path.join(root, e);
      const ok = ["javac.exe", "javac"].some((f) => fs.existsSync(path.join(dir, "bin", f)));
      if (!ok) continue;
      const m = e.match(/(\d+)/);
      const ver = m ? m[1] : "0";
      if (!best || ver.localeCompare(best.ver, undefined, { numeric: true }) > 0) best = { dir, ver };
    }
  }
  return best?.dir ?? null;
}

function reaProviderEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const ghidra = detectGhidra();
  if (ghidra) env.GHIDRA_INSTALL_DIR = ghidra;
  const java = detectJava();
  if (java) env.JAVA_HOME = java;
  return env;
}

// ---------- Ghidra 一键安装 ----------

/** 与 REA 验证基准一致的默认版本；REA 支持 12.1.x。 */
export const GHIDRA_PINNED = "12.1.4";

export async function ghidraDownloadUrl(ver: string): Promise<{ url: string; name: string }> {
  const api = `https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_${ver}_build`;
  const res = await fetch(api, { headers: { "User-Agent": "pi-yyp-config-rea-assist" } });
  if (!res.ok) throw new Error(`查询 GitHub 发布失败：HTTP ${res.status}（${api}）`);
  const rel: any = await res.json();
  const asset = (rel.assets ?? []).find((a: any) => /^ghidra_.*PUBLIC.*\.(zip)$/i.test(a.name));
  if (!asset) throw new Error(`未找到 Ghidra ${ver} 的发布包（tag: Ghidra_${ver}_build）`);
  return { url: asset.browser_download_url, name: asset.name };
}

function ghidraInstallRoots(): string[] {
  return process.platform === "win32"
    ? ["C:\\Tools", "C:\\tools", path.join(os.homedir(), "Tools")]
    : ["/opt", path.join(os.homedir(), "tools"), path.join(os.homedir(), "Tools")];
}

function pickWritableDir(roots: string[]): string {
  for (const r of roots) {
    try {
      fs.mkdirSync(r, { recursive: true });
      fs.accessSync(r, fs.constants.W_OK);
      return r;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(`没有可写的安装位置（试过：${roots.join("、 ")}）`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    ),
  );
}

async function extractZip(zip: string, dest: string): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dest}'`,
    ]);
    return;
  }
  const tries: [string, string[]][] = [
    ["unzip", ["-q", "-o", zip, "-d", dest]],
    ["python3", ["-m", "zipfile", "-e", zip, dest]],
  ];
  for (const [cmd, args] of tries) {
    try {
      await run(cmd, args);
      return;
    } catch {
      /* 试下一个 */
    }
  }
  await run("jar", ["-xf", zip], dest); // JDK 的 jar 总是可用（Ghidra 本身要求 JDK）
}

/** 一键安装 Ghidra：下载官方 zip → 解压 → 落到标准位置，返回安装目录。 */
export async function installGhidra(ver: string = GHIDRA_PINNED, roots?: string[]): Promise<string> {
  const parent = pickWritableDir(roots ?? ghidraInstallRoots());
  const target = path.join(parent, `ghidra_${ver}_PUBLIC`);
  if (fs.existsSync(path.join(target, "support"))) return target; // 已安装，幂等
  const { url } = await ghidraDownloadUrl(ver);
  const zip = path.join(parent, `.ghidra-download-${process.pid}.zip`);
  const stage = path.join(parent, `.ghidra-extract-${process.pid}`);
  try {
    await download(url, zip);
    fs.mkdirSync(stage, { recursive: true });
    await extractZip(zip, stage);
    const root = fs
      .readdirSync(stage)
      .map((e) => path.join(stage, e))
      .find((p) => fs.existsSync(path.join(p, "support")));
    if (!root) throw new Error("解压结果里没找到 Ghidra 根目录（缺 support/）");
    fs.renameSync(root, target);
  } finally {
    try {
      fs.rmSync(zip, { force: true });
    } catch { /* ignore */ }
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  return target;
}

// ---------- MCP 注册 ----------

/**
 * Windows 上直接 spawn "npx" 依赖客户端的 .cmd 解析；用
 * node + npx-cli.js 在所有平台都最稳，且同样按固定版本拉包。
 */
function npxLaunch(): { command: string; args: string[] } {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), // Windows 安装器布局
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"), // Linux/macOS
  ];
  for (const cli of candidates) {
    if (fs.existsSync(cli)) return { command: process.execPath, args: [cli] };
  }
  return { command: "npx", args: [] };
}

function reaMcpConfig(): any {
  const { command, args } = npxLaunch();
  return {
    command,
    args: [...args, "-y", `rea-agents@${REA_PKG_VERSION}`, "mcp"],
    exposure: "codemode",
    description: "Reverse-engineering tools (REA) for binaries, apps, and runtimes.",
    env: reaProviderEnv(),
  };
}

// ---------- 扩展 ----------

export default function (pi: ExtensionAPI) {
  let sessionRegistered = false;

  function registerRea(): void {
    try {
      pi.registerMcpServer(REA_SERVER, reaMcpConfig());
      sessionRegistered = true;
    } catch (e) {
      // 同名服务器已由别的扩展注册时抛错；mcp.json 同名条目优先，不抛
      throw new Error(`注册 REA MCP 失败：${(e as Error).message}`);
    }
    // exposure=codemode 的工具要经 codemode 脚本调用，确保 codemode 在工具集里
    try {
      const active = pi.getActiveTools();
      if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
    } catch {
      // codemode 未注册等极端情况：不影响 MCP 连接，工具仍可被 tool_search 发现
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.REA_ASSIST === "0") return;
    if (persistentRea()) return; // 已有持久注册，交给 mcp.json
    if (autoEnabled()) {
      try {
        registerRea();
      } catch {
        /* 启动不因扩展失败而中断 */
      }
      return;
    }
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      `REA 逆向分析未启用 —— 需要分析二进制 / App / 网页时输入 /rea on（本会话即时启用）；想以后全自动：/rea auto on`,
      "info",
    );
  });

  pi.registerCommand("rea", {
    description: "REA 逆向工具：/rea on|off|status|auto on|off（/rea help 详情）",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

      const status = () => {
        const skill = skillFound();
        const ghidra = detectGhidra();
        const java = detectJava();
        const lines = [
          `REA 状态（rea-agents@${REA_PKG_VERSION}）`,
          `· 持久注册（mcp.json）：${persistentRea() ? "有" : "无"}`,
          `· 本会话注册：${sessionRegistered ? "已启用" : "未启用"}`,
          `· 启动自动启用（reaAssist.autoEnable，随 pi-sync 同步）：${autoEnabled() ? "开" : "关"}`,
          `· skill（${REA_SKILL}）：${skill ? skill : "未检测到 SKILL.md（若 pi 包已装则仍可用，以 skill 命令列表为准）"}`,
          `· Ghidra（原生分析引擎）：${ghidra ?? "未检测到——JS/.NET/Go 等静态分析不受影响；/rea ghidra install 一键安装"}`,
          `· JDK：${java ?? "未检测到（java 在 PATH 时 REA 也能自找；Linux：apt install openjdk-21-jdk）"}`,
          `· 用法：/rea on 启用本会话 | /rea auto on 全机自动 | /rea off 关闭`,
        ];
        ui.notify(lines.join("\n"), "info");
      };

      switch ((sub ?? "").toLowerCase()) {
        case "":
        case "status":
        case "状态":
          status();
          return;

        case "on":
        case "开":
          if (persistentRea()) {
            ui.notify("REA 已持久注册（mcp.json），重启 pi 即生效，无需 /rea on。", "info");
            return;
          }
          try {
            registerRea();
          } catch (e) {
            ui.notify((e as Error).message, "error");
            return;
          }
          ui.notify(
            `REA 已在本会话启用（rea-agents@${REA_PKG_VERSION}，即时生效）。\n` +
              `直接对模型说「用 REA 分析 xxx」即可；想以后每次启动自动启用：/rea auto on`,
            "info",
          );
          return;

        case "off":
        case "关":
          try {
            pi.unregisterMcpServer(REA_SERVER);
            sessionRegistered = false;
            ui.notify("REA 已在本会话停用。", "info");
          } catch {
            ui.notify("本会话没有可停用的 REA 注册。", "info");
          }
          return;

        case "auto": {
          const v = (rest[0] ?? "").toLowerCase();
          if (v !== "on" && v !== "off") {
            ui.notify("用法：/rea auto on|off（写入 settings 的 reaAssist.autoEnable，随 pi-sync 同步到所有机器）", "info");
            return;
          }
          setAuto(v === "on");
          ui.notify(
            v === "on"
              ? "已开启启动自动启用。该设置会随 pi-sync 同步到所有机器；单机临时关闭可设环境变量 REA_ASSIST=0。"
              : "已关闭启动自动启用（其他机器不受影响，如需同步关闭请在任一机器 /rea auto off 后 /sync）。",
            "info",
          );
          return;
        }

        case "ghidra": {
          const sub2 = (rest[0] ?? "status").toLowerCase();
          if (sub2 === "status") {
            const g = detectGhidra();
            ui.notify(
              `Ghidra：${g ?? "未安装"}\n默认安装版本：${GHIDRA_PINNED}（REA 验证基准；支持 12.1.x）\n安装：/rea ghidra install [版本]（约 570MB，装完自动接入）`,
              "info",
            );
            return;
          }
          if (sub2 === "install") {
            const ver = rest[1] ?? GHIDRA_PINNED;
            if (detectGhidra() && !rest[1]) {
              ui.notify(`Ghidra 已安装：${detectGhidra()}。换版本：/rea ghidra install <版本>`, "info");
              return;
            }
            ui.notify(`正在下载并安装 Ghidra ${ver}（约 570MB，需 1-3 分钟）……`, "info");
            try {
              const dir = await installGhidra(ver);
              const java = detectJava();
              ui.notify(
                `Ghidra ${ver} 已装好：${dir}\nJDK：${java ?? "未检测到——请安装 JDK 21+（Linux：apt install openjdk-21-jdk）"}\n${
                  java ? "下次 /rea on 或重启 pi 自动接入原生分析。" : "装好 JDK 后自动接入。"
                }`,
                "info",
              );
            } catch (e) {
              ui.notify(`Ghidra 安装失败：${(e as Error).message}`, "error");
            }
            return;
          }
          ui.notify(
            `用法：/rea ghidra status | /rea ghidra install [版本]（默认 ${GHIDRA_PINNED}）`,
            "info",
          );
          return;
        }

        case "help":
        case "帮助":
          ui.notify(
            [
              "/rea            查看状态",
              "/rea on         本会话即时启用 REA（无需重启）",
              "/rea off        本会话停用 REA",
              "/rea auto on    启动自动启用（随 pi-sync 同步到全机）",
              "/rea auto off   取消自动启用",
              "/rea ghidra install [版本]  一键安装 Ghidra（原生分析引擎）",
              "/rea ghidra status          Ghidra 安装状态",
              `skill 随 pi 包 skills/${REA_SKILL} 分发，工具说明在 skill 内。`,
            ].join("\n"),
            "info",
          );
          return;

        default:
          ui.notify(`未知子命令：${sub}（/rea help 查看用法）`, "info");
      }
    },
  });

  // 供诊断：官方安装器一键持久化（机器本地，不做同步）。异步跑完提示。
  pi.registerCommand("rea-setup", {
    description: "运行 REA 官方安装器做持久注册（机器本地；与 /rea auto 二选一）",
    handler: async (_args, ctx) => {
      const { command, args: npxArgs } = npxLaunch();
      ctx.ui.notify("正在运行 rea-agents setup（官方安装器）……", "info");
      execFile(
        command,
        [...npxArgs, "-y", `rea-agents@${REA_PKG_VERSION}`, "setup", "--client", "pi", "--yes", "--skill=false"],
        { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            ctx.ui.notify(`setup 失败：${stderr.slice(-500) || err.message}`, "error");
          } else {
            ctx.ui.notify("持久注册完成（写入本机 mcp.json）。重启 pi 或 /reload 后生效。", "info");
          }
        },
      );
    },
  });
}
