// pi-sync 端到端测试：本地 bare 仓库模拟远端，三个 PI_SYNC_HOME 模拟三台机器。
// 运行：node tests/pi-sync-e2e.mjs
// 依赖 pi 自带的 jiti（用于加载 TS 扩展）；可用 PI_CODING_AGENT_DIR 覆盖 pi 安装目录。
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const piDir =
  process.env.PI_CODING_AGENT_DIR ??
  path.join(process.env.APPDATA ?? "", "npm/node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(import.meta.url);
const jitiPath = require.resolve("jiti", { paths: [piDir] });
const { createJiti } = await import(pathToFileURL(jitiPath).href);

const ROOT = process.env.PI_SYNC_TEST_ROOT ?? path.join(os.tmpdir(), "pi-sync-e2e");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const REMOTE = path.join(ROOT, "remote.git").replace(/\\/g, "/");

const g = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

// --- 准备远端（模拟脚本时代的仓库：只有 settings 备份，无 sync-state） ---
g(["init", "--bare", REMOTE]);
const seed = path.join(ROOT, "seed");
g(["clone", REMOTE, seed], ROOT);
g(["checkout", "-B", "main"], seed);
fs.mkdirSync(path.join(seed, "config/pi/agent"), { recursive: true });
fs.writeFileSync(path.join(seed, "config/pi/agent/settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:aaa"] }, null, 2));
g(["add", "-A"], seed);
g(["-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-m", "seed"], seed);
g(["push", "origin", "HEAD:main"], seed);
g(["--git-dir", REMOTE, "symbolic-ref", "HEAD", "refs/heads/main"], ROOT);

const jiti = createJiti(import.meta.url);
const extPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../extensions/pi-sync.ts");
const M = await jiti.import(pathToFileURL(extPath).href);

