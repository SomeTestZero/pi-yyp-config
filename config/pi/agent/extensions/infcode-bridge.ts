/**
 * InfCode Bridge for pi — v5
 * 目标: 让 pi 使用 InfCode(VSCode插件) 的企业模型与额度。
 *
 * v5 变更 (修复回答格式问题):
 *  1) 网关会把 reasoning_content 同时复制进 content (带 <thinking> 标签), pi 内置
 *     openai-completions 解析器两个字段都收 → 正文泄漏 <thinking> 文本且内容重复。
 *     现用自定义 ProviderStreams 包装内置实现, 在事件流层面:
 *       - 吞掉与 thinking delta 重复的 text delta (按 chunk 判重)
 *       - 从正文剥离 <thinking>…</thinking> 区段 (含跨 delta 的不完整标签)
 *  2) 按网关真实行为修正模型元数据: deepseek 系实为推理模型 (默认思考, 无 effort 档),
 *     用 thinkingFormat:"deepseek" 使 pi 能下发 thinking enabled/disabled;
 *     glm-5.2 用 "zai" 格式, kimi-k3 用 openai 默认格式, 均声明 supportsReasoningEffort。
 *  3) 按 pi 文档改为 async 工厂内完成发现与注册 (pi 会等待工厂, 模型立即可用),
 *     不再写 models.json (文档: models.json 覆盖优先级高于原生注册, 会盖住新 compat),
 *     启动时自动清除 v4 写入的旧 models.json infcode 节。
 *  4) 重型诊断 (CLI 扫描/进程扫描/日志挖掘) 不再每次启动跑, 仅 /infcode-status 按需运行。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  openAICompletionsApi,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const BRIDGE_VERSION = "5.0";
const PROVIDER_ID = "infcode";
const HOME = os.homedir();
const REPORT = path.join(HOME, ".infcode", "pi-report.txt");
const AUTH = path.join(HOME, ".infcode", "auth.json");
const CACHE = path.join(HOME, ".infcode", "pi-models-cache.json");
const MODELS_JSON = path.join(HOME, ".pi", "agent", "models.json");
const GATEWAY_BASE = "https://www.tokensinfinity.com/acode/v1";

type ModelCompat = NonNullable<Model<"openai-completions">["compat"]>;
type ModelOverrides = {
  reasoning: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
  compat?: ModelCompat;
};

// 网关元数据校准的参数表 (网关 /models 无对应元数据时兜底)
// 注意: deepseek 系虽然 /models 未声明 reasoning_efforts, 但流里实测默认推 reasoning_content
const MODEL_DEFAULTS: Record<string, ModelOverrides> = {
  GL56: {
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "deepseek-v4-pro": {
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
  },
  "deepseek-v4-flash": {
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
  },
  "glm-5.2": {
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    compat: { thinkingFormat: "zai", supportsReasoningEffort: true },
  },
  "kimi-k3": {
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 1000000,
    thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    compat: { supportsReasoningEffort: true },
  },
};

let section = "";
async function log(s: unknown) {
  const line = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  section += line + "\n";
  try {
    await fsp.mkdir(path.dirname(REPORT), { recursive: true });
    await fsp.appendFile(REPORT, line + "\n", "utf8");
  } catch {}
}
function sectionLog(title: string) {
  section += `\n--- ${title} ---\n`;
}

function readJson(p: string): Promise<any> {
  return fsp.readFile(p, "utf8").then((t) => JSON.parse(t));
}

// =============================================================================
// 事件流净化器: 修复网关把思考内容复制进 content 造成的泄漏/重复
// =============================================================================

const OPEN_TAG = "<thinking>";
const CLOSE_TAG = "</thinking>";

/**
 * 从 content 文本中剥离 <thinking>…</thinking> 区段。
 * 网关已经把思考内容经 reasoning_content 单独下发, content 里这份是副本。
 * final=false 时, 末尾疑似不完整开标签 ("<thi"…) 的部分先扣住, 等后续 delta 再判定。
 */
