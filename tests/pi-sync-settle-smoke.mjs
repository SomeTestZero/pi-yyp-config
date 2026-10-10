// 冒烟测试：packages「已就绪才落盘」策略（pi 启动崩溃修复）
// 运行：node --experimental-strip-types tests/pi-sync-settle-smoke.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sync-settle-"));
process.env.PI_SYNC_HOME = home;
const agent = path.join(home, "agent");
fs.mkdirSync(path.join(agent, "git", "github.com", "SomeTestZero", "alpha"), { recursive: true });
fs.mkdirSync(path.join(agent, "npm", "node_modules", "foo"), { recursive: true });
fs.mkdirSync(path.join(agent, "npm", "node_modules", "bar"), { recursive: true });
fs.writeFileSync(
  path.join(agent, "npm", "node_modules", "foo", "package.json"),
  JSON.stringify({ name: "foo", version: "1.4.2" }),
);
fs.writeFileSync(
  path.join(agent, "npm", "node_modules", "bar", "package.json"),
  JSON.stringify({ name: "bar", version: "1.0.0" }),
);

const m = await import(pathToFileURL(path.join(import.meta.dirname, "..", "extensions", "pi-sync.ts")).href);

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
};

console.log("versionSatisfiesLoose:");
ok(m.versionSatisfiesLoose("1.4.2", "1.4.2"), "精确版本相等 → 满足");
ok(!m.versionSatisfiesLoose("1.4.1", "1.4.2"), "精确版本不等 → 不满足");
ok(m.versionSatisfiesLoose("1.4.2", "^1.2.0"), "^ 同主版本且不低于 → 满足");
ok(!m.versionSatisfiesLoose("0.9.0", "^1.2.0"), "^ 主版本不同 → 不满足");
ok(!m.versionSatisfiesLoose("1.1.0", "^1.2.0"), "^ 同主版本但过低 → 不满足");
ok(m.versionSatisfiesLoose("1.2.5", "~1.2.0"), "~ 同主次版本且不低于 → 满足");
ok(!m.versionSatisfiesLoose("1.3.0", "~1.2.0"), "~ 主次版本不同 → 不满足");
ok(m.versionSatisfiesLoose("2.0.0", ">=1 <3"), "复杂范围宽松兜底 → 满足（避免反复重装）");
ok(m.versionSatisfiesLoose("1.4.2", ""), "无版本声明 → 满足");

console.log("parseNpmSource:");
ok(m.parseNpmSource("npm:foo@^1.2").name === "foo" && m.parseNpmSource("npm:foo@^1.2").range === "^1.2", "普通包名+范围");
ok(m.parseNpmSource("npm:@s/n@1.2.3").name === "@s/n" && m.parseNpmSource("npm:@s/n@1.2.3").range === "1.2.3", "scoped 包名+范围");
ok(m.parseNpmSource("npm:foo").range === null, "无范围 → null");

console.log("settlePackages（装好的留下，没装好的进 wanted）:");
const desired = [
  "git:github.com/SomeTestZero/alpha", // 克隆目录存在 → 落盘
  "git:github.com/SomeTestZero/missing", // 没克隆 → wanted
  "npm:foo@^1.0.0", // 1.4.2 满足 → 落盘
  "npm:bar@^2.0.0", // 1.0.0 不满足 → wanted（旧条目顶着）
];
fs.writeFileSync(
  path.join(agent, "settings.json"),
  JSON.stringify({ packages: ["npm:bar@^1.0.0"] }),
);
const s = m.settlePackages(desired);
const settledSrcs = s.settled.map(m.entrySource);
ok(settledSrcs.includes("git:github.com/SomeTestZero/alpha"), "已克隆的 git 包落盘");
ok(!settledSrcs.includes("git:github.com/SomeTestZero/missing"), "未克隆的 git 包不落盘（pi 启动不会去 clone）");
ok(settledSrcs.includes("npm:foo@^1.0.0"), "版本满足的 npm 包落盘");
ok(settledSrcs.includes("npm:bar@^1.0.0"), "版本未更新的 npm 包用旧条目顶着");
ok(!settledSrcs.includes("npm:bar@^2.0.0"), "未更新的新条目不落盘");
ok(s.wanted.has(m.packageId("git:github.com/SomeTestZero/missing")), "未克隆的包进 wanted");
ok(s.wanted.has(m.packageId("npm:bar@^2.0.0")), "未更新的包进 wanted");
ok(s.wanted.size === 2, "wanted 共 2 项");

console.log("settlePackages（用户删包后的墓碑语义不受影响）:");
// 目标里没有 alpha 时，settled 里也不应有（删除正常传播）
const s2 = m.settlePackages(desired.filter((e) => m.entrySource(e) !== "git:github.com/SomeTestZero/alpha"));
ok(!s2.settled.map(m.entrySource).includes("git:github.com/SomeTestZero/alpha"), "目标清单移除后不落盘（phase1 可正常墓碑）");

console.log("isSettled:");
ok(m.isSettled("git:github.com/SomeTestZero/alpha") === true, "已克隆 → settled");
ok(m.isSettled("git:github.com/SomeTestZero/missing") === false, "未克隆 → 不 settled");
ok(m.isSettled("npm:foo") === true, "已装且版本可读 → settled");
ok(m.isSettled("npm:nope") === false, "未装 → 不 settled");

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${n} 个断言全部通过`);