let passCount = 0, failCount = 0;
function assert(cond, label) {
  if (cond) { passCount++; console.log("  ✓", label); }
  else { failCount++; console.log("  ✗ FAIL:", label); }
}
function useHome(name) {
  process.env.PI_SYNC_HOME = path.join(ROOT, name, ".pi");
  delete process.env.PI_SYNC_WORK;
}
const agentDir = () => path.join(process.env.PI_SYNC_HOME, "agent");
const liveSettingsP = () => path.join(agentDir(), "settings.json");
const writeLive = (obj) => { fs.mkdirSync(agentDir(), { recursive: true }); fs.writeFileSync(liveSettingsP(), JSON.stringify(obj, null, 2)); };
const readLive = () => JSON.parse(fs.readFileSync(liveSettingsP(), "utf8"));
const writeExt = (rel, content) => { const p = path.join(agentDir(), "extensions", rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const readExt = (rel) => { const p = path.join(agentDir(), "extensions", rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; };
const remoteJson = (rel) => JSON.parse(g(["--git-dir", REMOTE, "show", `main:${rel}`], ROOT));
const mkUi = (chooser) => ({ select: async (t, opts) => chooser(t, opts), notify: () => {}, input: async () => undefined });

// ============================================================
console.log("S1: 机器A init(local) + 首次同步");
useHome("A");
writeLive({ theme: "light", a: 1, packages: ["npm:aaa", "npm:bbb"], httpProxy: "http://127.0.0.1:7890" });
writeExt("foo.ts", "foo-v1");
let r = await M.performInit(null, REMOTE, "local");
assert(r.ok, "A init ok");
r = await M.runSync(null, { push: true, interactive: false, materialize: false });
assert(r.ok, "A sync ok: " + r.errors.join(","));
let rs = remoteJson("config/pi/agent/settings.json");
assert(rs.theme === "light" && rs.a === 1, "远端采用 A 的配置值");
assert(JSON.stringify(rs.packages) === JSON.stringify(["npm:aaa", "npm:bbb"]), "packages 并集（seed 的 aaa + A 的 bbb）");
assert(!("httpProxy" in rs) && !("sync" in rs), "排除键（httpProxy/sync）不入库");
const st = remoteJson("config/sync-state.json");
assert(st.settings && st.settings.theme && st.settings.theme.ts > 0, "sync-state 记录键时间戳");
assert(g(["--git-dir", REMOTE, "show", "main:config/pi/agent/extensions/foo.ts"], ROOT) === "foo-v1", "扩展文件入库");

// ============================================================
console.log("S2: 机器B init(remote) 接入，然后各自改动并推送");
useHome("B");
writeLive({ b: 2, theme: "blue", packages: ["npm:ccc"] });
r = await M.performInit(null, REMOTE, "remote");
assert(r.ok, "B init ok");
let lb = readLive();
assert(lb.theme === "light" && lb.a === 1 && !("b" in lb), "B 采用远端配置（本机旧值被替换）");
assert(lb.sync && lb.sync.repo === REMOTE, "B 写入了本机 sync 配置");
assert(JSON.stringify(lb.packages) === JSON.stringify(["npm:aaa", "npm:bbb"]), "B 得到 packages 全量");
assert(readExt("foo.ts") === "foo-v1", "B 得到扩展文件");
// B 做修改：删 aaa、加 ccc、改 theme、加 bar.ts、改 foo.ts
lb.b = 2; lb.theme = "blue"; lb.packages = ["npm:bbb", "npm:ccc"];
writeLive(lb);
writeExt("bar.ts", "bar-v1");
writeExt("foo.ts", "foo-b");
r = await M.runSync(null, { push: true, interactive: false, materialize: false });
assert(r.ok, "B sync ok: " + r.errors.join(","));
rs = remoteJson("config/pi/agent/settings.json");
assert(rs.theme === "blue" && rs.b === 2 && rs.a === 1, "远端合并 B 的改动且保留 a");
assert(JSON.stringify(rs.packages) === JSON.stringify(["npm:bbb", "npm:ccc"]), "aaa 被墓碑删除、ccc 加入");
const st2 = remoteJson("config/sync-state.json");
assert(st2.tombstones.some((t) => t.type === "package" && t.id === "npm:aaa"), "墓碑记录 npm:aaa");

// ============================================================
console.log("S3: 机器A 拉取 B 的改动");
useHome("A");
r = await M.runSync(null, { push: false, interactive: false, materialize: false });
assert(r.ok, "A pull ok: " + r.errors.join(","));
let la = readLive();
assert(la.theme === "blue" && la.b === 2 && la.a === 1, "A 得到 B 的 theme/b");
assert(JSON.stringify(la.packages) === JSON.stringify(["npm:bbb", "npm:ccc"]), "A 的 aaa 被移除、ccc 加入");
assert(la.httpProxy === "http://127.0.0.1:7890", "A 的排除键 httpProxy 原样保留");
assert(readExt("bar.ts") === "bar-v1", "A 得到 bar.ts");
assert(readExt("foo.ts") === "foo-b", "A 的 foo.ts 更新");

// ============================================================
console.log("S4: 冲突——交互选远端 / 自动挂起 / 交互选本机");
useHome("A"); la = readLive(); la.theme = "red"; writeLive(la);
await M.runSync(null, { push: true, interactive: false, materialize: false });
useHome("B"); lb = readLive(); lb.theme = "green"; writeLive(lb);
r = await M.runSync(mkUi((t, opts) => opts.find((o) => o.includes("远端"))), { push: true, interactive: true, materialize: false });
assert(r.ok && readLive().theme === "red", "B 冲突弹窗选远端 → theme=red");
useHome("A"); la = readLive(); la.theme = "orange"; writeLive(la);
await M.runSync(null, { push: true, interactive: false, materialize: false });
useHome("B"); lb = readLive(); lb.theme = "purple"; writeLive(lb);
r = await M.runSync(null, { push: true, interactive: false, materialize: false });
assert(readLive().theme === "purple", "自动模式冲突跳过：B 本机保留 purple");
assert(remoteJson("config/pi/agent/settings.json").theme === "orange", "远端保持 orange（未被强推覆盖）");
assert(fs.existsSync(path.join(agentDir(), "pi-sync-pending.json")), "挂起冲突已记录");
r = await M.runSync(mkUi((t, opts) => opts.find((o) => o.includes("本机"))), { push: true, interactive: true, materialize: false });
assert(r.conflictsResolved >= 1 && readLive().theme === "purple", "交互 /sync 解决挂起冲突 → purple");
useHome("A");
await M.runSync(null, { push: false, interactive: false, materialize: false });
assert(readLive().theme === "purple", "A 最终收敛到 purple");

// ============================================================
console.log("S5: 文件删除传播");
useHome("B");
fs.unlinkSync(path.join(agentDir(), "extensions", "bar.ts"));
await M.runSync(null, { push: true, interactive: false, materialize: false });
useHome("A");
await M.runSync(null, { push: false, interactive: false, materialize: false });
assert(readExt("bar.ts") === null, "A 的 bar.ts 随墓碑删除");
assert(readExt("foo.ts") === "foo-b", "A 的 foo.ts 保留");

// ============================================================
console.log("S6: 全新机器C init(remote) 拿到全量");
useHome("C");
writeLive({});
r = await M.performInit(null, REMOTE, "remote");
assert(r.ok, "C init ok");
r = await M.runSync(null, { push: true, interactive: false, materialize: false });
const lc = readLive();
assert(lc.theme === "purple" && lc.a === 1 && lc.b === 2, "C 得到 A∪B 全量配置");
assert(JSON.stringify(lc.packages) === JSON.stringify(["npm:bbb", "npm:ccc"]), "C 的 packages 正确");
assert(!("httpProxy" in lc), "排除键不传播到 C");
assert(readExt("foo.ts") === "foo-b" && readExt("bar.ts") === null, "C 的文件状态正确");

// ============================================================
console.log("S7: 纯函数——版本冲突 LWW / mergeStates");
{
  const state = { version: 1, machines: {}, settings: {}, packages: { "git:x/y": { ts: 100, machine: "m1" } }, files: {}, tombstones: [] };
  const out = M.mergePackageLists({
    base: ["git:x/y@v1"], local: ["git:x/y@v1"], remote: ["git:x/y@v2"],
    state, remoteMeta: { "git:x/y": { ts: 200, machine: "m2" } }, remoteTombstones: [], now: 300, machine: "m1", protectedId: null,
  });
  assert(JSON.stringify(out.list) === JSON.stringify(["git:x/y@v2"]), "同包不同版本：远端较新胜");
}
{
  const state = { version: 1, machines: {}, settings: {}, packages: { "npm:a": { ts: 100, machine: "m1" } }, files: {}, tombstones: [] };
  const out = M.mergePackageLists({
    base: ["npm:a"], local: ["npm:a"], remote: [],
    state, remoteMeta: {}, remoteTombstones: [{ type: "package", id: "npm:a", ts: 200, machine: "m2" }], now: 300, machine: "m1", protectedId: null,
  });
  assert(out.list.length === 0, "远端删除+本机未改 → 删除生效");
}
{
  const s1 = { version: 1, machines: { a: { lastSeen: "2020" } }, settings: { k: { ts: 5, machine: "a" } }, packages: {}, files: {}, tombstones: [{ type: "setting", id: "x", ts: 1, machine: "a" }] };
  const s2 = { version: 1, machines: { b: { lastSeen: "2021" } }, settings: { k: { ts: 9, machine: "b" } }, packages: {}, files: {}, tombstones: [{ type: "setting", id: "x", ts: 3, machine: "b" }] };
  const m = M.mergeStates(s1, s2);
  assert(m.settings.k.ts === 9 && m.tombstones[0].ts === 3 && Object.keys(m.machines).length === 2, "mergeStates 取最大值/并集");
}

console.log(`\n结果: ${passCount} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