function stripThinkingTags(raw: string, final = false): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf(OPEN_TAG, i);
    if (open === -1) {
      out += raw.slice(i);
      i = raw.length;
      break;
    }
    out += raw.slice(i, open);
    const close = raw.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
    if (close === -1) {
      // 开标签未闭合: 思考仍在流式输出, 抑制到目前末尾
      i = raw.length;
      break;
    }
    i = close + CLOSE_TAG.length;
    while (i < raw.length && /\s/.test(raw[i])) i++; // 闭合标签后的空白不留给正文
  }
  if (!final && out.length > 0) {
    let hold = 0;
    const maxHold = Math.min(OPEN_TAG.length - 1, out.length);
    for (let k = 1; k <= maxHold; k++) {
      if (out.endsWith(OPEN_TAG.slice(0, k))) hold = k;
    }
    if (hold > 0) out = out.slice(0, -hold);
  }
  return out;
}

/** 判断某个 text delta 是否是紧随其后的 thinking delta 的重复 (同一 SSE chunk 的双发) */
function isDuplicateOfThinking(textDelta: string, thinkingDelta: string): boolean {
  if (textDelta === thinkingDelta) return true;
  return textDelta.replace(/^<thinking>\s*/, "") === thinkingDelta;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * 包装内置 openai-completions 事件流:
 *  - text_delta 先押后一拍, 若与同一 chunk 的 thinking delta 重复则吞掉;
 *  - 每个 text block 维护 raw(原始拼接)→clean(剥离 <thinking> 区段), 只转发 clean 的增量;
 *  - 所有携带 partial 的事件在转发前就地净化其中的 text block (TUI 直接渲染 partial);
 *  - thinking / toolcall / usage / done / error 事件原样透传。
 */
function sanitizeEventStream(inner: AssistantMessageEventStream, model: Model<any>): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  (async () => {
    const texts = new Map<number, { raw: string; clean: string }>();
    let held: { index: number; delta: string } | null = null;

    const stateFor = (i: number) => {
      let s = texts.get(i);
      if (!s) {
        s = { raw: "", clean: "" };
        texts.set(i, s);
      }
      return s;
    };

    const sanitizePartial = (msg: AssistantMessage | undefined) => {
      const content = (msg as any)?.content;
      if (!Array.isArray(content)) return;
      for (let i = 0; i < content.length; i++) {
        const b = content[i];
        if (b && b.type === "text" && typeof b.text === "string") {
          const s = texts.get(i);
          b.text = s ? s.clean : stripThinkingTags(b.text, true);
        }
      }
    };

    // 把押后的 text_delta 结算掉; 返回需要补发的 text_delta (无增量则 null)
    const flushHeld = (partial: AssistantMessage): AssistantMessageEvent | null => {
      if (!held) return null;
      const s = stateFor(held.index);
      s.raw += held.delta;
      const next = stripThinkingTags(s.raw);
      const growth = next.startsWith(s.clean) ? next.slice(s.clean.length) : "";
      s.clean = next;
      const index = held.index;
      held = null;
      sanitizePartial(partial); // 先净化再发, 避免 TUI 瞬间渲染到原始污染文本
      if (growth.length === 0) return null;
      return { type: "text_delta", contentIndex: index, delta: growth, partial };
    };

    try {
      for await (const ev of inner) {
        if (ev.type === "text_delta") {
          // 先押后: 等看下一个事件是不是同一 chunk 的 thinking_delta (网关双发)
          if (held) {
            const f = flushHeld(ev.partial);
            if (f) out.push(f);
          }
          held = { index: ev.contentIndex, delta: ev.delta };
          continue;
        }
        if (ev.type === "thinking_delta") {
          if (held) {
            if (!isDuplicateOfThinking(held.delta, ev.delta)) {
              const f = flushHeld(ev.partial);
              if (f) out.push(f);
            } else {
              held = null; // content 字段里的思考副本, 吞掉
            }
          }
          sanitizePartial(ev.partial);
          out.push(ev);
          continue;
        }
        if (held) {
          const f = flushHeld((ev as any).partial);
          if (f) out.push(f);
        }
        if (ev.type === "text_end") {
          const s = stateFor(ev.contentIndex);
          s.clean = stripThinkingTags(s.raw, true); // final: 不再扣留疑似半标签
          sanitizePartial(ev.partial);
          out.push({ ...ev, content: s.clean });
          continue;
        }
        if (ev.type === "done" || ev.type === "error") {
          sanitizePartial((ev as any).message ?? (ev as any).error);
          out.push(ev);
          continue;
        }
        sanitizePartial((ev as any).partial);
        out.push(ev);
      }
    } catch (e) {
      out.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "error",
          errorMessage: e instanceof Error ? e.message : String(e),
          timestamp: Date.now(),
        } as AssistantMessage,
      });
    } finally {
      out.end();
    }
  })();
  return out;
}

