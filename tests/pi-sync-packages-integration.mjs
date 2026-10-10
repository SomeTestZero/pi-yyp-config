// 集成测试：packages 落盘策略 + phase1 墓碑语义（pi 启动崩溃修复）
// 场景：装失败/远端新增但未安装的包 —— 不写入 live settings、不被墓碑误删；
//      用户真正删除的包 —— 正常传播墓碑。
// 运行：node --experimental-strip-types tests/pi-sync-packages-integration.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-int-"));
const origin = path.join(T, "origin.git");
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8" });
sh("git", ["init", "--bare", "-b", "main", origin], T);

const mod = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-sync.ts")).href);

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
};

/** 建一台模拟机器：PI_SYNC_HOME / PI_SYNC_WORK 隔离 */
function machine(name) {
  const home = path.join(T, name);
  const agent = path.join(home, "agent");
  fs.mkdirSync(agent, { recursive: true });
  return {
    name,
    agent,
    work: path.join(T, `${name}-work`),
    settings() {
      return JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
    },
    writeSettings(s) {
      fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(s, null, 2));
    },
    treePkgs() {
      const p = path.join(this.work, "config", "pi", "agent", "settings.json");
      const t = JSON.parse(fs.readFileSync(p, "utf8"));
      return (t.packages ?? []).map((e) => mod.entrySource(e));
    },
    /** 伪装一个 git 包已安装（克隆目录存在） */
    fakeInstall(src) {
      const rel = src.replace(/^git:/, "").replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/^git@([^:]+):/, "$1/").replace(":", "/");
      fs.mkdirSync(path.join(agent, "git", rel), { recursive: true });
    },
    async sync(opts = {}) {
      process.env.PI_SYNC_HOME = home;
      process.env.PI_SYNC_WORK = this.work;
      return await mod.runSync(null, { push: true, interactive: false, materialize: false, ...opts });
    },
  };
}

const A = machine("machine-a");
const B = machine("machine-b");

const ALPHA = "git:example.com/org/alpha"; // A 已安装
const MISSING = "git:example.com/org/missing"; // 装不上（网络失败的等价物）
const BETA = "git:example.com/org/beta"; // B 新增、A 未安装

console.log("机器 A 首次同步：装好的落盘，没装好的进 wanted");
A.fakeInstall(ALPHA);
A.writeSettings({
  sync: { repo: origin, enabled: true, autoSync: false, machineId: "machine-a" },
  theme: "dark",
  packages: [ALPHA, MISSING],
});
const r1 = await A.sync();
assert.equal(r1.errors.length, 0, r1.errors.join(";"));
ok(A.settings().packages.every((e) => mod.entrySource(e) !== MISSING), "live settings 不含装不上的包（pi 启动不会去 clone → 不会崩）");
ok(A.settings().packages.some((e) => mod.entrySource(e) === ALPHA), "已安装的包保留在 live settings");
ok(A.treePkgs().includes(MISSING) && A.treePkgs().includes(ALPHA), "同步树保留完整期望清单（含装不上的）");
const wantedPath = path.join(A.agent, "pi-sync-wanted-packages.json");
ok(fs.existsSync(wantedPath), "生成待装清单");
ok(JSON.parse(fs.readFileSync(wantedPath, "utf8")).items.includes(mod.packageId(MISSING)), "待装清单记录装不上的包");

console.log("机器 B 新增一个包并推送（A 还没装它）");
B.fakeInstall(BETA);
B.writeSettings({
  sync: { repo: origin, enabled: true, autoSync: false, machineId: "machine-b" },
  packages: [ALPHA, MISSING, BETA],
});
const r2 = await B.sync();
assert.equal(r2.errors.length, 0, r2.errors.join(";"));

console.log("机器 A 拉取：远端新包同样不落盘、不误删");
await A.sync();
await A.sync(); // 再跑一轮：验证不会被 phase1 误判为「本机删除」
ok(A.treePkgs().includes(BETA), "远端新包进入同步树");
ok(A.treePkgs().includes(MISSING), "连续两轮同步后装不上的包仍在同步树（未被墓碑误删）");
ok(!A.settings().packages.some((e) => mod.entrySource(e) === BETA), "未安装的远端新包不写入 live settings");
ok(JSON.parse(fs.readFileSync(wantedPath, "utf8")).items.includes(mod.packageId(BETA)), "远端新包进入待装清单");

console.log("用户真实删除已安装的包：墓碑正常传播");
A.writeSettings({ ...A.settings(), packages: [MISSING] }); // 手动删掉 alpha
await A.sync();
ok(!A.treePkgs().includes(ALPHA), "用户删除的包被墓碑移出同步树");
ok(A.treePkgs().includes(MISSING) && A.treePkgs().includes(BETA), "待装的包不受删除传播影响");

console.log("远端删除：待装包也能收敛");
B.writeSettings({ ...B.settings(), packages: [ALPHA, MISSING] }); // B 删掉 beta
await B.sync();
await A.sync();
ok(!A.treePkgs().includes(BETA), "远端删除的待装包从同步树移除");
ok(!JSON.parse(fs.readFileSync(wantedPath, "utf8")).items.includes(mod.packageId(BETA)), "待装清单同步收敛");

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${n} 个断言全部通过`);
