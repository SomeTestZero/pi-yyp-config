/**
 * pi-sync — pi 多机配置/插件同步扩展
 *
 * 用一个私有 git 仓库作为唯一同步源，在多台山电脑之间同步：
 *   - settings.json（顶层键级三方合并，packages 并集，排除键不同步）
 *   - keybindings.json（整文件三方合并）
 *   - ~/.pi/agent/extensions/ 本地扩展文件（文件级三方合并，node_modules 除外）
 * 删除通过墓碑（tombstone）传播；冲突在交互模式弹窗选择，自动模式跳过并挂起。
 *
 * 命令：
 *   /sync                 一键同步：拉取 → 合并 → 推送（交互解决冲突）
 *   /sync init [repo] [--mode=remote|local]   初始化（新机器接入）
 *   /sync push | pull | status | on | off
 *
 * 自动同步（sync.autoSync，默认开）：session_start 后后台拉取合并；退出时若有本地改动则推送。
 *
 * 配置（~/.pi/agent/settings.json 的 "sync" 键，本键不参与同步）：
 *   { "sync": { "repo": "git@github.com:SomeTestZero/pi-yyp-config.git",
 *               "enabled": true, "autoSync": true,
 *               "excludeKeys": [], "includeFiles": [] } }
 *
 * 测试钩子：PI_SYNC_HOME 覆盖 ~/.pi，PI_SYNC_WORK 覆盖同步克隆目录。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const DEFAULT_REPO = "git@github.com:SomeTestZero/pi-yyp-config.git";

/** settings.json 中永不跨机同步的内置键（机器相关/易腐/同步配置自身） */
const BUILTIN_EXCLUDED_KEYS = new Set([
  "httpProxy",
  "shellPath",
  "npmCommand",
  "sessionDir",
  "externalEditor",
  "lastChangelogVersion",
  "trackingId",
  "sync",
]);

const REPO_SETTINGS = "config/pi/agent/settings.json";
const REPO_KEYBINDINGS = "config/pi/agent/keybindings.json";
const REPO_WEBSEARCH = "config/pi/web-search.json";
const REPO_EXT_DIR = "config/pi/agent/extensions";
const REPO_STATE = "config/sync-state.json";

const LOCK_MAX_AGE_MS = 120_000;
const FETCH_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;

function piHome(): string {
  return process.env.PI_SYNC_HOME ?? path.join(os.homedir(), ".pi");
}
function agentDir(): string {
  return path.join(piHome(), "agent");
}
function workDir(): string {
  return process.env.PI_SYNC_WORK ?? path.join(piHome(), "sync-repo");
}
function liveSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}
function liveKeybindingsPath(): string {
  return path.join(agentDir(), "keybindings.json");
}
function liveExtDir(): string {
  return path.join(agentDir(), "extensions");
}
function pendingPath(): string {
  return path.join(agentDir(), "pi-sync-pending.json");
}
function lockPath(): string {
  return path.join(agentDir(), "pi-sync.lock");
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface UiLike {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  notify(msg: string, type?: "info" | "warning" | "error"): void;
}

interface Meta {
  ts: number;
  machine: string;
}

interface Tombstone {
  type: "setting" | "package" | "file";
  id: string;
  ts: number;
  machine: string;
}

interface SyncState {
  version: 1;
  machines: Record<string, { lastSeen: string }>;
  settings: Record<string, Meta>;
  packages: Record<string, Meta>;
  files: Record<string, Meta>;
  tombstones: Tombstone[];
}

export interface SyncConfig {
  enabled: boolean;
  autoSync: boolean;
  repo?: string;
  machineId: string;
  excludeKeys: string[];
  includeFiles: string[];
  branch?: string;
}

export interface RunOptions {
  push: boolean;
  interactive: boolean;
  materialize?: boolean;
}

export interface RunResult {
  ok: boolean;
  notes: string[];
  errors: string[];
  conflictsResolved: number;
  conflictsPending: number;
  changedLocal: boolean;
  pushed: boolean;
}

type Side = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function emptyState(): SyncState {
  return { version: 1, machines: {}, settings: {}, packages: {}, files: {}, tombstones: [] };
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function preview(v: unknown, max = 60): string {
  const s = JSON.stringify(v);
  if (s === undefined) return "(无)";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number }) | null;
        resolve({
          code: anyErr ? (typeof anyErr.code === "number" ? anyErr.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (anyErr ? anyErr.message : ""),
        });
      },
    );
  });
}

const GIT_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8",
});

function git(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("git", args, { cwd: opts.cwd ?? workDir(), timeout: opts.timeout, env: GIT_ENV() });
}