/** 用净化器包装内置 openai-completions 的 ProviderStreams */
function makeSanitizedStreams(): ProviderStreams {
  const base = openAICompletionsApi() as ProviderStreams;
  const wrapped: ProviderStreams = {
    stream: (model: Model<any>, context: Context, options?: StreamOptions) =>
      sanitizeEventStream(base.stream(model, context, options), model),
    streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
      sanitizeEventStream(base.streamSimple(model, context, options), model),
  };
  if (base.fetchDeferred) wrapped.fetchDeferred = base.fetchDeferred.bind(base);
  if (base.cancelDeferred) wrapped.cancelDeferred = base.cancelDeferred.bind(base);
  return wrapped;
}

// =============================================================================
// 模型目录构建
// =============================================================================

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function buildModelEntry(id: string, baseUrl: string, meta?: any): Model<"openai-completions"> {
  const d = MODEL_DEFAULTS[id];
  const m = meta ?? {};
  const contextWindow =
    num(m.context_window) ?? num(m.contextWindow) ?? num(m.context_length) ?? num(m.max_input_tokens) ?? d?.contextWindow ?? 1000000;
  const maxTokens =
    num(m.max_output_tokens) ?? num(m.max_completion_tokens) ?? num(m.maxOutputTokens) ?? num(m.maxTokens) ?? num(m.output_tokens_limit) ?? d?.maxTokens ?? 128000;
  // 网关元数据: 声明了 reasoning_efforts 的模型支持思考强度
  const efforts: string[] = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : [];
  const reasoning = d?.reasoning ?? efforts.length > 0;
  let thinkingLevelMap = d?.thinkingLevelMap;
  if (!thinkingLevelMap && efforts.length > 0) {
    thinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
    for (const e of efforts) (thinkingLevelMap as any)[e] = e;
  }
  const features: string[] = Array.isArray(m.features) ? m.features : [];
  const input: ("text" | "image")[] =
    features.includes("vision") || (d?.input ?? ["text"]).includes("image") ? ["text", "image"] : ["text"];
  return {
    id,
    name: `InfCode ${id}`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: {
      supportsDeveloperRole: false, // 用 system 而不是 developer 角色
      maxTokensField: "max_tokens", // 网关是 Azure 风格, 用 max_tokens
      ...d?.compat,
    },
  };
}

// =============================================================================
// 发现: auth.json + 网关 /models (+ 本地缓存兜底)
// =============================================================================

async function readAuth(): Promise<{ accessToken: string; refreshToken?: string; baseUrl?: string } | null> {
  try {
    const a = await readJson(AUTH);
    if (a?.accessToken) return a;
  } catch {}
  return null;
}

