#!/usr/bin/env node
/**
 * pi-sync 的独立 CLI / 安装器。
 *
 * sync：在真正的 `pi update --extensions` 前调用，完整同步配置与包源码。
 * install：在 ~/.pi/agent/bin 安装薄包装，配置 shell/PowerShell 命令优先级。
 *
 * 包装不修改 pi 安装目录；真实入口与同步核心位置保存在本机 JSON 中。
 *
 * 2026-11-17 修复：pi 的托管安装自己会在 ~/.pi/agent/bin/pi 放一个「跟随
 * current-version」的启动器，并把 ~/.local/bin/pi 软链到它。旧版安装器直接
 * 覆盖那个启动器，又从 `which -a pi` 里选中软链回包装的 ~/.local/bin/pi 当
 * 真实 pi，于是包装 exec 自己 → 启动 pi 就是 100% CPU 的死循环。
 * 现在 install 会：
 *   1. 先备份 pi 自己的启动器为 ~/.pi/agent/bin/pi.pi-real（不销毁原入口）；
 *   2. 按 realpath 排除「包装自身」与「指向包装的软链」后再挑候选；
 *   3. 用 node>=22 跑的 `--version` 冒烟测试确认候选真能启动才写包装；
 *   4. 包装内置自递归保护和「备份启动器 / 最新 release / 最新 release 目录」回退。
 * sync 前还会把 https://github.com/... 的插件远端统一改成 git@github.com:...。
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER_MARKER = "# pi-yyp-config: full sync before the exact extension-update command.";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const home = homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
const binDir = join(agentDir, "bin");
const wrapperPath = join(binDir, "pi");
const launcherBackupPath = join(binDir, "pi.pi-real");
const configPath = join(binDir, "pi-update-sync.json");

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options });
    child.on("error", (error) => {
      console.error(`pi-sync: 无法启动 ${command}: ${error.message}`);
      process.exitCode = 1;
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

/** https://github.com/<org>/<repo>(.git) → git@github.com:<org>/<repo>.git */
function toSshGithubUrl(url) {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return null;
  return `git@github.com:${match[1]}/${match[2]}.git`;
}

function gitIn(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", shell: false });
  return result.status === 0 ? result.stdout.trim() : null;
}

function walkDirs(root, depth, out = []) {
  if (depth < 0) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const full = join(root, entry.name);
    out.push(full);
    walkDirs(full, depth - 1, out);
  }
  return out;
}

/** 把已存在插件克隆里的 GitHub https 远端改成 SSH（pi update --extensions 直接用 origin 拉取）。 */
function normalizeGitRemotes() {
  if (process.env.PI_SYNC_SKIP_REMOTE_FIX === "1") return [];
  const gitRoot = join(agentDir, "git");
  if (!existsSync(gitRoot)) return [];
  const fixed = [];
  for (const dir of [gitRoot, ...walkDirs(gitRoot, 4)]) {
    if (!existsSync(join(dir, ".git"))) continue;
    const url = gitIn(dir, ["remote", "get-url", "origin"]);
    if (!url) continue;
    const ssh = toSshGithubUrl(url);
    if (!ssh) continue;
    const result = spawnSync("git", ["-C", dir, "remote", "set-url", "origin", ssh], { encoding: "utf8", shell: false });
    if (result.status === 0) fixed.push(`${dir.slice(gitRoot.length + 1)}: ${url} → ${ssh}`);
  }
  if (fixed.length > 0) {
    console.log(`pi-sync: 已把 ${fixed.length} 个插件的 git 远端改成 SSH`);
    for (const line of fixed) console.log(`  - ${line}`);
  }
  return fixed;
}

export async function runSync() {
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const modulePath = config.syncModule || join(packageDir, "extensions", "pi-sync.ts");
  if (!existsSync(modulePath)) throw new Error(`找不到同步核心：${modulePath}`);
  try {
    normalizeGitRemotes();
  } catch (error) {
    console.error(`pi-sync: 远端地址修正跳过：${error instanceof Error ? error.message : String(error)}`);
  }
  return run(process.execPath, ["--disable-warning=ExperimentalWarning", modulePath, "--run"], {
    env: { ...process.env, PI_SYNC_CLI: "1" },
  });
}

function whichAll(command, env = process.env) {
  const result = spawnSync("which", ["-a", command], { encoding: "utf8", env, shell: false });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACL 不用 POSIX mode */ }
}

function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readTextSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isOurWrapper(path) {
  const text = readTextSafe(path);
  return typeof text === "string" && text.includes(WRAPPER_MARKER);
}

function isRunnableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function versionParts(value) {
  return String(value).replace(/^v/, "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionsDesc(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function nodeMajor(binary) {
  const result = spawnSync(binary, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8", shell: false, timeout: 20_000 });
  if (result.status !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

/** 找一个 >=22 的 node，用于冒烟测试（pi 的 shebang 依赖 PATH 里的 node）。 */
function pickNodeBin() {
  const candidates = [process.execPath];
  const nvmRoot = join(home, ".nvm", "versions", "node");
  for (const version of listDirs(nvmRoot).sort(compareVersionsDesc)) candidates.push(join(nvmRoot, version, "bin", "node"));
  candidates.push(join(home, ".local", "share", "pi-node", "current", "bin", "node"));
  for (const hit of whichAll("node")) candidates.push(hit);
  candidates.push("/usr/local/bin/node", "/usr/bin/node");
  const best = [];
  for (const candidate of candidates) {
    if (!candidate || !isRunnableFile(candidate)) continue;
    const major = nodeMajor(candidate);
    if (major >= 22) best.push({ candidate, major });
  }
  if (best.length === 0) return null;
  best.sort((a, b) => b.major - a.major);
  return best[0].candidate;
}

function smokeTest(candidate, nodeBin) {
  const env = { ...process.env };
  if (nodeBin) env.PATH = `${dirname(nodeBin)}:${env.PATH ?? ""}`;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", env, shell: false, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = (result.stdout ?? "").trim();
  if (result.status === 0 && /\d+\.\d+/.test(stdout)) return { ok: true, version: stdout.split(/\r?\n/).at(-1) };
  const reason = result.error?.message || (result.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) || `exit ${result.status ?? "?"}`;
  return { ok: false, reason };
}

function managedReleaseCandidates() {
  const releasesRoot = join(agentDir, "install", "releases");
  const out = [];
  const current = (readTextSafe(join(agentDir, "install", "current-version")) ?? "").trim();
  if (current) out.push(join(releasesRoot, current, "node_modules", ".bin", "pi"));
  for (const version of listDirs(releasesRoot).sort(compareVersionsDesc)) {
    out.push(join(releasesRoot, version, "node_modules", ".bin", "pi"));
  }
  return out;
}

function npmGlobalCandidates() {
  const result = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: false });
  const prefix = (result.stdout ?? "").trim();
  return prefix ? [join(prefix, "bin", "pi")] : [];
}

/**
 * 找真正的 pi，并保证它真的能启动。
 * 明确排除：包装文件本身、~/.pi/agent/bin 下的其他文件、以及 realpath 指回包装的软链。
 */
function discoverRealPi() {
  const selfPaths = new Set([resolve(wrapperPath), realpathSafe(wrapperPath)].filter(Boolean));
  const ordered = [];
  const push = (candidate) => {
    if (candidate && typeof candidate === "string" && !ordered.includes(candidate)) ordered.push(candidate);
  };
  push(process.env.PI_SYNC_REAL_PI);
  push(launcherBackupPath);
  for (const hit of whichAll("pi")) push(hit);
  for (const candidate of managedReleaseCandidates()) push(candidate);
  for (const candidate of npmGlobalCandidates()) push(candidate);

  const nodeBin = pickNodeBin();
  const rejected = [];
  for (const candidate of ordered) {
    if (!candidate) continue;
    const absolute = resolve(candidate);
    const real = realpathSafe(absolute);
    const isBackup = absolute === resolve(launcherBackupPath);
    if (!isBackup) {
      if (selfPaths.has(absolute) || (real && selfPaths.has(real))) {
        rejected.push(`${candidate}（指向包装自身）`);
        continue;
      }
      if (dirname(absolute) === resolve(binDir)) {
        rejected.push(`${candidate}（在包装目录内）`);
        continue;
      }
    }
    if (!isRunnableFile(absolute)) {
      rejected.push(`${candidate}（不可执行或不存在）`);
      continue;
    }
    const smoke = smokeTest(absolute, nodeBin);
    if (smoke.ok) return { realPi: absolute, version: smoke.version, rejected };
    rejected.push(`${candidate}（--version 失败：${smoke.reason}）`);
  }
  const detail = rejected.length > 0 ? `\n尝试过的候选：\n  - ${rejected.join("\n  - ")}` : "";
  throw new Error(`找不到能启动的真正 pi；请确认 \`pi --version\` 可用后重试。${detail}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** 登录 shell 里 `command -v pi` 的实际解析结果（取最后一行非空输出）。 */
function probePi(shellBin) {
  const result = spawnSync(shellBin, ["-ilc", "command -v pi"], { encoding: "utf8", shell: false, timeout: 30_000 });
  const lines = (result.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * 让包装真正拦截到 `pi`：PATH 里包装必须排在真实 pi 前面，否则 pi update --extensions
 * 会绕过包装直接跑真实 pi，配置永远不落地（txy 2026-11-18 实测坑）。
 * 1) 建 ~/.local/bin/pi 软链（Ubuntu 等默认 PATH 已把 ~/.local/bin 排最前）；
 * 2) 登录 shell 仍解析不到包装时，向其 rc 追加带标记的 PATH 块（幂等，同 Windows profile 做法）。
 */
function ensureWrapperPriority() {
  const localLink = join(home, ".local", "bin", "pi");
  try {
    mkdirSync(dirname(localLink), { recursive: true });
    let st = null;
    try { st = lstatSync(localLink); } catch {}
    if (!st || st.isSymbolicLink()) {
      if (st) unlinkSync(localLink);
      symlinkSync(wrapperPath, localLink);
      console.log(`已创建软链 ${localLink} → ${wrapperPath}`);
    } else {
      console.log(`pi-sync: ${localLink} 是普通文件，未覆盖；如需包装优先请手动处理`);
    }
  } catch (error) {
    console.log(`pi-sync: 创建 ${localLink} 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const wrapperReal = realpathSafe(wrapperPath);
  const shellName = (process.env.SHELL ?? "").split("/").pop() || "bash";
  const shellBin = whichAll(shellName)[0] ?? whichAll("bash")[0];
  if (!shellBin) {
    console.log("请确保 ~/.pi/agent/bin（或指向它的 ~/.local/bin/pi）位于 PATH 最前面，否则 pi update --extensions 不会触发同步。");
    return;
  }
  const resolved = probePi(shellBin);
  if (resolved.startsWith("/") && realpathSafe(resolved) === wrapperReal) {
    console.log(`自检通过：登录 shell 的 pi → ${resolved}`);
    return;
  }
  const rcPath = join(home, shellName === "zsh" ? ".zshrc" : ".bashrc");
  const start = "# >>> pi-yyp-config update sync >>>";
  const end = "# <<< pi-yyp-config update sync <<<";
  const block = `${start}\nexport PATH="${binDir}:$PATH"\n${end}`;
  try {
    const existing = readTextSafe(rcPath) ?? "";
    const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`);
    writeFileSync(rcPath, pattern.test(existing) ? existing.replace(pattern, `${block}\n`) : `${existing.trimEnd()}\n\n${block}\n`);
    console.log(`已把包装目录写入 ${rcPath} 的 PATH 最前`);
  } catch (error) {
    console.log(`pi-sync: 写 ${rcPath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const after = probePi(shellBin);
  if (after.startsWith("/") && realpathSafe(after) === wrapperReal) {
    console.log(`自检通过：登录 shell 的 pi → ${after}（新开 shell 生效）`);
  } else {
    console.log(`警告：登录 shell 的 pi 仍解析为 ${after || "（无）"}；请手动确保 ${binDir} 位于 PATH 最前面，否则 pi update --extensions 不会触发同步。`);
  }
}

function installPosix(_corePath) {
  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const packageSource = settings.packages?.find((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && source.toLowerCase().includes("pi-yyp-config");
  });
  if (typeof packageSource !== "string") throw new Error("settings.json 未声明 pi-yyp-config 包");
  const installedDir = resolve(packageDir);
  const candidates = [
    installedDir,
    join(agentDir, "git", "github.com", "SomeTestZero", "pi-yyp-config"),
    join(agentDir, "git", "github.com", "SomeTestZero", "pi-yyp-config.git"),
  ];
  const actualPackage = candidates.find((dir) => existsSync(join(dir, "extensions", "pi-sync.ts")));
  if (!actualPackage) throw new Error("找不到配置包的 pi-sync.ts，请先安装配置包");
  const modulePath = join(actualPackage, "extensions", "pi-sync.ts");

  // pi 托管安装的启动器（跟随 current-version）先备份：不要销毁系统里唯一的真实入口。
  if (existsSync(wrapperPath) && !isOurWrapper(wrapperPath)) {
    try {
      copyFileSync(wrapperPath, launcherBackupPath);
      chmodSync(launcherBackupPath, 0o755);
      console.log(`已备份 pi 自己的启动器：${wrapperPath} → ${launcherBackupPath}`);
    } catch (error) {
      throw new Error(`备份 ${wrapperPath} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { realPi, version, rejected } = discoverRealPi();
  for (const line of rejected) console.log(`pi-sync: 跳过候选 ${line}`);
  writePrivateJson(configPath, { version: 2, realPi, syncModule: modulePath, launcherBackup: launcherBackupPath });

  const syncNode = JSON.stringify(process.execPath);
  const syncScript = JSON.stringify(join(scriptDir, "pi-sync-cli.mjs"));
  const releasesGlob = JSON.stringify(join(agentDir, "install", "releases"));
  const wrapper = `#!/bin/sh
${WRAPPER_MARKER}
# 真实 pi 记录在 ${configPath}；本文件由 /sync install-update 生成，可重复执行。
pi_sync_real=${shellQuote(realPi)}
pi_sync_backup=${shellQuote(launcherBackupPath)}
pi_sync_node=${syncNode}
pi_sync_script=${syncScript}

if [ "$1" = "update" ] && [ "$2" = "--extensions" ] && [ "$#" -eq 2 ]; then
  if [ -x "$pi_sync_node" ]; then
    "$pi_sync_node" "$pi_sync_script" sync || exit $?
  else
    printf 'pi-yyp-config: 跳过同步（找不到 %s），继续更新扩展\\n' "$pi_sync_node" >&2
  fi
fi

# 自递归保护：绝不允许 exec 回自己（否则 CPU 100% 死循环）。
pi_sync_self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
pi_sync_target=$(readlink -f "$pi_sync_real" 2>/dev/null || printf '%s' "$pi_sync_real")
if [ -n "$pi_sync_self" ] && [ "$pi_sync_self" = "$pi_sync_target" ]; then
  printf 'pi-yyp-config: %s 的入口指向自身，已中止；请重新执行 /sync install-update\\n' "$0" >&2
  exit 127
fi

if [ ! -x "$pi_sync_real" ]; then
  pi_sync_real=$pi_sync_backup
fi
if [ ! -x "$pi_sync_real" ]; then
  pi_sync_latest=$(ls -1d ${releasesGlob}/*/ 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$pi_sync_latest" ] && [ -x "\${pi_sync_latest}node_modules/.bin/pi" ]; then
    pi_sync_real="\${pi_sync_latest}node_modules/.bin/pi"
  fi
fi
if [ ! -x "$pi_sync_real" ]; then
  printf 'pi-yyp-config: 找不到真正的 pi（记录值：%s）；请重新执行 /sync install-update\\n' "$pi_sync_real" >&2
  exit 127
fi
exec "$pi_sync_real" "$@"
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  console.log(`已安装 Linux/macOS 更新入口：${wrapperPath}`);
  console.log(`真实 pi：${realPi}${version ? `（${version}）` : ""}`);
  ensureWrapperPriority();
  console.log("新开 shell 后执行 pi update --extensions 即可完整同步。");
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function installWindows(corePath) {
  const npmRoot = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: false }).stdout.trim();
  if (!npmRoot) throw new Error("无法确定 npm 全局目录");
  const realCmd = join(npmRoot, "pi.cmd");
  if (!existsSync(realCmd)) throw new Error(`找不到真实 pi：${realCmd}`);
  const modulePath = join(packageDir, "extensions", "pi-sync.ts");
  writePrivateJson(configPath, { version: 2, realPi: realCmd, syncModule: modulePath });

  const profileResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Write-Output $PROFILE"], {
    encoding: "utf8",
    shell: false,
  });
  const profilePath = profileResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!profilePath) throw new Error("无法确定 PowerShell profile");
  const start = "# >>> pi-yyp-config update sync >>>";
  const end = "# <<< pi-yyp-config update sync <<<";
  const functionBlock = `${start}
function pi {
    if ($args.Count -eq 2 -and $args[0] -eq 'update' -and $args[1] -eq '--extensions') {
        & ${psQuote(process.execPath)} ${psQuote(corePath)} sync
        if ($LASTEXITCODE -ne 0) { return }
    }
    & ${psQuote(realCmd)} @args
}
${end}`;
  mkdirSync(dirname(profilePath), { recursive: true });
  const existing = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  const pattern = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`);
  writeFileSync(profilePath, pattern.test(existing) ? existing.replace(pattern, `${functionBlock}\n`) : `${existing.trimEnd()}\n\n${functionBlock}\n`);
  console.log(`已安装 PowerShell 更新入口：${profilePath}`);
  console.log(`真实 pi：${realCmd}`);
  console.log("新开 PowerShell 后执行 pi update --extensions 即可完整同步。");
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "sync") {
    if (args.length) throw new Error("sync 不接受额外参数");
    process.exitCode = await runSync();
  } else if (command === "install") {
    if (args.length) throw new Error("install 不接受额外参数");
    if (process.platform === "win32") await installWindows(fileURLToPath(import.meta.url));
    else installPosix(fileURLToPath(import.meta.url));
  } else if (command === "fix-remotes") {
    if (args.length) throw new Error("fix-remotes 不接受额外参数");
    normalizeGitRemotes();
  } else {
    console.log("用法: node scripts/pi-sync-cli.mjs <sync|install|fix-remotes>");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`pi-sync: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