/** 通过 shell 运行命令（用于 pi/npm，兼容 Windows 的 .cmd） */
function runShell(
  command: string,
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(command, { cwd: opts.cwd, shell: true, timeout: opts.timeout ?? 60_000, env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr || e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 包标识
// ---------------------------------------------------------------------------

export function entrySource(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
    return (entry as { source: string }).source;
  }
  return stableStringify(entry);
}

function isLocalPathSource(s: string): boolean {
  return (
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(s)
  );
}

/** 归一化包标识：npm 按包名；git 按 host/path（忽略协议、user@、.git、@ref）；local 按绝对路径 */
export function packageId(source: string): string {
  let s = source.trim();
  if (s.startsWith("npm:")) {
    const rest = s.slice(4);
    let name = rest;
    if (rest.startsWith("@")) {
      const slash = rest.indexOf("/");
      const at = slash > 0 ? rest.indexOf("@", slash) : -1;
      if (at > 0) name = rest.slice(0, at);
    } else {
      const at = rest.indexOf("@");
      if (at > 0) name = rest.slice(0, at);
    }
    return "npm:" + name.toLowerCase();
  }
  let body = s.startsWith("git:") && !s.startsWith("git@") ? s.slice(4) : s;
  if (isLocalPathSource(body)) return "local:" + path.resolve(body);
  // 去掉末尾 @ref（ref 中不含 / 和 :）
  const at = body.lastIndexOf("@");
  if (at > 0) {
    const tail = body.slice(at + 1);
    if (!/[/:]/.test(tail)) body = body.slice(0, at);
  }
  body = body.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // 协议
  body = body.replace(/^[\w.-]+@/, ""); // user@
  body = body.replace(/\.git$/i, "");
  body = body.replace(":", "/"); // host:path -> host/path
  return "git:" + body.toLowerCase();
}

/** git 包在本机的克隆目录（相对 ~/.pi/agent/git/），非 git 源返回 null */
function gitCloneRelDir(source: string): string | null {
  let s = source.trim();
  const isGit =
    (s.startsWith("git:") && !s.startsWith("git@")) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ||
    s.startsWith("git@");
  if (!isGit) return null;
  if (s.startsWith("git:") && !s.startsWith("git@")) s = s.slice(4);
  if (isLocalPathSource(s)) return null;
  const at = s.lastIndexOf("@");
  if (at > 0) {
    const tail = s.slice(at + 1);
    if (!/[/:]/.test(tail)) s = s.slice(0, at);
  }
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  s = s.replace(/^[\w.-]+@/, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(":", "/");
  return s;
}

/** 包是否已在本机物化（检查安装目录存在） */
function isMaterialized(entry: unknown): boolean {
  const src = entrySource(entry);
  const id = packageId(src);
  if (id.startsWith("npm:")) {
    return fs.existsSync(path.join(agentDir(), "npm", "node_modules", id.slice(4)));
  }
  if (id.startsWith("git:")) {
    const rel = gitCloneRelDir(src);
    if (!rel) return true;
    return fs.existsSync(path.join(agentDir(), "git", rel));
  }
  if (id.startsWith("local:")) return fs.existsSync(id.slice(6));
  return true;
}

// ---------------------------------------------------------------------------
// 同步状态（sync-state.json）
// ---------------------------------------------------------------------------

export function mergeStates(a: SyncState, b: SyncState): SyncState {
  const out: SyncState = emptyState();
  for (const m of new Set([...Object.keys(a.machines), ...Object.keys(b.machines)])) {
    const x = a.machines[m];
    const y = b.machines[m];
    out.machines[m] = !x ? y : !y ? x : x.lastSeen >= y.lastSeen ? x : y;
  }
  const mergeMeta = (
    x: Record<string, Meta>,
    y: Record<string, Meta>,
  ): Record<string, Meta> => {
    const r: Record<string, Meta> = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const mx = x[k];
      const my = y[k];
      if (mx && my) r[k] = mx.ts >= my.ts ? mx : my;
      else r[k] = (mx ?? my)!;
    }
    return r;
  };
  out.settings = mergeMeta(a.settings, b.settings);
  out.packages = mergeMeta(a.packages, b.packages);
  out.files = mergeMeta(a.files, b.files);
  const tombMap = new Map<string, Tombstone>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    const key = `${t.type}:${t.id}`;
    const prev = tombMap.get(key);
    if (!prev || t.ts >= prev.ts) tombMap.set(key, t);
  }
  out.tombstones = [...tombMap.values()];
  return out;
}

function tombstoneFor(state: SyncState, type: Tombstone["type"], id: string): Tombstone | undefined {
  return state.tombstones.find((t) => t.type === type && t.id === id);
}

function addTombstone(state: SyncState, type: Tombstone["type"], id: string, ts: number, machine: string): void {
  const existing = tombstoneFor(state, type, id);
  if (existing) {
    if (ts > existing.ts) {
      existing.ts = ts;
      existing.machine = machine;
    }
    return;
  }
  state.tombstones.push({ type, id, ts, machine });
}

function clearTombstone(state: SyncState, type: Tombstone["type"], id: string): void {
  state.tombstones = state.tombstones.filter((t) => !(t.type === type && t.id === id));
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export function loadConfig(): SyncConfig {
  const raw = readJson(liveSettingsPath());
  const s = (raw && typeof raw === "object" ? (raw as Side).sync : undefined) as Side | undefined;
  return {
    enabled: s?.enabled !== false,
    autoSync: s?.autoSync !== false,
    repo: typeof s?.repo === "string" ? s.repo : undefined,
    machineId: typeof s?.machineId === "string" && s.machineId ? s.machineId : os.hostname(),
    excludeKeys: Array.isArray(s?.excludeKeys) ? (s!.excludeKeys as string[]) : [],
    includeFiles: Array.isArray(s?.includeFiles) ? (s!.includeFiles as string[]) : [],
    branch: typeof s?.branch === "string" ? s.branch : undefined,
  };
}

function excludedKeys(cfg: SyncConfig): Set<string> {
  return new Set([...BUILTIN_EXCLUDED_KEYS, ...cfg.excludeKeys]);
}

function selfPackageId(cfg: SyncConfig): string | null {
  return cfg.repo ? packageId(cfg.repo) : null;
}

// ---------------------------------------------------------------------------
// 挂起冲突（自动模式跳过，交互模式 /sync 时弹窗解决）
// ---------------------------------------------------------------------------

function loadPending(): Set<string> {
  const raw = readJson(pendingPath());
  if (raw && typeof raw === "object" && Array.isArray((raw as Side).items)) {
    return new Set((raw as { items: string[] }).items);
  }
  return new Set();
}

function savePending(pending: Set<string>): void {
  if (pending.size === 0) {
    try {
      fs.unlinkSync(pendingPath());
    } catch {}
    return;
  }
  writeJson(pendingPath(), { items: [...pending] });
}

// ---------------------------------------------------------------------------
// git 仓库操作（工作克隆）
// ---------------------------------------------------------------------------

async function ensureIdentity(): Promise<void> {
  const name = await git(["config", "user.name"]);
  if (name.code !== 0 || !name.stdout.trim()) {
    await git(["config", "user.name", `pi-sync (${os.hostname()})`]);
    await git(["config", "user.email", "pi-sync@localhost"]);
  }
}

async function currentBranch(): Promise<string> {
  const r = await git(["symbolic-ref", "--short", "HEAD"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "main";
}

/** 克隆后修正：HEAD 未出生时检出远端默认分支；空仓库则建 main */
async function postCloneFixup(): Promise<void> {
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (head.code === 0) {
    await ensureIdentity();
    return;
  }
  let branch = "";
  const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) branch = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
  if (!branch) {
    const brs = await git(["branch", "-r", "--format=%(refname:short)"]);
    const names = brs.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("origin/"));
    branch = names.find((n) => n === "origin/main")?.slice(7) ?? names[0]?.slice(7) ?? "";
  }
  if (branch) await git(["checkout", "-b", branch, `origin/${branch}`]);
  else await git(["checkout", "-B", "main"]);
  await ensureIdentity();
}

/** 确保工作克隆存在；返回错误信息或 null */
async function ensureClone(cfg: SyncConfig): Promise<string | null> {
  if (fs.existsSync(path.join(workDir(), ".git"))) return null;
  if (!cfg.repo) return "未配置同步仓库，请先运行 /sync init";
  fs.mkdirSync(path.dirname(workDir()), { recursive: true });
  const r = await run("git", ["clone", cfg.repo, workDir()], { timeout: CLONE_TIMEOUT_MS, env: GIT_ENV() });
  if (r.code !== 0) return `克隆失败: ${r.stderr.trim() || r.stdout.trim()}`;
  await postCloneFixup();
  return null;
}

async function fetchRemote(): Promise<boolean> {
  const r = await git(["fetch", "origin"], { timeout: FETCH_TIMEOUT_MS });
  return r.code === 0;
}

async function remoteRef(): Promise<string | null> {
  const branch = await currentBranch();
  const r = await git(["rev-parse", "--verify", `origin/${branch}`]);
  return r.code === 0 ? `origin/${branch}` : null;
}

async function revListCount(range: string): Promise<number> {
  const r = await git(["rev-list", "--count", range]);
  return r.code === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
}

async function mergeBaseWith(ref: string): Promise<string | null> {
  const r = await git(["merge-base", "HEAD", ref]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

async function showAt(rev: string | null, rel: string): Promise<string | null> {
  if (!rev) return null;
  const r = await git(["show", `${rev}:${rel}`]);
  return r.code === 0 ? r.stdout : null;
}

async function jsonAt(rev: string | null, rel: string): Promise<Side | null> {
  const s = await showAt(rev, rel);
  if (s === null) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Side) : null;
  } catch {
    return null;
  }
}

async function listAt(rev: string | null, dirRel: string): Promise<string[]> {
  if (!rev) return [];
  const r = await git(["ls-tree", "-r", "--name-only", rev, "--", dirRel]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
}

async function commitIfDirty(message: string): Promise<boolean> {
  await git(["add", "-A", "--", "config"]);
  const st = await git(["status", "--porcelain", "--", "config"]);
  if (st.code !== 0 || !st.stdout.trim()) return false;
  const r = await git(["commit", "-m", message]);
  return r.code === 0;
}

/**
 * 语义合并后创建真正的合并提交（把远端提交记为第二父提交）。
 * 即使内容无变化也必须建合并提交，否则双方历史永远分叉、push 永远 non-fast-forward。
 */
async function commitMerge(otherParent: string, message: string): Promise<void> {
  await git(["add", "-A", "--", "config"]);
  const tree = await git(["write-tree"]);
  if (tree.code !== 0 || !tree.stdout.trim()) return;
  const c = await git(["commit-tree", tree.stdout.trim(), "-p", "HEAD", "-p", otherParent, "-m", message]);
  if (c.code !== 0 || !c.stdout.trim()) return;
  // 工作区内容本来就是我们写好的合并结果，reset 只是移动分支指针
  await git(["reset", "--hard", c.stdout.trim()]);
}

// ---------------------------------------------------------------------------
// 同步文件映射：仓库相对路径 <-> 本机绝对路径
// ---------------------------------------------------------------------------

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", ".git", "node_modules"]);

function isIgnoredExtRel(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((p) => IGNORED_NAMES.has(p))) return true;
  if (rel.endsWith(".log")) return true;
  // 同步扩展自身不通过文件同步分发（它由包机制分发），避免双份加载
  if (rel === "pi-sync.ts" || rel.startsWith("pi-sync/")) return true;
  return false;
}

function liveAbsForRepoRel(rel: string, cfg: SyncConfig): string | null {
  if (rel === REPO_KEYBINDINGS) return liveKeybindingsPath();
  if (rel === REPO_WEBSEARCH) {
    return cfg.includeFiles.includes("web-search.json") ? path.join(piHome(), "web-search.json") : null;
  }
  if (rel.startsWith(REPO_EXT_DIR + "/")) {
    const sub = rel.slice(REPO_EXT_DIR.length + 1);
    if (isIgnoredExtRel(sub)) return null;
    return path.join(liveExtDir(), ...sub.split("/"));
  }
  return null;
}

function walkFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...walkFiles(abs, base));
    else if (st.isFile()) out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

/** 本机现存的同步目标文件：仓库相对路径 -> 本机绝对路径 */
function collectLiveFiles(cfg: SyncConfig): Map<string, string> {
  const m = new Map<string, string>();
  if (fs.existsSync(liveKeybindingsPath())) m.set(REPO_KEYBINDINGS, liveKeybindingsPath());
  if (cfg.includeFiles.includes("web-search.json")) {
    const ws = path.join(piHome(), "web-search.json");
    if (fs.existsSync(ws)) m.set(REPO_WEBSEARCH, ws);
  }
  for (const rel of walkFiles(liveExtDir())) {
    if (isIgnoredExtRel(rel)) continue;
    m.set(`${REPO_EXT_DIR}/${rel}`, path.join(liveExtDir(), ...rel.split("/")));
  }
  return m;
}

function collectTreeFiles(cfg: SyncConfig): Map<string, string> {
  const m = new Map<string, string>();
  const root = workDir();
  const kb = path.join(root, REPO_KEYBINDINGS);
  if (fs.existsSync(kb)) m.set(REPO_KEYBINDINGS, kb);
  if (cfg.includeFiles.includes("web-search.json")) {
    const ws = path.join(root, REPO_WEBSEARCH);
    if (fs.existsSync(ws)) m.set(REPO_WEBSEARCH, ws);
  }
  const extRoot = path.join(root, REPO_EXT_DIR);
  for (const rel of walkFiles(extRoot)) {
    if (isIgnoredExtRel(rel)) continue;
    m.set(`${REPO_EXT_DIR}/${rel}`, path.join(extRoot, ...rel.split("/")));
  }
  return m;
}

// ---------------------------------------------------------------------------
// 纯合并逻辑（可测试）
// ---------------------------------------------------------------------------

export interface KeyMergeResult {
  tree: Side;
  skipped: string[];
  resolved: { key: string; winner: "local" | "remote" }[];
  notes: string[];
  liveMayDiffer: boolean;
}

/**
 * settings 顶层键三方合并（packages 键除外，单独走 mergePackageLists）。
 * local = 本机 HEAD（phase1 已写入本机改动），base = merge-base，remote = 远端。
 * resolve 返回 undefined 表示跳过（自动模式）：tree 取远端值，本机保留本地值并挂起。
 */
export function mergeSettingsKeys(opts: {
  base: Side;
  local: Side;
  remote: Side;
  excluded: Set<string>;
  state: SyncState; // 已合并双方元数据；就地更新
  remoteMeta: Record<string, Meta>;
  remoteTombstones: Tombstone[];
  now: number;
  machine: string;
  resolve?: (key: string, local: unknown, remote: unknown, remoteMeta?: Meta) => "local" | "remote" | undefined;
}): KeyMergeResult {
  const { base, local, remote, excluded, state, remoteMeta, remoteTombstones, now, machine, resolve } = opts;
  const tree: Side = { ...local };
  const skipped: string[] = [];
  const resolved: KeyMergeResult["resolved"] = [];
  const notes: string[] = [];
  const has = (o: Side, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    if (excluded.has(k) || k === "packages") continue;
    const hasB = has(base, k);
    const hasL = has(local, k);
    const hasR = has(remote, k);
    const b = base[k];
    const l = local[k];
    const r = remote[k];
    const lChanged = hasL !== hasB || (hasL && !jsonEq(l, b));
    const rChanged = hasR !== hasB || (hasR && !jsonEq(r, b));

    if (!lChanged && !rChanged) continue;

    if (lChanged && !rChanged) {
      // 本机改动（含删除），phase1 已写入 tree/state，无需动作
      continue;
    }

    if (!lChanged && rChanged) {
      if (!hasR) {
        // 远端删除 → 传播删除
        delete tree[k];
        delete state.settings[k];
        const t = remoteTombstones.find((x) => x.type === "setting" && x.id === k);
        if (t) addTombstone(state, "setting", k, t.ts, t.machine);
        notes.push(`-${k}（远端删除）`);
      } else {
        tree[k] = r;
        state.settings[k] = remoteMeta[k] ?? { ts: now, machine: "remote" };
        notes.push(`${hasB ? "~" : "+"}${k}（来自远端）`);
      }
      continue;
    }

    // 双方都变了
    if (hasL && hasR && jsonEq(l, r)) {
      state.settings[k] = state.settings[k] ?? remoteMeta[k] ?? { ts: now, machine };
      continue; // 收敛
    }
    if (!hasL && !hasR) continue; // 双方都删了
    if (!hasL && hasR) {
      // 本机删除 vs 远端修改：按时间戳
      const tomb = tombstoneFor(state, "setting", k);
      const rts = remoteMeta[k]?.ts ?? 0;
      if (tomb && tomb.ts >= rts) continue; // 删除生效
      tree[k] = r; // 远端较新 → 复活
      state.settings[k] = remoteMeta[k] ?? { ts: now, machine: "remote" };
      clearTombstone(state, "setting", k);
      notes.push(`~${k}（远端在删除后又修改，保留远端）`);
      continue;
    }
    if (hasL && !hasR) {
      const tomb = remoteTombstones.find((x) => x.type === "setting" && x.id === k);
      const lts = state.settings[k]?.ts ?? now;
      if (tomb && tomb.ts >= lts) {
        delete tree[k];
        delete state.settings[k];
        addTombstone(state, "setting", k, tomb.ts, tomb.machine);
        notes.push(`-${k}（远端删除）`);
      }
      // 否则本机较新，保留本机
      continue;
    }
    // 真冲突：双方改成不同值
    const winner = resolve ? resolve(k, l, r, remoteMeta[k]) : undefined;
    if (winner === "local") {
      state.settings[k] = { ts: now, machine };
      resolved.push({ key: k, winner });
    } else if (winner === "remote") {
      tree[k] = r;
      state.settings[k] = { ts: now, machine };
      resolved.push({ key: k, winner });
    } else {
      // 跳过：tree 用远端值，本机保留本地值，挂起
      tree[k] = r;
      skipped.push(k);
    }
  }
  return { tree, skipped, resolved, notes, liveMayDiffer: skipped.length > 0 };
}

export interface PkgMergeResult {
  list: unknown[];
  added: string[];
  removed: string[];
  notes: string[];
}

/** packages 清单三方合并：按归一化标识并集；同包不同版本按元数据时间戳 LWW（Q2） */
export function mergePackageLists(opts: {
  base: unknown[];
  local: unknown[];
  remote: unknown[];
  state: SyncState;
  remoteMeta: Record<string, Meta>;
  remoteTombstones: Tombstone[];
  now: number;
  machine: string;
  protectedId?: string | null;
}): PkgMergeResult {
  const { base, local, remote, state, remoteMeta, remoteTombstones, now, machine, protectedId } = opts;
  const byId = (list: unknown[]) => {
    const m = new Map<string, unknown>();
    for (const e of list) m.set(packageId(entrySource(e)), e);
    return m;
  };
  const b = byId(base);
  const l = byId(local);
  const r = byId(remote);
  const out = new Map<string, unknown>(l);
  const added: string[] = [];
  const removed: string[] = [];
  const notes: string[] = [];

  for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const inB = b.has(id);
    const inL = l.has(id);
    const inR = r.has(id);
    const eB = b.get(id);
    const eL = l.get(id);
    const eR = r.get(id);

    if (!inB && inL && !inR) continue; // 本机新增（phase1 已处理）
    if (!inB && inR && !inL) {
      out.set(id, eR);
      state.packages[id] = remoteMeta[id] ?? { ts: now, machine: "remote" };
      clearTombstone(state, "package", id);
      added.push(id);
      notes.push(`+包 ${id}（来自远端）`);
      continue;
    }
    if (inB && inL && !inR) {
      // 远端删除
      if (id === protectedId) continue;
      const tomb = remoteTombstones.find((x) => x.type === "package" && x.id === id);
      if (!jsonEq(eL, eB) && tomb && (state.packages[id]?.ts ?? now) > tomb.ts) continue; // 本机在删除后又改过 → 保留
      out.delete(id);
      delete state.packages[id];
      if (tomb) addTombstone(state, "package", id, tomb.ts, tomb.machine);
      removed.push(id);
      notes.push(`-包 ${id}（远端删除）`);
      continue;
    }
    if (inB && !inL && inR) {
      // 本机删除（phase1 已记账）；远端又改了版本 → 按时间戳决定
      const tomb = tombstoneFor(state, "package", id);
      if (!jsonEq(eR, eB)) {
        const rts = remoteMeta[id]?.ts ?? 0;
        if (!tomb || tomb.ts < rts) {
          out.set(id, eR);
          state.packages[id] = remoteMeta[id] ?? { ts: now, machine: "remote" };
          clearTombstone(state, "package", id);
          notes.push(`~包 ${id}（远端在删除后更新，复活为远端版本）`);
        }
      }
      continue;
    }
    if (inB && !inL && !inR) continue; // 双方都删了
    if (inL && inR) {
      if (jsonEq(eL, eR)) continue;
      if (inB && jsonEq(eL, eB)) {
        out.set(id, eR); // 只有远端改了
        state.packages[id] = remoteMeta[id] ?? { ts: now, machine: "remote" };
        notes.push(`~包 ${id} 版本（来自远端）`);
        continue;
      }
      if (inB && jsonEq(eR, eB)) continue; // 只有本机改了
      // 双方都改了（版本冲突）→ LWW
      const lts = state.packages[id]?.ts ?? 0;
      const rts = remoteMeta[id]?.ts ?? 0;
      if (rts > lts) {
        out.set(id, eR);
        state.packages[id] = remoteMeta[id]!;
        notes.push(`~包 ${id} 版本（远端较新）`);
      }
      continue;
    }
  }
  const list = [...out.values()];
  list.sort((x, y) => packageId(entrySource(x)).localeCompare(packageId(entrySource(y))));
  return { list, added, removed, notes };
}

