/**
 * InfCode Bridge for pi — v3
 * 目标: 让 pi 使用 InfCode(VSCode插件) 的企业模型与额度。
 *
 * v3 变更:
 *  - 内置按模型调研的准确参数表 (1M 上下文 / 思考强度映射)
 *  - 转储网关 /models 返回的完整元数据到报告 (用于后续校准)
 *  - 写入 models.json 时优先使用网关元数据, 回退到内置参数表
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const BRIDGE_VERSION = "3.0";
const HOME = os.homedir();
const REPORT = path.join(HOME, ".infcode", "pi-report.txt");
const AUTH = path.join(HOME, ".infcode", "auth.json");
const MODELS_JSON = path.join(HOME, ".pi", "agent", "models.json");

// 调研 + 网关元数据所得的模型参数 (网关 /models 无元数据时使用)
// 网关声明: context_length 1M; reasoning_efforts 仅 glm-5.2/kimi-k3 支持 (minimal~xhigh)
const MODEL_DEFAULTS: Record<string, any> = {
  GL56: { contextWindow: 1000000, maxTokens: 128000, reasoning: false, input: ["text", "image"] },
  "deepseek-v4-pro": { contextWindow: 1000000, maxTokens: 384000, reasoning: false },
  "deepseek-v4-flash": { contextWindow: 1000000, maxTokens: 384000, reasoning: false },
  "glm-5.2": {
    contextWindow: 1000000,
    maxTokens: 128000,
    reasoning: true,
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
  },
  "kimi-k3": {
    contextWindow: 1000000,
    maxTokens: 1000000,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
  },
};

let section = "";
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

// ---------------- 目录遍历 ----------------
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

// ---------------- 找 CLI 二进制 ----------------
async function findCliCandidates(): Promise<string[]> {
  const exts = path.join(HOME, ".vscode", "extensions");
  const roots: string[] = [];
  try {
    for (const d of await fsp.readdir(exts)) {
      if (/^tokfinity\.infcode-/.test(d)) roots.push(path.join(exts, d));
    }
  } catch {}
  roots.push(path.join(HOME, ".infcode"));
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

function runCli(exe: string, args: string[], timeoutMs = 25000): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          out: String(stdout ?? ""),
          err: String(stderr ?? "") + (err ? ` [exit:${(err as any)?.code}]` : ""),
        })
    );
  });
}

async function findRealCli(): Promise<{ exe: string; help: string } | null> {
  const candidates = await findCliCandidates();
  sectionLog("CLI candidates");
  for (const c of candidates) await log(c);
  for (const exe of candidates) {
    const { out, err } = await runCli(exe, ["--help"], 8000);
    const text = out + err;
    if (/opencode|kilo|infcode|--model|--provider|tui|serve/i.test(text) && text.length > 40) {
      await log(`=> CLI FOUND: ${exe}`);
      return { exe, help: text.slice(0, 4000) };
    }
  }
  return null;
}

// ---------------- 运行中进程 ----------------
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

// ---------------- 扫日志挖 URL ----------------
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

// ---------------- 探测网关模型 ----------------
async function probeOne(url: string, token: string, headerStyle: "bearer" | "x-api-key") {
  const headers =
    headerStyle === "bearer"
      ? { Authorization: `Bearer ${token}` }
      : { "x-api-key": token, "Content-Type": "application/json" };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    await log(`probe GET ${url} [${headerStyle}] -> HTTP ${r.status}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    // 完整转储元数据供校准
    await log(`RAW /models response:\n${JSON.stringify(j).slice(0, 8000)}`);
    const data: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
    const models = data.map((m: any) => m?.id).filter((x: any) => typeof x === "string" && x.length > 0);
    if (models.length > 0) return { endpoint: url, models, headerStyle, raw: data };
    await log(`probe GET ${url} [${headerStyle}] -> 200 但无模型列表: ${JSON.stringify(j).slice(0, 300)}`);
  } catch (e) {
    await log(`probe GET ${url} [${headerStyle}] -> ERR ${(e as Error).message}`);
  }
  return null;
}

async function probeModels(base: string, token: string) {
  const paths = ["/models", "/v1/models", "/model/list", "/list"];
  for (const p of paths) {
    const u = base.replace(/\/+$/, "") + p;
    const r1 = await probeOne(u, token, "bearer");
    if (r1) return r1;
    const r2 = await probeOne(u, token, "x-api-key");
    if (r2) return r2;
  }
  return null;
}

async function cliListModels(exe: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const args of [["models"], ["models", "acode"], ["models", "--json"], ["models", "acode", "--json"]]) {
    const { out, err } = await runCli(exe, args);
    const text = out + "\n" + err;
    await log(`run: infcode.exe ${args.join(" ")} ->\n${text.slice(0, 1500)}`);
    try {
      const j = JSON.parse(out);
      const pick = (o: any): void => {
        if (!o) return;
        if (typeof o === "string") return ids.add(o);
        if (Array.isArray(o)) return o.forEach(pick);
        if (typeof o === "object") {
          for (const k of ["id", "model", "modelID", "modelId", "name"])
            if (typeof o[k] === "string" && o[k]) ids.add(o[k]);
          Object.values(o).forEach(pick);
        }
      };
      pick(j);
      if (ids.size) break;
    } catch {}
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(/[a-zA-Z0-9][a-zA-Z0-9._-]{2,60}(?:\/[a-zA-Z0-9._-]{1,60})?/g)) {
        const t = m[0];
        if (/claude|gpt|deepseek|kimi|qwen|glm|gemini|llama|codestral|mistral|mini|doubao|sonnet|opus|haiku/i.test(t)) ids.add(t);
      }
    }
    if (ids.size) break;
  }
  return [...ids].filter((x) => !/^(acode|kilo|infcode|usage|cost|token|provider|model)$/i.test(x));
}

// ---------------- 注册 provider / 写 models.json ----------------
async function readAuth(): Promise<{ accessToken: string; refreshToken: string; baseUrl: string } | null> {
  try {
    const a = await readJson(AUTH);
    if (a?.accessToken) return a;
  } catch {}
  return null;
}

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function buildModelEntry(id: string, meta?: any) {
  const d = MODEL_DEFAULTS[id] ?? {};
  const m = meta ?? {};
  const contextWindow =
    num(m.context_window) ?? num(m.contextWindow) ?? num(m.context_length) ?? num(m.max_input_tokens) ?? num(m.input_tokens_limit) ?? d.contextWindow ?? 1000000;
  const maxTokens =
    num(m.max_output_tokens) ?? num(m.max_completion_tokens) ?? num(m.maxOutputTokens) ?? num(m.maxTokens) ?? num(m.output_tokens_limit) ?? d.maxTokens ?? 128000;
  // 网关元数据: 只有声明了 reasoning_efforts 的模型才支持思考强度参数
  const efforts: string[] = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : [];
  const reasoning = efforts.length > 0 ? true : d.reasoning ?? false;
  const levelMap: Record<string, string | null> = {};
  for (const e of ["minimal", "low", "medium", "high", "xhigh"]) levelMap[e] = efforts.includes(e) ? e : null;
  levelMap.max = null;
  const features: string[] = Array.isArray(m.features) ? m.features : [];
  const input: string[] = features.includes("vision") || (d.input ?? ["text"]).includes("image") ? ["text", "image"] : ["text"];
  return {
    id,
    name: `InfCode ${id}`,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false },
    ...(reasoning ? { thinkingLevelMap: levelMap } : {}),
  };
}

async function writeModelsJson(baseUrl: string, api: string, models: Array<{ id: string; meta?: any }>) {
  let existing: any = {};
  try {
    existing = await readJson(MODELS_JSON);
  } catch {}
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) existing = {};
  const providers = existing.providers && typeof existing.providers === "object" ? existing.providers : {};
  providers.infcode = {
    baseUrl,
    api,
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: models.map(({ id, meta }) => buildModelEntry(id, meta)),
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
    section = `=== pi InfCode Bridge v${BRIDGE_VERSION} report @ ${new Date().toISOString()} ===`;
    sectionLog("START");
    try {
      const auth = await readAuth();
      if (!auth) {
        await log("!! 未找到 ~/.infcode/auth.json — 请先在 VSCode InfCode 插件登录");
        return;
      }
      await log("auth.json 存在 (token 不打印), baseUrl=" + auth.baseUrl);

      const cli = await findRealCli();
      if (cli) await log("CLI help:\n" + cli.help.slice(0, 2000));
      else await log("!! 未在已知目录找到 InfCode CLI 二进制");

      const procs = await queryProcesses();
      if (procs.trim()) await log("运行中相关进程:\n" + procs.slice(0, 3000));
      else await log("(未发现运行中的 infcode/opencode 进程)");

      const urls = await scanLogsForUrls();
      await log("日志中发现的 URL:\n" + (urls.slice(0, 60).join("\n") || "(无)"));

      const candidates: string[] = [];
      for (const u of urls) {
        try {
          const uu = new URL(u);
          if (!/tokensinfinity|tokfinity|infcode/i.test(uu.host)) continue;
          const p1 = uu.pathname;
          const m = p1.match(/^(\/(?:[^/]+\/)*v1)\/chat\/completions/);
          if (m) candidates.push(uu.origin + m[1]);
          else if (/\/v1\//.test(p1)) candidates.push(uu.origin + p1.slice(0, p1.lastIndexOf("/")));
          else candidates.push(uu.origin);
        } catch {}
      }
      candidates.push("https://www.tokensinfinity.com/acode/v1");
      candidates.push("https://www.tokensinfinity.com");
      if (auth.baseUrl) candidates.push(auth.baseUrl.replace(/\/+$/, ""));
      await log("候选网关 base: " + [...new Set(candidates)].join(" | "));

      let found: { endpoint: string; models: string[]; headerStyle?: string; raw?: any[] } | null = null;
      for (const c of [...new Set(candidates)]) {
        found = await probeModels(c, auth.accessToken);
        if (found) break;
      }

      if (!found && cli) {
        const ids = await cliListModels(cli.exe);
        if (ids.length) {
          found = { endpoint: "https://www.tokensinfinity.com/acode/v1/models", models: ids };
          await log("!! 兜底成功: 用 CLI models 命令拿到 " + ids.length + " 个模型");
        }
      }

      if (found && found.models.length > 0) {
        const api = "openai-completions";
        const baseUrl = found.endpoint.replace(/\/models\/?$/, "");
        await log(`!! 成功: 网关=${baseUrl} 模型数=${found.models.length}`);
        await log("模型: " + found.models.join(", "));

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

        const metaMap = new Map((found.raw ?? []).map((m: any) => [m?.id, m]));
        await writeModelsJson(
          baseUrl,
          api,
          found.models.map((id) => ({ id, meta: metaMap.get(id) }))
        );
        await log("已写入 " + MODELS_JSON);
        sectionLog("DONE");
        done = true;
      } else {
        await log("!! 未能从网关拿到模型列表 (端点未知或协议非标准)");
        sectionLog("PARTIAL");
      }
    } catch (e) {
      await log("!! 异常: " + (e as Error).stack);
    }
  }

  pi.registerCommand("infcode-status", {
    description: "InfCode Bridge: 重新探测并显示报告",
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
      if (done) ctx.ui.notify(`InfCode Bridge v${BRIDGE_VERSION}: 已接入, /model 选择 infcode 模型`, "info");
      else ctx.ui.notify(`InfCode Bridge v${BRIDGE_VERSION}: 探测未完成, 见 ${REPORT}`, "warn");
    });
  });
}
