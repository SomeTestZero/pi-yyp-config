#!/usr/bin/env node
/**
 * 离线回归：真实扩展加载 + 假 WorkBuddy 流 + 两个并行子进程 + resume。
 * 运行：node --experimental-strip-types scripts/test-wb-credits.mjs
 * 需要本机 Pi 的 node_modules，不访问网络、不读取或修改真实凭证。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, "../extensions/workbuddy.ts");
// 扩展由宿主 Pi 提供依赖；独立跑测试时显式解析同一个全局安装，不另装副本。
const piEntry = process.env.PI_MODULE ?? "C:/Users/yyp/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const require = createRequire(piEntry);
const { createAgentSessionFromServices, createAgentSessionServices, getPackageDir, SessionManager } =
	await import(pathToFileURL(piEntry));
const piRoot = getPackageDir();
const jiti = createRequire(piEntry)("jiti")(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": piEntry,
		"@earendil-works/pi-ai/compat": path.join(piRoot, "dist/core/extensions/pi-ai-extension-view.js"),
	},
});
const { CreditLedger, creditDelta, readCreditLedger } = jiti(extensionPath);

const creditByScenario = { main: 0.12, "child-a": 0.23, "child-b": 0.34, resumed: 0.47 };
const scenario = process.argv[2] ?? "main";
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-credit-${scenario}-`));
// 测试不需要解析包，但保留此目录使 ModelRegistry 知道 Git 包根的布局。
fs.mkdirSync(path.join(agentDir, "git"), { recursive: true });
let server;
const sessions = [];

try {
	const services = await createAgentSessionServices({
		cwd: process.cwd(), agentDir,
		resourceLoaderOptions: { additionalExtensionPaths: [extensionPath] },
	});
	assert.deepEqual(services.modelRuntime.getRegisteredProviderIds(), ["workbuddy-cn", "workbuddy-intl"]);
	assert.equal(creditDelta({ usage: { credit: 0.1 } }), 0.1);
	assert.equal(creditDelta({ usage: { credit: 0 } }), undefined);
	assert.equal(creditDelta({ usage: { credit: Number.NaN } }), undefined);

	const credit = creditByScenario[scenario];
	server = http.createServer((req, res) => {
		req.resume();
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: "kimi-k3.1-pro", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }], usage: { credit } })}\n\n` +
			`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: "kimi-k3.1-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, credit } })}\n\n` +
			"data: [DONE]\n\n",
		);
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const model = services.modelRuntime.getModel("workbuddy-cn", "kimi-k3.1-pro");
	model.baseUrl = `http://127.0.0.1:${server.address().port}/v2`;
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: SessionManager.create(process.cwd(), path.join(agentDir, "sessions")),
	});
	sessions.push(session);
	await session.bindExtensions({});
	const context = { messages: [{ role: "user", content: "offline test", timestamp: Date.now() }] };
	const result = await services.modelRuntime.getProvider("workbuddy-cn")
		.streamSimple(model, context, { apiKey: "offline-test" }).result();
	assert.equal(result.stopReason, "stop");
	await new Promise(resolve => setTimeout(resolve, 100));

	const totals = () => readCreditLedger(process.env.PI_WB_CREDITS_DIR);
	console.log(JSON.stringify({ scenario, ledger: process.env.PI_WB_CREDITS_DIR, totals: totals() }));
	if (scenario === "main") {
		const runChild = childScenario => new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), childScenario], {
				env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"],
			});
			child.stdout.on("data", data => process.stdout.write(data));
			child.on("error", reject);
			child.on("close", code => code === 0 ? resolve() : reject(new Error(`${childScenario} exited ${code}`)));
		});
		await Promise.all([runChild("child-a"), runChild("child-b")]);
		assert.ok(Math.abs(totals()["workbuddy-cn"] - 0.69) < 1e-9);
		await runChild("resumed");
		assert.ok(Math.abs(totals()["workbuddy-cn"] - 1.16) < 1e-9);
		assert.equal(totals()["workbuddy-intl"], undefined);
		assert.equal(fs.readdirSync(process.env.PI_WB_CREDITS_DIR).filter(file => file.endsWith(".json")).length, 4);
		assert.ok(fs.readdirSync(process.env.PI_WB_CREDITS_DIR).every(file => !file.endsWith(".tmp")));

		// 主会话 reload 沿用同一账本；子 resume 继承父账本，不会重放历史消耗。
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
		assert.ok(Math.abs(totals()["workbuddy-cn"] - 1.16) < 1e-9);
		const parent = new CreditLedger(path.join(agentDir, "sessions", "main.jsonl"), process.cwd(), agentDir);
		const child = new CreditLedger(path.join(agentDir, "sessions", "child.jsonl"), process.cwd(), agentDir, parent.dir);
		assert.equal(child.dir, parent.dir);
		parent.add("workbuddy-intl", 0.25);
		await Promise.all([parent.close(), child.close()]);
		assert.equal(readCreditLedger(parent.dir)["workbuddy-intl"], 0.25);
		console.log("PASS: main + 2 parallel children + resume = 1.16 CN; usage/reload no double count; Intl separate");
	}
} finally {
	for (const session of sessions) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	if (server) await new Promise(resolve => server.close(resolve));
	fs.rmSync(agentDir, { recursive: true, force: true });
}