// ---------------------------------------------------------------------------
// phase1：本机改动 -> 工作克隆（2-way，记录时间戳与墓碑）
// ---------------------------------------------------------------------------

function phase1(cfg: SyncConfig, state: SyncState, pending: Set<string>): { changed: boolean; notes: string[] } {
  const now = Date.now();
  const machine = cfg.machineId;
  const notes: string[] = [];
  let changed = false;
  const excluded = excludedKeys(cfg);
  const protectedId = selfPackageId(cfg);

  // settings（含 packages）
  const live = (readJson(liveSettingsPath()) ?? {}) as Side;
  const treePath = path.join(workDir(), REPO_SETTINGS);
  const tree = (readJson(treePath) ?? {}) as Side;

  // 清除树中的排除键（脚本时代遗留的 lastChangelogVersion 等）
  for (const k of Object.keys(tree)) {
    if (excluded.has(k)) {
      delete tree[k];
      changed = true;
      notes.push(`-${k}（排除键，停止跟踪）`);
    }
  }

  const keys = new Set([...Object.keys(live), ...Object.keys(tree)]);
  for (const k of keys) {
    if (excluded.has(k) || k === "packages") continue;
    if (pending.has(`setting:${k}`)) continue;
    const hasL = Object.prototype.hasOwnProperty.call(live, k);
    const hasT = Object.prototype.hasOwnProperty.call(tree, k);
    if (hasL && (!hasT || !jsonEq(live[k], tree[k]))) {
      tree[k] = live[k];
      state.settings[k] = { ts: now, machine };
      clearTombstone(state, "setting", k);
      changed = true;
      notes.push(`${hasT ? "~" : "+"}${k}`);
    } else if (!hasL && hasT) {
      delete tree[k];
      delete state.settings[k];
      addTombstone(state, "setting", k, now, machine);
      changed = true;
      notes.push(`-${k}`);
    }
  }

  // packages
  const livePkgs = Array.isArray(live.packages) ? (live.packages as unknown[]) : [];
  const treePkgs = Array.isArray(tree.packages) ? (tree.packages as unknown[]) : [];
  const liveById = new Map(livePkgs.map((e) => [packageId(entrySource(e)), e]));
  const treeById = new Map(treePkgs.map((e) => [packageId(entrySource(e)), e]));
  let pkgChanged = false;
  for (const id of new Set([...liveById.keys(), ...treeById.keys()])) {
    const inL = liveById.has(id);
    const inT = treeById.has(id);
    if (inL && (!inT || !jsonEq(liveById.get(id), treeById.get(id)))) {
      treeById.set(id, liveById.get(id));
      state.packages[id] = { ts: now, machine };
      clearTombstone(state, "package", id);
      pkgChanged = true;
      notes.push(`${inT ? "~" : "+"}包 ${id}`);
    } else if (!inL && inT) {
      if (id === protectedId) continue; // 同步扩展自身所在的包不允许被删除传播
      treeById.delete(id);
      delete state.packages[id];
      addTombstone(state, "package", id, now, machine);
      pkgChanged = true;
      notes.push(`-包 ${id}`);
    }
  }
  if (pkgChanged) {
    const list = [...treeById.values()];
    list.sort((x, y) => packageId(entrySource(x)).localeCompare(packageId(entrySource(y))));
    tree.packages = list;
    changed = true;
  }

  if (changed) writeJson(treePath, tree);

  // 文件（keybindings / web-search / extensions）
  const liveFiles = collectLiveFiles(cfg);
  const treeFiles = collectTreeFiles(cfg);
  // web-search.json 未显式启用时停止跟踪（脚本时代遗留，可能含 API key）
  if (!cfg.includeFiles.includes("web-search.json") && treeFiles.has(REPO_WEBSEARCH)) {
    fs.unlinkSync(treeFiles.get(REPO_WEBSEARCH)!);
    treeFiles.delete(REPO_WEBSEARCH);
    delete state.files[REPO_WEBSEARCH];
    changed = true;
    notes.push(`-文件 ${REPO_WEBSEARCH}（停止跟踪）`);
  }
  for (const rel of new Set([...liveFiles.keys(), ...treeFiles.keys()])) {
    if (pending.has(`file:${rel}`)) continue;
    const lp = liveFiles.get(rel);
    const tp = treeFiles.get(rel);
    if (lp && tp) {
      if (!fs.readFileSync(lp).equals(fs.readFileSync(tp))) {
        fs.copyFileSync(lp, tp);
        state.files[rel] = { ts: now, machine };
        clearTombstone(state, "file", rel);
        changed = true;
        notes.push(`~文件 ${rel}`);
      }
    } else if (lp && !tp) {
      const dest = path.join(workDir(), rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(lp, dest);
      state.files[rel] = { ts: now, machine };
      clearTombstone(state, "file", rel);
      changed = true;
      notes.push(`+文件 ${rel}`);
    } else if (!lp && tp) {
      fs.unlinkSync(tp);
      delete state.files[rel];
      addTombstone(state, "file", rel, now, machine);
      changed = true;
      notes.push(`-文件 ${rel}`);
    }
  }

  // lastSeen 仅在有实际改动或超过 6 小时未记录时更新，避免每次退出都产生空提交
  const prevSeen = Date.parse(state.machines[machine]?.lastSeen ?? "") || 0;
  if (changed || now - prevSeen > 6 * 3600_000) {
    state.machines[machine] = { lastSeen: new Date().toISOString() };
  }
  return { changed, notes };
}

// ---------------------------------------------------------------------------
// phase2：远端改动 -> 工作克隆（merge-base 三方合并）
// ---------------------------------------------------------------------------

interface Phase2Result {
  merged: boolean;
  notes: string[];
  skipped: Set<string>;
  resolved: { key: string; winner: "local" | "remote" }[];
}

async function phase2(
  cfg: SyncConfig,
  ref: string,
  ui: UiLike | null,
  interactive: boolean,
  pending: Set<string>,
): Promise<Phase2Result> {
  const notes: string[] = [];
  const skipped = new Set<string>();
  const resolved: Phase2Result["resolved"] = [];
  const now = Date.now();
  const machine = cfg.machineId;

  const mb = await mergeBaseWith(ref); // null → 无共同祖先（首次），base 视为空
  const excluded = excludedKeys(cfg);
  const protectedId = selfPackageId(cfg);

  // --- 元数据合并 ---
  const localState = (readJson(path.join(workDir(), REPO_STATE)) as SyncState | null) ?? emptyState();
  const remoteStateRaw = await jsonAt(ref, REPO_STATE);
  const remoteState: SyncState = remoteStateRaw
    ? { ...emptyState(), ...(remoteStateRaw as unknown as SyncState) }
    : emptyState();
  const state = mergeStates(localState, remoteState);
  const remoteMeta = remoteState.settings;
  const remotePkgMeta = remoteState.packages;
  const remoteFileMeta = remoteState.files;
  const remoteTombs = remoteState.tombstones;

  // --- settings ---
  const strip = (o: Side | null): Side => {
    const r: Side = {};
    if (!o) return r;
    for (const [k, v] of Object.entries(o)) if (!excluded.has(k)) r[k] = v;
    return r;
  };
  const baseS = strip(await jsonAt(mb, REPO_SETTINGS));
  const localS = strip(await jsonAt("HEAD", REPO_SETTINGS));
  const remoteS = strip(await jsonAt(ref, REPO_SETTINGS));

  // 弹窗是异步的，mergeSettingsKeys 是同步的 → 先收集冲突，再统一弹窗
  const conflicts: { key: string; l: unknown; r: unknown; m?: Meta }[] = [];
  const keyMerge = mergeSettingsKeys({
    base: baseS,
    local: localS,
    remote: remoteS,
    excluded,
    state,
    remoteMeta,
    remoteTombstones: remoteTombs,
    now,
    machine,
    resolve: (key, l, r, m) => {
      conflicts.push({ key, l, r, m });
      return undefined; // 先按跳过处理，弹窗后覆写
    },
  });
  notes.push(...keyMerge.notes);

  // packages 单独合并
  const pkgMerge = mergePackageLists({
    base: Array.isArray(baseS.packages) ? baseS.packages : [],
    local: Array.isArray(localS.packages) ? localS.packages : [],
    remote: Array.isArray(remoteS.packages) ? remoteS.packages : [],
    state,
    remoteMeta: remotePkgMeta,
    remoteTombstones: remoteTombs,
    now,
    machine,
    protectedId,
  });
  notes.push(...pkgMerge.notes);
  if (pkgMerge.list.length > 0 || Object.prototype.hasOwnProperty.call(localS, "packages")) {
    keyMerge.tree.packages = pkgMerge.list;
  }

  // --- 冲突弹窗（交互模式） ---
  for (const c of conflicts) {
    let winner: "local" | "remote" | undefined;
    if (interactive && ui) {
      const rm = c.m;
      const remoteLabel = rm ? `远端 ${rm.machine}（${fmtAgo(rm.ts)}）` : "远端";
      const pick = await ui.select(`配置冲突：${c.key}`, [
        `本机 ${machine}：${preview(c.l)}`,
        `${remoteLabel}：${preview(c.r)}`,
      ]);
      if (pick) winner = pick.startsWith("本机") ? "local" : "remote";
    }
    if (winner === "local") {
      keyMerge.tree[c.key] = c.l;
      state.settings[c.key] = { ts: now, machine };
      resolved.push({ key: c.key, winner });
    } else if (winner === "remote") {
      keyMerge.tree[c.key] = c.r;
      state.settings[c.key] = { ts: now, machine };
      resolved.push({ key: c.key, winner });
    } else {
      skipped.add(`setting:${c.key}`);
      notes.push(`!冲突挂起 ${c.key}`);
    }
  }

  // --- 文件三方合并 ---
  const rels = new Set<string>();
  for (const rev of [mb, "HEAD", ref]) {
    for (const f of await listAt(rev, "config/pi")) rels.add(f);
  }
  for (const rel of rels) {
    if (rel === REPO_SETTINGS || rel === REPO_STATE) continue;
    const liveAbs = liveAbsForRepoRel(rel, cfg);
    if (!liveAbs) continue;
    if (pending.has(`file:${rel}`)) continue;

    const b = await showAt(mb, rel);
    const l = await showAt("HEAD", rel);
    const r = await showAt(ref, rel);
    const hasB = b !== null;
    const hasL = l !== null;
    const hasR = r !== null;
    const lChanged = hasL !== hasB || (hasL && l !== b);
    const rChanged = hasR !== hasB || (hasR && r !== b);
    if (!lChanged && !rChanged) continue;

    const treeAbs = path.join(workDir(), rel);
    const writeTree = (content: string | null) => {
      if (content === null) {
        try {
          fs.unlinkSync(treeAbs);
        } catch {}
      } else {
        fs.mkdirSync(path.dirname(treeAbs), { recursive: true });
        fs.writeFileSync(treeAbs, content, "utf8");
      }
    };

    if (lChanged && !rChanged) continue; // 本机改动已在 tree
    if (!lChanged && rChanged) {
      if (!hasR) {
        writeTree(null);
        delete state.files[rel];
        const t = remoteTombs.find((x) => x.type === "file" && x.id === rel);
        if (t) addTombstone(state, "file", rel, t.ts, t.machine);
        notes.push(`-文件 ${rel}（远端删除）`);
      } else {
        writeTree(r);
        state.files[rel] = remoteFileMeta[rel] ?? { ts: now, machine: "remote" };
        clearTombstone(state, "file", rel);
        notes.push(`${hasB ? "~" : "+"}文件 ${rel}（来自远端）`);
      }
      continue;
    }
    if (hasL && hasR && l === r) continue;
    if (!hasL && !hasR) continue;
    if (!hasL && hasR) {
      const tomb = tombstoneFor(state, "file", rel);
      const rts = remoteFileMeta[rel]?.ts ?? 0;
      if (tomb && tomb.ts >= rts) continue;
      writeTree(r);
      state.files[rel] = remoteFileMeta[rel] ?? { ts: now, machine: "remote" };
      clearTombstone(state, "file", rel);
      notes.push(`~文件 ${rel}（远端在删除后又修改，保留远端）`);
      continue;
    }
    if (hasL && !hasR) {
      const tomb = remoteTombs.find((x) => x.type === "file" && x.id === rel);
      const lts = state.files[rel]?.ts ?? now;
      if (tomb && tomb.ts >= lts) {
        writeTree(null);
        delete state.files[rel];
        addTombstone(state, "file", rel, tomb.ts, tomb.machine);
        notes.push(`-文件 ${rel}（远端删除）`);
      }
      continue;
    }
    // 双方都改了且内容不同 → 冲突
    let winner: "local" | "remote" | undefined;
    if (interactive && ui) {
      const rm = remoteFileMeta[rel];
      const remoteLabel = rm ? `远端 ${rm.machine}（${fmtAgo(rm.ts)}）` : "远端";
      const pick = await ui.select(`文件冲突：${rel}`, [
        `本机 ${machine}（${(l ?? "").length} 字符）`,
        `${remoteLabel}（${(r ?? "").length} 字符）`,
      ]);
      if (pick) winner = pick.startsWith("本机") ? "local" : "remote";
    }
    if (winner === "local") {
      writeTree(l);
      state.files[rel] = { ts: now, machine };
      resolved.push({ key: rel, winner });
    } else if (winner === "remote") {
      writeTree(r);
      state.files[rel] = { ts: now, machine };
      resolved.push({ key: rel, winner });
    } else {
      writeTree(r); // tree 用远端值，本机保留本地值，挂起
      skipped.add(`file:${rel}`);
      notes.push(`!冲突挂起 ${rel}`);
    }
  }

  // 写回并创建合并提交（远端为第二父提交，保证后续 push 可快进）
  writeJson(path.join(workDir(), REPO_SETTINGS), keyMerge.tree);
  writeJson(path.join(workDir(), REPO_STATE), state);
  await commitMerge(ref, `pi-sync: merge ${ref} (${machine})`);
  return { merged: true, notes, skipped, resolved };
}

// ---------------------------------------------------------------------------
// applyToLive：工作克隆 -> 本机配置
// ---------------------------------------------------------------------------

function applyToLive(cfg: SyncConfig, pending: Set<string>): { changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;
  const excluded = excludedKeys(cfg);

  // settings：保留本机排除键与被挂起键，其余以 tree 为准
  const liveP = liveSettingsPath();
  const live = (readJson(liveP) ?? {}) as Side;
  const tree = (readJson(path.join(workDir(), REPO_SETTINGS)) ?? {}) as Side;
  const next: Side = { ...live };
  for (const k of Object.keys(tree)) {
    if (excluded.has(k)) continue;
    if (pending.has(`setting:${k}`)) continue;
    if (!jsonEq(next[k], tree[k])) {
      next[k] = tree[k];
      changed = true;
    }
  }
  for (const k of Object.keys(live)) {
    if (excluded.has(k)) continue;
    if (pending.has(`setting:${k}`)) continue;
    if (!Object.prototype.hasOwnProperty.call(tree, k)) {
      delete next[k];
      changed = true;
    }
  }
  if (changed) {
    writeJson(liveP, next);
    notes.push("settings.json 已更新");
  }

  // 文件：tree -> live 镜像（跳过挂起项）
  const treeFiles = collectTreeFiles(cfg);
  const liveFiles = collectLiveFiles(cfg);
  for (const [rel, tp] of treeFiles) {
    if (pending.has(`file:${rel}`)) continue;
    const lp = liveFiles.get(rel) ?? liveAbsForRepoRel(rel, cfg);
    if (!lp) continue;
    if (!fs.existsSync(lp) || !fs.readFileSync(lp).equals(fs.readFileSync(tp))) {
      fs.mkdirSync(path.dirname(lp), { recursive: true });
      fs.copyFileSync(tp, lp);
      changed = true;
      notes.push(`文件落地 ${rel}`);
    }
  }
  for (const [rel, lp] of liveFiles) {
    if (pending.has(`file:${rel}`)) continue;
    if (!treeFiles.has(rel)) {
      try {
        fs.unlinkSync(lp);
        changed = true;
        notes.push(`本机文件移除 ${rel}`);
      } catch {}
    }
  }
  return { changed, notes };
}

/** 物化：按合并后的 packages 清单补装缺失/变更的包（复用 pi install） */
async function materialize(prevLivePackages: unknown[], notes: string[], errors: string[]): Promise<void> {
  const live = (readJson(liveSettingsPath()) ?? {}) as Side;
  const next = Array.isArray(live.packages) ? (live.packages as unknown[]) : [];
  const prevById = new Map(prevLivePackages.map((e) => [packageId(entrySource(e)), e]));
  const jobs: string[] = [];
  for (const entry of next) {
    const id = packageId(entrySource(entry));
    const src = entrySource(entry);
    const prev = prevById.get(id);
    const sourceChanged = prev !== undefined && !jsonEq(prev, entry);
    if (!isMaterialized(entry) || sourceChanged) {
      if (!jobs.includes(src)) jobs.push(src);
    }
  }
  for (const src of jobs) {
    const r = await runShell(`pi install --no-approve ${JSON.stringify(src)}`, {
      cwd: os.homedir(),
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (r.code === 0) notes.push(`已安装 ${src}`);
    else errors.push(`安装失败 ${src}: ${(r.stderr || r.stdout).trim().slice(0, 120)}`);
  }
  // 同步下来的扩展目录若有 package.json 而无 node_modules，补装依赖
  const extRoot = liveExtDir();
  const candidates = [extRoot, ...walkFiles(extRoot).filter((r) => r.endsWith("/package.json")).map((r) => path.join(extRoot, path.dirname(r)))];
  for (const dir of new Set(candidates)) {
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    if (fs.existsSync(path.join(dir, "node_modules"))) continue;
    const r = await runShell("npm install", { cwd: dir, timeout: INSTALL_TIMEOUT_MS });
    if (r.code === 0) notes.push(`扩展依赖已安装：${path.basename(dir)}`);
    else errors.push(`扩展依赖安装失败：${dir}`);
  }
}

// ---------------------------------------------------------------------------
// 锁
// ---------------------------------------------------------------------------

function acquireLock(): boolean {
  try {
  	const p = lockPath();
    if (fs.existsSync(p)) {
      const raw = readJson(p) as { ts?: number } | null;
      if (raw?.ts && Date.now() - raw.ts < LOCK_MAX_AGE_MS) return false;
    }
    writeJson(p, { pid: process.pid, ts: Date.now() });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {}
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runSync(ui: UiLike | null, opts: RunOptions): Promise<RunResult> {
  const result: RunResult = {
    ok: false,
    notes: [],
    errors: [],
    conflictsResolved: 0,
    conflictsPending: 0,
    changedLocal: false,
    pushed: false,
  };
  const cfg = loadConfig();
  if (!cfg.repo) {
    result.errors.push("未配置同步仓库，请先运行 /sync init");
    return result;
  }
  if (!acquireLock()) {
    result.errors.push("另一个同步正在进行中，已跳过");
    return result;
  }
  try {
    const cloneErr = await ensureClone(cfg);
    if (cloneErr) {
      result.errors.push(cloneErr);
      return result;
    }
    const pending = loadPending();
    const prevLive = (readJson(liveSettingsPath()) ?? {}) as Side;
    const prevLivePackages = Array.isArray(prevLive.packages) ? (prevLive.packages as unknown[]) : [];

    // phase1：本机改动 -> 工作克隆（phase1 就地修改 state1，随后落盘）
    const state1 = (readJson(path.join(workDir(), REPO_STATE)) as SyncState | null) ?? emptyState();
    const p1 = phase1(cfg, state1, pending);
    writeJson(path.join(workDir(), REPO_STATE), state1);
    await commitIfDirty(`pi-sync: update from ${cfg.machineId}`);
    if (p1.notes.length) result.notes.push(`本机改动 ${p1.notes.length} 项`);

    // phase2：远端 -> 工作克隆
    const ref = await remoteRef();
    if (ref && (await fetchRemote())) {
      const ahead = await revListCount(`HEAD..${ref}`);
      if (ahead > 0) {
        const p2 = await phase2(cfg, ref, ui, opts.interactive, pending);
        result.notes.push(...p2.notes);
        result.conflictsResolved += p2.resolved.length;
        for (const s of p2.skipped) pending.add(s);
      }
    } else if (!ref) {
      // 远端还没有分支（空仓库）——phase1 内容将作为初始内容
    } else {
      result.errors.push("无法连接远端（离线？），已仅提交本地改动");
    }

    // 挂起冲突（交互模式 drain：弹窗比较本机与 tree）
    if (opts.interactive && ui && pending.size > 0) {
      const now = Date.now();
      let drained = false;
      const treeSettingsP = path.join(workDir(), REPO_SETTINGS);
      for (const id of [...pending]) {
        const [type, key] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
        if (type === "setting") {
          const live = (readJson(liveSettingsPath()) ?? {}) as Side;
          const tree = (readJson(treeSettingsP) ?? {}) as Side;
          const hasL = Object.prototype.hasOwnProperty.call(live, key);
          const hasT = Object.prototype.hasOwnProperty.call(tree, key);
          if (hasL === hasT && (!hasL || jsonEq(live[key], tree[key]))) {
            pending.delete(id);
            continue;
          }
          const pick = await ui.select(`待解决冲突：${key}`, [
            `本机：${hasL ? preview(live[key]) : "(已删除)"}`,
            `远端：${hasT ? preview(tree[key]) : "(已删除)"}`,
          ]);
          if (!pick) continue;
          const chooseLocal = pick.startsWith("本机");
          const winner = chooseLocal ? live[key] : tree[key];
          const winnerExists = chooseLocal ? hasL : hasT;
          const state = (readJson(path.join(workDir(), REPO_STATE)) as SyncState | null) ?? emptyState();
          if (winnerExists) {
            tree[key] = winner;
            const l2 = (readJson(liveSettingsPath()) ?? {}) as Side;
            l2[key] = winner;
            writeJson(liveSettingsPath(), l2);
            state.settings[key] = { ts: now, machine: cfg.machineId };
            clearTombstone(state, "setting", key);
          } else {
            delete tree[key];
            const l2 = (readJson(liveSettingsPath()) ?? {}) as Side;
            delete l2[key];
            writeJson(liveSettingsPath(), l2);
            delete state.settings[key];
            addTombstone(state, "setting", key, now, cfg.machineId);
          }
          writeJson(treeSettingsP, tree);
          writeJson(path.join(workDir(), REPO_STATE), state);
          pending.delete(id);
          result.conflictsResolved++;
          drained = true;
        } else if (type === "file") {
          const liveAbs = liveAbsForRepoRel(key, cfg);
          const treeAbs = path.join(workDir(), key);
          const hasL = liveAbs !== null && fs.existsSync(liveAbs);
          const hasT = fs.existsSync(treeAbs);
          const l = hasL ? fs.readFileSync(liveAbs!, "utf8") : null;
          const t = hasT ? fs.readFileSync(treeAbs, "utf8") : null;
          if (l === t) {
            pending.delete(id);
            continue;
          }
          const pick = await ui.select(`待解决文件冲突：${key}`, [
            `本机（${l === null ? "已删除" : `${l.length} 字符`}）`,
            `远端（${t === null ? "已删除" : `${t.length} 字符`}）`,
          ]);
          if (!pick) continue;
          const chooseLocal = pick.startsWith("本机");
          const winner = chooseLocal ? l : t;
          const state = (readJson(path.join(workDir(), REPO_STATE)) as SyncState | null) ?? emptyState();
          if (winner === null) {
            if (hasT) fs.unlinkSync(treeAbs);
            if (hasL) fs.unlinkSync(liveAbs!);
            delete state.files[key];
            addTombstone(state, "file", key, now, cfg.machineId);
          } else {
            fs.mkdirSync(path.dirname(treeAbs), { recursive: true });
            fs.writeFileSync(treeAbs, winner, "utf8");
            if (liveAbs) {
              fs.mkdirSync(path.dirname(liveAbs), { recursive: true });
              fs.writeFileSync(liveAbs, winner, "utf8");
            }
            state.files[key] = { ts: now, machine: cfg.machineId };
            clearTombstone(state, "file", key);
          }
          writeJson(path.join(workDir(), REPO_STATE), state);
          pending.delete(id);
          result.conflictsResolved++;
          drained = true;
        }
      }
      if (drained) await commitIfDirty(`pi-sync: resolve conflicts (${cfg.machineId})`);
    }

    // 写回本机
    const applied = applyToLive(cfg, pending);
    result.changedLocal = applied.changed;
    result.notes.push(...applied.notes);

    // 物化缺失/变更的包
    if (opts.materialize !== false) {
      await materialize(prevLivePackages, result.notes, result.errors);
    }

    // 推送
    if (opts.push) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const branch = await currentBranch();
        const pr = await git(["push", "origin", `HEAD:${branch}`], { timeout: PUSH_TIMEOUT_MS });
        if (pr.code === 0) {
          result.pushed = true;
          break;
        }
        const rejected = /non-fast-forward|fetch first|rejected|stale/i.test(pr.stderr);
        if (!rejected || attempt === 2) {
          result.errors.push(`推送失败: ${pr.stderr.trim().slice(0, 160)}`);
          break;
        }
        // 他机刚推过：重新合并再推
        if (!(await fetchRemote())) break;
        const ref2 = await remoteRef();
        if (!ref2) break;
        const p2 = await phase2(cfg, ref2, null, false, pending);
        result.notes.push(...p2.notes);
        for (const s of p2.skipped) pending.add(s);
        const applied2 = applyToLive(cfg, pending);
        result.changedLocal = result.changedLocal || applied2.changed;
      }
    }

    savePending(pending);
    result.conflictsPending = pending.size;
    result.ok = result.errors.length === 0;
    return result;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export async function performInit(
  ui: UiLike | null,
  repoUrl: string,
  mode: "remote" | "local",
): Promise<{ ok: boolean; message: string }> {
  if (fs.existsSync(path.join(workDir(), ".git"))) {
    return { ok: false, message: `已初始化（${workDir()}），直接运行 /sync 即可` };
  }
  fs.mkdirSync(path.dirname(workDir()), { recursive: true });
  const r = await run("git", ["clone", repoUrl, workDir()], { timeout: CLONE_TIMEOUT_MS, env: GIT_ENV() });
  if (r.code !== 0) return { ok: false, message: `克隆失败: ${r.stderr.trim() || r.stdout.trim()}` };
  await postCloneFixup();

  // 写入本机 sync 配置（sync 键被排除，不会参与同步）
  const liveP = liveSettingsPath();
  const live = (readJson(liveP) ?? {}) as Side;
  const prevSync = (live.sync as Side | undefined) ?? {};
  live.sync = { enabled: true, autoSync: true, ...prevSync, repo: repoUrl };
  writeJson(liveP, live);

  const cfg = loadConfig();
  const hasData = fs.existsSync(path.join(workDir(), REPO_SETTINGS));

  if (mode === "remote" && hasData) {
    // 以远端为准：共享键整体采用远端值，保留本机排除键与 sync 配置；packages 保护自身包
    const tree = (readJson(path.join(workDir(), REPO_SETTINGS)) ?? {}) as Side;
    const cur = (readJson(liveP) ?? {}) as Side;
    const excluded = excludedKeys(cfg);
    const next: Side = {};
    for (const [k, v] of Object.entries(cur)) if (excluded.has(k)) next[k] = v;
    for (const [k, v] of Object.entries(tree)) if (!excluded.has(k)) next[k] = v;
    const selfId = selfPackageId(cfg);
    if (selfId) {
      const nextPkgs = Array.isArray(next.packages) ? (next.packages as unknown[]) : [];
      const curPkgs = Array.isArray(cur.packages) ? (cur.packages as unknown[]) : [];
      const has = nextPkgs.some((e) => packageId(entrySource(e)) === selfId);
      const selfEntry = curPkgs.find((e) => packageId(entrySource(e)) === selfId);
      if (!has && selfEntry) next.packages = [...nextPkgs, selfEntry];
    }
    writeJson(liveP, next);
    // 扩展文件并集落地（不删本机多出的文件）
    const treeFiles = collectTreeFiles(cfg);
    for (const [rel, tp] of treeFiles) {
      const lp = liveAbsForRepoRel(rel, cfg);
      if (!lp) continue;
      if (!fs.existsSync(lp) || !fs.readFileSync(lp).equals(fs.readFileSync(tp))) {
        fs.mkdirSync(path.dirname(lp), { recursive: true });
        fs.copyFileSync(tp, lp);
      }
    }
  }
  return { ok: true, message: "初始化完成" };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function statusText(cfg: SyncConfig): Promise<string> {
  if (!fs.existsSync(path.join(workDir(), ".git"))) return "pi-sync：未初始化，运行 /sync init";
  const lines: string[] = [];
  lines.push(`仓库: ${cfg.repo}（工作克隆 ${workDir()}）`);
  const pending = loadPending();
  // 本机待推送
  const excluded = excludedKeys(cfg);
  const live = (readJson(liveSettingsPath()) ?? {}) as Side;
  const tree = (readJson(path.join(workDir(), REPO_SETTINGS)) ?? {}) as Side;
  const diffKeys = new Set([...Object.keys(live), ...Object.keys(tree)]);
  let keyDiffs = 0;
  for (const k of diffKeys) {
    if (excluded.has(k)) continue;
    if (!jsonEq(live[k], tree[k])) keyDiffs++;
  }
  const liveFiles = collectLiveFiles(cfg);
  const treeFiles = collectTreeFiles(cfg);
  let fileDiffs = 0;
  for (const rel of new Set([...liveFiles.keys(), ...treeFiles.keys()])) {
    const lp = liveFiles.get(rel);
    const tp = treeFiles.get(rel);
    if (!lp || !tp) fileDiffs++;
    else if (!fs.readFileSync(lp).equals(fs.readFileSync(tp))) fileDiffs++;
  }
  lines.push(`本机与工作克隆差异: ${keyDiffs} 个配置键，${fileDiffs} 个文件`);
  // 远端
  if (await fetchRemote()) {
    const ref = await remoteRef();
    if (ref) {
      const incoming = await revListCount(`HEAD..${ref}`);
      const outgoing = await revListCount(`${ref}..HEAD`);
      lines.push(`远端: ${incoming} 个提交待拉取，${outgoing} 个提交待推送`);
    } else {
      lines.push("远端: 空仓库（首次推送将创建分支）");
    }
  } else {
    lines.push("远端: 不可达（离线？）");
  }
  // 机器列表
  const state = (readJson(path.join(workDir(), REPO_STATE)) as SyncState | null) ?? emptyState();
  const machines = Object.entries(state.machines)
    .map(([m, v]) => `${m}${m === cfg.machineId ? "(本机)" : ""} ${v.lastSeen.slice(0, 16).replace("T", " ")}`)
    .join("；");
  if (machines) lines.push(`机器: ${machines}`);
  if (pending.size > 0) lines.push(`⚠️ ${pending.size} 项冲突待解决（运行 /sync）`);
  lines.push(`自动同步: ${cfg.enabled && cfg.autoSync ? "开" : "关"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 自动同步
// ---------------------------------------------------------------------------

let autoRunning = false;

async function autoRun(ui: UiLike | null, reason: string, push: boolean): Promise<void> {
  if (autoRunning) return;
  autoRunning = true;
  try {
    const result = await runSync(ui, { push, interactive: false, materialize: true });
    const interesting =
      result.notes.length > 0 || result.errors.length > 0 || result.conflictsPending > 0;
    if (!interesting || !ui) return;
    if (result.errors.length > 0) {
      ui.notify(`pi-sync（${reason}）：${result.errors[0]}`, "warning");
      return;
    }
    const parts: string[] = [];
    if (result.notes.length) parts.push(result.notes.slice(0, 6).join("；"));
    if (result.conflictsPending) parts.push(`${result.conflictsPending} 项冲突待 /sync 处理`);
    if (result.changedLocal) parts.push("配置已更新，/reload 后生效");
    if (parts.length) ui.notify(`pi-sync：${parts.join("；")}`, "info");
  } catch (e) {
    try {
      ui?.notify(`pi-sync（${reason}）失败: ${(e as Error).message}`, "warning");
    } catch {}
  } finally {
    autoRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sync", {
    description:
      "多机配置同步：/sync [push|pull|status|on|off] 或 /sync init [repo] [--mode=remote|local]",
    handler: async (args, ctx) => {
      const ui: UiLike = ctx.ui;
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cfg = loadConfig();

      if (sub === "init") {
        const modeFlag = rest.find((a) => a.startsWith("--mode="))?.slice(7);
        const repoArg = rest.find((a) => !a.startsWith("--"));
        if (fs.existsSync(path.join(workDir(), ".git"))) {
          ui.notify(`pi-sync 已初始化（${workDir()}）`, "warning");
          return;
        }
        let repoUrl = repoArg;
        if (!repoUrl) {
          if (!ctx.hasUI || !ui.input) {
            ui.notify("用法: /sync init <repo-url> [--mode=remote|local]", "error");
            return;
          }
          repoUrl = await ui.input("同步仓库地址", DEFAULT_REPO);
          if (!repoUrl) return;
        }
        let mode = modeFlag === "remote" || modeFlag === "local" ? modeFlag : undefined;
        if (!mode) {
          if (!ctx.hasUI) {
            ui.notify("非交互模式请显式指定 --mode=remote 或 --mode=local", "error");
            return;
          }
          const pick = await ui.select("初始化方式", [
            "以远端为准（推荐新机器：本机共享配置整体替换为远端）",
            "以本机为准（本机配置合并上传，覆盖仓库旧备份语义）",
          ]);
          if (!pick) return;
          mode = pick.startsWith("以远端") ? "remote" : "local";
        }
        ui.notify(`pi-sync: 正在克隆 ${repoUrl} …`, "info");
        const r = await performInit(ui, repoUrl, mode);
        if (!r.ok) {
          ui.notify(`pi-sync init 失败：${r.message}`, "error");
          return;
        }
        const result = await runSync(ui, { push: true, interactive: ctx.hasUI, materialize: true });
        const extra = result.changedLocal ? "；配置已就位，建议 /reload" : "";
        if (result.errors.length) ui.notify(`pi-sync init 完成但有警告：${result.errors.join("；")}`, "warning");
        else ui.notify(`pi-sync init 完成${extra}`, "info");
        return;
      }

      if (sub === "on" || sub === "off") {
        const liveP = liveSettingsPath();
        const live = (readJson(liveP) ?? {}) as Side;
        const sync = ((live.sync as Side | undefined) ?? {}) as Side;
        sync.enabled = sub === "on";
        if (sub === "on") sync.autoSync = true;
        live.sync = sync;
        writeJson(liveP, live);
        ui.notify(`pi-sync 已${sub === "on" ? "开启（含自动同步）" : "关闭自动同步"}`, "info");
        return;
      }

      if (sub === "status") {
        if (!cfg.repo) {
          ui.notify("pi-sync 未初始化，运行 /sync init", "warning");
          return;
        }
        ui.notify(await statusText(cfg), "info");
        return;
      }

      if (sub === "push" || sub === "pull" || sub === "" || sub === undefined) {
        if (!cfg.repo) {
          ui.notify("pi-sync 未初始化，运行 /sync init", "warning");
          return;
        }
        const push = sub !== "pull";
        const result = await runSync(ui, { push, interactive: ctx.hasUI, materialize: true });
        if (result.errors.length) {
          ui.notify(`pi-sync 完成但有错误：${result.errors.join("；")}`, "error");
          return;
        }
        const parts: string[] = [];
        if (result.notes.length) parts.push(result.notes.slice(0, 8).join("；"));
        if (result.conflictsResolved) parts.push(`解决了 ${result.conflictsResolved} 项冲突`);
        if (result.conflictsPending) parts.push(`${result.conflictsPending} 项冲突仍挂起`);
        if (push) parts.push(result.pushed ? "已推送" : "未推送");
        if (result.changedLocal) parts.push("配置已更新，/reload 后生效");
        ui.notify(parts.length ? `pi-sync：${parts.join("；")}` : "pi-sync：已是最新", "info");
        return;
      }

      ui.notify("用法: /sync [push|pull|status|on|off] 或 /sync init [repo] [--mode=remote|local]", "warning");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.autoSync || !cfg.repo) return;
    const ui: UiLike | null = ctx.hasUI ? ctx.ui : null;
    // 后台执行，不阻塞启动
    void autoRun(ui, "启动同步", true);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return;
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.autoSync || !cfg.repo) return;
    if (!fs.existsSync(path.join(workDir(), ".git"))) return;
    const ui: UiLike | null = ctx.hasUI ? ctx.ui : null;
    await Promise.race([autoRun(ui, "退出同步", true), new Promise((r) => setTimeout(r, 20_000))]);
  });
}