async function fetchModelsFromGateway(
  baseUrl: string,
  token: string
): Promise<{ baseUrl: string; models: Array<{ id: string; meta?: any }> } | null> {
  const bases: string[] = [];
  const authBase = baseUrl.replace(/\/+$/, "");
  bases.push(/\/v1$/.test(authBase) ? authBase : authBase + "/acode/v1");
  if (!bases.includes(GATEWAY_BASE)) bases.push(GATEWAY_BASE);
  for (const base of [...new Set(bases)]) {
    try {
      const r = await fetch(base + "/models", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      await log(`probe GET ${base}/models -> HTTP ${r.status}`);
      if (!r.ok) continue;
      const j: any = await r.json();
      const data: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      const models = data
        .filter((m: any) => typeof m?.id === "string" && m.id.length > 0)
        .map((m: any) => ({ id: m.id as string, meta: m }));
      if (models.length > 0) return { baseUrl: base, models };
    } catch (e) {
      await log(`probe GET ${base}/models -> ERR ${(e as Error).message}`);
    }
  }
  return null;
}

async function readModelsCache(): Promise<{ baseUrl: string; models: Array<{ id: string; meta?: any }> } | null> {
  try {
    const j = await readJson(CACHE);
    if (typeof j?.baseUrl === "string" && Array.isArray(j?.models) && j.models.length > 0) return j;
  } catch {}
  return null;
}

async function writeModelsCache(found: { baseUrl: string; models: Array<{ id: string; meta?: any }> }) {
  try {
    await fsp.mkdir(path.dirname(CACHE), { recursive: true });
    await fsp.writeFile(CACHE, JSON.stringify({ ...found, at: new Date().toISOString() }, null, 2), "utf8");
  } catch {}
}

/** v4 曾把模型写进 models.json; 文档明确 models.json 覆盖优先级高于扩展注册, 旧配置会盖住新 compat, 启动时清除。
 *  返回 true 表示删掉了旧节 (当前进程可能已加载过旧配置, 需要提示用户再 /reload 一次) */
async function removeStaleModelsJson(): Promise<boolean> {
  try {
    const j = await readJson(MODELS_JSON);
    if (j && typeof j === "object" && j.providers && j.providers[PROVIDER_ID]) {
      delete j.providers[PROVIDER_ID];
      await fsp.writeFile(MODELS_JSON, JSON.stringify(j, null, 2), "utf8");
      await log("已从 models.json 移除旧版写入的 infcode 配置 (改为扩展内原生注册)");
      return true;
    }
  } catch {}
  return false;
}

let staleConfigRemoved = false;

async function registerInfcodeProvider(pi: ExtensionAPI): Promise<{ ok: boolean; modelCount: number; baseUrl?: string }> {
  if (await removeStaleModelsJson()) staleConfigRemoved = true;
  // 防御: 清除可能存在的旧同名注册 (v4 时代/models.json 覆盖), 保证走净化后的流
  try {
    pi.unregisterProvider(PROVIDER_ID);
  } catch {}
  const auth = await readAuth();
  if (!auth) {
    await log("!! 未找到 ~/.infcode/auth.json — 请先在 VSCode InfCode 插件登录");
    return { ok: false, modelCount: 0 };
  }

  // 1) 实时探测网关; 2) 失败用本地缓存; 3) 再失败用内置参数表
  let found = await fetchModelsFromGateway(auth.baseUrl ?? GATEWAY_BASE, auth.accessToken);
  if (found) {
    await writeModelsCache(found);
  } else {
    const cached = await readModelsCache();
    if (cached) {
      found = cached;
      await log("网关探测失败, 使用缓存的模型目录: " + cached.baseUrl);
    } else {
      found = {
        baseUrl: GATEWAY_BASE,
        models: Object.keys(MODEL_DEFAULTS).map((id) => ({ id })),
      };
      await log("网关探测失败且无缓存, 使用内置模型表: " + Object.keys(MODEL_DEFAULTS).join(", "));
    }
  }

  const models = found.models.map(({ id, meta }) => buildModelEntry(id, found!.baseUrl, meta));

  pi.registerProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "InfCode (词元无限)",
      baseUrl: found.baseUrl,
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
      models,
      api: makeSanitizedStreams(),
    })
  );
  await log(`已注册 provider "${PROVIDER_ID}": ${models.length} 个模型 @ ${found.baseUrl}`);
  return { ok: true, modelCount: models.length, baseUrl: found.baseUrl };
}

// =============================================================================
// 按需诊断 (仅 /infcode-status 与 /infcode-stream-test 使用)
// =============================================================================

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
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
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

