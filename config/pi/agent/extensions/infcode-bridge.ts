/**
 * InfCode Bridge for pi
 * 目标: 让 pi 使用 InfCode(VSCode插件) 的企业模型与额度。
 *
 * 工作原理:
 *  1. 定位 InfCode 插件捆绑的 CLI 二进制 (opencode 系)
 *  2. 查询运行中的 CLI 进程(由 VSCode 插件拉起)获取端口/参数
 *  3. 扫描 ~/.infcode/logs 中的 CLI 日志, 挖出 LLM 网关地址
 *  4. 用 ~/.infcode/auth.json 里的 JWT 探测网关 /models 端点, 拿到模型列表
 *  5. 注册 pi 原生 provider "infcode" (每次请求动态读取最新 JWT)
 *  6. 把发现的模型写入 ~/.pi/agent/models.json (不破坏已有配置)
 *  7. 全程报告写入 ~/.infcode/pi-report.txt, 并在 pi 里 notify
 *
 * 用法: /reload 后, 用 /model 选择 infcode/* 模型即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const HOME = os.homedir();
const REPORT = path.join(HOME, ".infcode", "pi-report.txt");
const AUTH = path.join(HOME, ".infcode", "auth.json");
const MODELS_JSON = path.join(HOME, ".pi", "agent", "models.json");

let section = `=== pi InfCode Bridge report @ ${new Date().toISOString()} ===`;
async function log(s: unknown) {
  const line = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  section += line + "\n";
  try {
    await fsp.appendFile(REPORT, line + "\n", "utf8");
  } catch {}
}
function sectionLog(title: string) {
  section += `\n--- ${title} ---\n`;
}

function readJson(p: string): Promise<any> {
  return fsp.readFile(p, "utf8").then((t) => JSON.parse(t));
}

// ---------------- 1. 找 CLI 二进制 ----------------
async function walkFiles(dir: string, depth: number, onFile: (p: string) => void | Promise<void>) {
  if (depth > 6) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "media", "assets", "icons", "syntaxes", "themes", "locales"].includes(e.name)) continue;
      await walkFiles(p, depth + 1, onFile);
    } else {
      await Promise.resolve(onFile(p));
    }
  }
}

async function findCliCandidates(): Promise<string[]> {
  const exts = path.join(HOME, ".vscode", "extensions");
  const roots: string[] = [];
  try {
    for (const d of await fsp.readdir(exts)) {
      if (/^tokfinity\.infcode-/.test(d)) roots.push(path.join(exts, d));
    }
  } catch {}
  for (const r of [path.join(HOME, ".infcode"), path.join(os.tmpdir(), "infcode")]) roots.push(r);
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "infcode"));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "infcode"));

  const found: string[] = [];
  for (const root of roots) {
    await walkFiles(root, 0, (p) => {
      if (/\.(exe|bin|cmd|bat)$/i.test(p)) found.push(p);
    });
  }
  return [...new Set(found)];
}

function runHelp(exe: string, timeoutMs = 8000): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ["--help"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ out: String(stdout ?? ""), err: String(stderr ?? "") + (err ? " [exit]" : "") })
    );
  });
}

async function findRealCli(): Promise<{ exe: string; help: string } | null> {
  const candidates = await findCliCandidates();
  sectionLog("CLI candidates");
  for (const c of candidates) await log(c);
  for (const exe of candidates) {
    const { out, err } = await runHelp(exe);
    const text = out + err;
    if (/opencode|kilo|infcode|--model|--provider|tui|serve/i.test(text) && text.length > 40) {
      await log(`=> CLI FOUND: ${exe}`);
      return { exe, help: text.slice(0, 4000) };
    }
  }
  return null;
}

// ---------------- 2. 运行中进程 ----------------
function queryProcesses(): Promise<string> {
  return new Promise((resolve) => {
    const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*infcode*' -or $_.CommandLine -like '*opencode*' -or $_.CommandLine -like '*tokfinity*' } | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (_e, stdout) => resolve(String(stdout ?? ""))
    );
  });
}

// ---------------- 3. 扫日志挖 URL ----------------
async function scanLogsForUrls(): Promise<string[]> {
  const logsDir = path.join(HOME, ".infcode", "logs");
  const urls = new Set<string>();
  await walkFiles(logsDir, 0, async (p) => {
    if (!/\.(log|txt|json)(\.\d+)?$/i.test(p)) return;
    try {
      const st = await fsp.stat(p);
      if (st.size > 6 * 1024 * 1024) return;
      const content = await fsp.readFile(p, "utf8");
      for (const m of content.matchAll(/https?:\/\/[a-zA-Z0-9._-]+(?::\d+)?(?:\/[^\s"'\\\)\]\}<>]*)?/g)) {
        urls.add(m[0].replace(/[),.;]+$/, ""));
      }
    } catch {}
  });
  return [...urls];
}

// ---------------- 4. 探测网关模型 ----------------
async function probeModels(base: string, token: string) {
  const tries = [`${base}/v1/models`, `${base}/models`, `${base}/api/v1/models`];
  for (const u of tries) {
    try {
      const r = await fetch(u, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      await log(`probe GET ${u} -> HTTP ${r.status}`);
      if (!r.ok) continue;
      const j: any = await r.json();
      const data: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      const models = data.map((m) => m?.id).filter((x: any) => typeof x === "string" && x.length > 0);
      if (models.length > 0) return { endpoint: u, models };
    } catch (e) {
      await log(`probe GET ${u} -> ERR ${(e as Error).message}`);
    }
  }
  return null;
}

// ---------------- 5. 注册 pi provider ----------------
async function readAuth(): Promise<{ accessToken: string; refreshToken: string; baseUrl: string } | null> {
  try {
    const a = await readJson(AUTH);
    if (a?.accessToken) return a;
  } catch {}
  return null;
}

async function writeModelsJson(baseUrl: string, api: string, models: string[]) {
  let existing: any = {};
  try {
    existing = await readJson(MODELS_JSON);
  } catch {}
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) existing = {};
  const providers = existing.providers && typeof existing.providers === "object" ? existing.providers : {};
  providers.infcode = {
    baseUrl,
    api,
    // 说明: apiKey 由原生 provider "infcode" 动态提供(读取 ~/.infcode/auth.json 的 JWT)
    models: models.map((id) => ({
      id,
      name: `InfCode ${id}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    })),
  };
  const out = { ...existing, providers };
  await fsp.mkdir(path.dirname(MODELS_JSON), { recursive: true });
  await fsp.writeFile(MODELS_JSON, JSON.stringify(out, null, 2), "utf8");
}

// ---------------- 主流程 ----------------
export default function (pi: ExtensionAPI) {
  let done = false;
  let started = false;

  async function runDiscovery(force = false) {
    if (started && !force) return;
    started = true;
    section = `=== pi InfCode Bridge report @ ${new Date().toISOString()} ===`;
    sectionLog("START");
    try {
      // 登录态
      const auth = await readAuth();
      if (!auth) {
        await log("!! 未找到 ~/.infcode/auth.json — 请先在 VSCode InfCode 插件登录");
        await log("FULL REPORT: " + REPORT);
        return;
      }
      await log("auth.json 存在 (token 不打印), baseUrl=" + auth.baseUrl);

      // CLI 二进制
      const cli = await findRealCli();
      if (cli) await log("CLI help:\n" + cli.help.slice(0, 2000));
      else await log("!! 未在已知目录找到 InfCode CLI 二进制");

      // 运行中进程
      const procs = await queryProcesses();
      if (procs.trim()) await log("运行中相关进程:\n" + procs.slice(0, 3000));
      else await log("(未发现运行中的 infcode/opencode 进程)");

      // 日志里的 URL
      const urls = await scanLogsForUrls();
      await log("日志中发现的 URL:\n" + urls.slice(0, 60).join("\n") || "(无)");

      // 候选网关 base
      const candidates: string[] = [];
      for (const u of urls) {
        try {
          const origin = new URL(u).origin;
          if (!candidates.includes(origin) && /tokensinfinity|tokfinity|infcode/i.test(u)) candidates.push(origin);
        } catch {}
      }
      candidates.push("https://www.tokensinfinity.com");
      if (auth.baseUrl) candidates.unshift(auth.baseUrl.replace(/\/+$/, ""));

      // 探测模型
      let found: { endpoint: string; models: string[] } | null = null;
      for (const c of [...new Set(candidates)]) {
        found = await probeModels(c, auth.accessToken);
        if (found) break;
      }

      if (found && found.models.length > 0) {
        const api = "openai-completions";
        const baseUrl = found.endpoint.replace(/\/models\/?$/, "").replace(/\/v1$/, "");
        await log(`!! 成功: 网关=${baseUrl} 模型数=${found.models.length}`);
        await log("模型: " + found.models.join(", "));

        // 注册原生 provider (动态 JWT)
        pi.registerProvider(
          createProvider({
            id: "infcode",
            name: "InfCode (词元无限)",
            baseUrl,
            auth: {
              apiKey: {
                name: "InfCode 登录态 (auth.json)",
                async login() {
                  throw new Error("请先在 VSCode InfCode 插件中登录, 然后 /reload");
                },
                async resolve(_opts: any) {
                  const a = await readAuth();
                  if (!a?.accessToken) return undefined;
                  return { auth: { apiKey: a.accessToken }, source: "stored API key" } as any;
                },
              },
            },
            models: [],
            api: openAICompletionsApi(),
          })
        );

        // 写 models.json
        await writeModelsJson(baseUrl, api, found.models);
        await log("已写入 " + MODELS_JSON);
        sectionLog("DONE");
        done = true;
      } else {
        await log("!! 未能从网关拿到模型列表 (端点未知或协议非标准)");
        await log("请把本报告给 pi agent 分析, 或手动运行:");
        await log('  Get-ChildItem "$env:USERPROFILE\\.vscode\\extensions\\tokfinity.infcode-2.4.1-win32-x64" -Recurse -Include *.exe | Select FullName');
        sectionLog("PARTIAL");
      }
    } catch (e) {
      await log("!! 异常: " + (e as Error).stack);
    }
  }

  pi.registerCommand("infcode-status", {
    description: "InfCode Bridge: 重新探测并显示报告路径",
    handler: async (_args, ctx) => {
      await runDiscovery(true);
      try {
        const t = await fsp.readFile(REPORT, "utf8");
        ctx.ui.notify(`InfCode Bridge 报告: ${REPORT}\n${t.slice(-800)}`, "info");
      } catch {
        ctx.ui.notify(`InfCode Bridge 报告: ${REPORT}`, "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    void runDiscovery().then(() => {
      if (done) {
        ctx.ui.notify(`InfCode Bridge: 已接入, /model 选择 infcode 模型`, "info");
      } else {
        ctx.ui.notify(`InfCode Bridge: 探测未完成, 见 ${REPORT}`, "warn");
      }
    });
  });
}
