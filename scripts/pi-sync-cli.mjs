#!/usr/bin/env node
/**
 * pi-sync 的独立 CLI / 安装器。
 *
 * sync：在真正的 `pi update --extensions` 前调用，完整同步配置与包源码。
 * install：在 ~/.pi/agent/bin 安装薄包装，配置 shell/PowerShell 命令优先级。
 *
 * 包装不修改 pi 安装目录；真实入口与同步核心位置保存在本机 JSON 中。
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const home = homedir();
const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
const binDir = join(agentDir, "bin");
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

export async function runSync() {
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const modulePath = config.syncModule || join(packageDir, "extensions", "pi-sync.ts");
  if (!existsSync(modulePath)) throw new Error(`找不到同步核心：${modulePath}`);
  return run(process.execPath, ["--disable-warning=ExperimentalWarning", modulePath, "--run"], {
    env: { ...process.env, PI_SYNC_CLI: "1" },
  });
}

function whichAll(command, env = process.env) {
  const result = spawnSync("which", ["-a", command], { encoding: "utf8", env });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACL 不用 POSIX mode */ }
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
  const realPi = process.env.PI_SYNC_REAL_PI || whichAll("pi").find((candidate) => resolve(candidate) !== resolve(join(binDir, "pi")));
  if (!realPi) throw new Error("找不到真正的 pi；请先安装 @earendil-works/pi-coding-agent");

  writePrivateJson(configPath, { version: 1, realPi, syncModule: modulePath });
  const wrapper = `#!/bin/sh
# pi-yyp-config: full sync before the exact extension-update command.
if [ "$1" = "update" ] && [ "$2" = "--extensions" ] && [ "$#" -eq 2 ]; then
  "${process.execPath}" "${scriptDir}/pi-sync-cli.mjs" sync || exit $?
fi
exec "${realPi}" "$@"
`;
  const wrapperPath = join(binDir, "pi");
  writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  console.log(`已安装 Linux/macOS 更新入口：${wrapperPath}`);
  console.log(`真实 pi：${realPi}`);
  console.log("请确保 ~/.pi/agent/bin 位于 PATH 最前面；新开 shell 后执行 pi update --extensions 即可完整同步。");
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
  writePrivateJson(configPath, { version: 1, realPi: realCmd, syncModule: modulePath });

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
  } else {
    console.log("用法: node scripts/pi-sync-cli.mjs <sync|install>");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`pi-sync: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