// 流式输出探测: 验证 content/reasoning_content 双发行为与 thinking 开关是否生效
async function runStreamProbes(baseUrl: string, token: string, modelIds: string[]) {
  sectionLog("STREAM PROBES");
  const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const mk = (model: string, extra?: any) => ({
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 64,
    ...extra,
  });
  const variants: Array<[string, any]> = [
    ["plain", {}],
    ["reasoning_effort:high", { reasoning_effort: "high" }],
    ["thinking.enabled", { thinking: { type: "enabled" } }],
    ["thinking.disabled", { thinking: { type: "disabled" } }],
  ];
  for (const id of modelIds) {
    for (const [label, extra] of variants) {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(mk(id, extra)),
          signal: AbortSignal.timeout(30000),
        });
        await log(`\n### ${id} [${label}] HTTP ${r.status}`);
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          await log("  BODY: " + t.slice(0, 600));
          continue;
        }
        const text = await r.text();
        const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
        await log(`  SSE lines=${lines.length}`);
        // 只保留 delta 摘要, 避免报告过大
        for (const l of lines.slice(0, 40)) {
          try {
            const j = JSON.parse(l.slice(5).trim());
            const d = j?.choices?.[0]?.delta;
            const fr = j?.choices?.[0]?.finish_reason;
            if (d || fr) {
              const keys = Object.keys(d ?? {}).filter((k) => (d as any)[k] != null && (d as any)[k] !== "");
              await log(
                `  delta keys=[${keys.join(",")}]` +
                  (d?.content ? ` content=${JSON.stringify(d.content).slice(0, 80)}` : "") +
                  (d?.reasoning_content ? ` reasoning=${JSON.stringify(d.reasoning_content).slice(0, 80)}` : "") +
                  (fr ? ` finish=${fr}` : "")
              );
            }
          } catch {}
        }
      } catch (e) {
        await log(`### ${id} [${label}] ERR ${(e as Error).message}`);
      }
    }
  }
  sectionLog("STREAM PROBES END");
}

// =============================================================================
// 扩展入口 (async 工厂: pi 会等待其完成, 模型在启动时即可用)
// =============================================================================

export default async function (pi: ExtensionAPI) {
  section = `=== pi InfCode Bridge v${BRIDGE_VERSION} @ ${new Date().toISOString()} ===`;
  const reg = await registerInfcodeProvider(pi);

  pi.registerCommand("infcode-status", {
    description: "InfCode Bridge: 重新探测并运行完整诊断",
    handler: async (_args, ctx) => {
      const r = await registerInfcodeProvider(pi);
      const cli = await findRealCli();
      if (cli) await log("CLI help:\n" + cli.help.slice(0, 2000));
      const procs = await queryProcesses();
      if (procs.trim()) await log("运行中相关进程:\n" + procs.slice(0, 3000));
      const urls = await scanLogsForUrls();
      await log("日志中发现的 URL:\n" + (urls.slice(0, 60).join("\n") || "(无)"));
      ctx.ui.notify(
        r.ok
          ? `InfCode Bridge v${BRIDGE_VERSION}: 已注册 ${r.modelCount} 个模型 @ ${r.baseUrl}\n报告: ${REPORT}`
          : `InfCode Bridge: 注册失败, 见报告 ${REPORT}`,
        r.ok ? "info" : "warn"
      );
    },
  });

  pi.registerCommand("infcode-stream-test", {
    description: "InfCode Bridge: 流式输出探测 (诊断思考内容泄漏/开关)",
    handler: async (_args, ctx) => {
      try {
        const auth = await readAuth();
        if (!auth) throw new Error("无 auth.json, 请先在 VSCode InfCode 插件登录");
        const cached = await readModelsCache();
        const baseUrl = cached?.baseUrl ?? GATEWAY_BASE;
        const ids = cached?.models?.map((m) => m.id) ?? Object.keys(MODEL_DEFAULTS);
        await runStreamProbes(baseUrl, auth.accessToken, ids);
        ctx.ui.notify(`流式探测完成, 报告: ${REPORT}`, "info");
      } catch (e) {
        ctx.ui.notify("流式探测失败: " + (e as Error).message, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!reg.ok) {
      ctx.ui.notify(`InfCode Bridge v${BRIDGE_VERSION}: 未找到登录态, 请先在 VSCode InfCode 插件登录后 /reload`, "warn");
      return;
    }
    if (staleConfigRemoved) {
      ctx.ui.notify(
        `InfCode Bridge v${BRIDGE_VERSION}: 已清除 v4 写入 models.json 的旧配置, 请再执行一次 /reload 使新格式修复完全生效`,
        "warn"
      );
      return;
    }
    ctx.ui.notify(`InfCode Bridge v${BRIDGE_VERSION}: 已接入 ${reg.modelCount} 个模型, /model 选择 infcode`, "info");
  });
}
