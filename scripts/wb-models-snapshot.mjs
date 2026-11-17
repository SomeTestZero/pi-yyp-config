#!/usr/bin/env node
/**
 * 刷新 extensions/workbuddy.ts 里的 FALLBACK_MODELS（离线/未登录兜底目录）。
 *
 * 真机目录永远以上游 /v2/enterprises/personal/models 为准（扩展运行时 refreshModels 会拉）；
 * 这个快照只在没登录 / 拉取失败时用，所以要跟着上游一起更新。
 *
 * 用法：
 *   node scripts/wb-models-snapshot.mjs           # 原地改写 workbuddy.ts
 *   node scripts/wb-models-snapshot.mjs --diff    # 只打印差异，不改文件
 *
 * 依赖 ~/.pi/agent/auth.json 里的 workbuddy oauth 凭证（过期也不要紧，30 天内有效）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_PATH = path.resolve(HERE, "../extensions/workbuddy.ts");
const AUTH_PATH = process.env.PI_AUTH ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi/agent/auth.json");

const BASE = "https://copilot.tencent.com";
const ORIGIN = "https://www.codebuddy.cn";
/** 目录接口用官方 CLI 插件形态（与扩展内 AUTH_UA 保持一致）。 */
const AUTH_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/** reasoning 里要快照的子字段（其余 description/温度等不用）。 */
const REASONING_FIELDS = new Set(["effort", "defaultEffort", "supportedEfforts", "canDisableThinking", "summary"]);

function stableId(uid, purpose) {
	let hash = 0;
	for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
	return `wb-${purpose}-${hash.toString(16)}-${uid.slice(0, 8)}`;
}

/** 快照字段顺序固定 = 原快照顺序，键永远存在（缺的补 null），这样重跑不产生假 diff。 */
function project(model) {
	const reasoning = {};
	if (model.reasoning) {
		// 保持上游键顺序，避免因为键序不同产生假 diff。
		for (const key of Object.keys(model.reasoning)) {
			if (REASONING_FIELDS.has(key)) reasoning[key] = model.reasoning[key];
		}
	}
	return {
		id: model.id,
		name: model.name,
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		supportsReasoning: model.supportsReasoning ?? null,
		reasoning: model.reasoning ? reasoning : null,
		supportsImages: model.supportsImages ?? null,
		// onlyReasoning 决定「思考关闭时也必须发 reasoning_effort」，快照里不能丢。
		onlyReasoning: model.onlyReasoning ?? null,
		credits: model.credits ?? null,
	};
}

const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
const wb = auth.workbuddy;
if (!wb?.access) throw new Error(`${AUTH_PATH} 里没有 workbuddy 凭证：先 /login workbuddy`);

/**
 * 与扩展里的 fetchCatalog 同口径：两套目录都读，取并集（同一 id 以 personal 目录为准）。
 * · /v2/enterprises/personal/models —— WorkBuddy 个人版目录
 * · /v3/config —— CodeBuddy 客户端下发配置（有 personal 目录里没有的 SKU）
 */
const CATALOG_PATHS = ["/v2/enterprises/personal/models", "/v3/config"];
const headers = {
	"content-type": "application/json",
	accept: "application/json, text/plain, */*",
	"x-requested-with": "XMLHttpRequest",
	origin: ORIGIN,
	referer: `${ORIGIN}/`,
	"user-agent": AUTH_UA,
	"x-codebuddy-request": "1",
	"accept-language": "zh-CN",
	...(wb.uid ? { "x-machine-id": stableId(wb.uid, "machine"), "x-session-id": stableId(wb.uid, "session") } : {}),
	authorization: `Bearer ${wb.access}`,
};
const merged = new Map();
for (const path of CATALOG_PATHS) {
	let res;
	try {
		res = await fetch(`${BASE}${path}`, { headers });
	} catch (error) {
		console.log(`跳过 ${path}（网络失败：${error.message}）`);
		continue;
	}
	const text = await res.text();
	if (!res.ok) throw new Error(`目录接口失败 ${path}（HTTP ${res.status}）：${text.slice(0, 200)}`);
	const parsed = JSON.parse(text);
	if (parsed.code !== 0) throw new Error(`目录接口业务码 ${parsed.code} ${path}：${parsed.msg ?? ""}`);
	const models = Array.isArray(parsed.data?.models) ? parsed.data.models : [];
	for (const model of models) if (model?.id && !merged.has(model.id)) merged.set(model.id, model);
}
const models = [...merged.values()];
// 与扩展里的 isChatModel 同口径：没有 maxInputTokens 的（生图/生视频）不进模型列表。
const chat = models.filter((model) => Boolean(model.id && model.maxInputTokens)).map(project);
if (chat.length === 0) throw new Error("上游返回 0 个聊天模型，拒绝覆盖快照");

const source = fs.readFileSync(TS_PATH, "utf8");
// 仓库是 CRLF：只吃到 ';'，换行交给 eol 变量，免得 Windows 上匹配不到。
const eol = source.includes("\r\n") ? "\r\n" : "\n";
const line = /const FALLBACK_MODELS: WbModel\[\] = \[.*?\];/s;
const match = line.exec(source);
if (!match) throw new Error("workbuddy.ts 里找不到 FALLBACK_MODELS 数组");

const previous = JSON.parse(match[0].slice(match[0].indexOf("=") + 1).replace(/;$/, ""));
const before = new Map(previous.map((model) => [model.id, JSON.stringify(model)]));
const after = new Map(chat.map((model) => [model.id, JSON.stringify(model)]));
const added = chat.filter((model) => !before.has(model.id)).map((model) => model.id);
const removed = previous.filter((model) => !after.has(model.id)).map((model) => model.id);
const changed = chat.filter((model) => before.has(model.id) && before.get(model.id) !== after.get(model.id)).map((model) => model.id);

console.log(`上游聊天模型 ${chat.length} 个（目录共 ${models.length} 个，已滤掉生图/生视频）`);
if (added.length) console.log("新增：", added.join(", "));
if (removed.length) console.log("下架：", removed.join(", "));
for (const id of changed) {
	const old = JSON.parse(before.get(id));
	const now = chat.find((model) => model.id === id);
	const diffs = Object.keys(now)
		.filter((key) => JSON.stringify(now[key]) !== JSON.stringify(old[key]))
		.map((key) => `${key} ${JSON.stringify(old[key])} → ${JSON.stringify(now[key])}`);
	console.log(`变更 ${id}：${diffs.join("；")}`);
}

const out = JSON.stringify(chat);
const next = `const FALLBACK_MODELS: WbModel[] = ${out};`;
if (next === match[0]) {
	console.log("快照已是上游最新，无需改动");
	process.exit(0);
}
if (process.argv.includes("--diff")) {
	console.log(`\n${next}`);
	process.exit(0);
}
fs.writeFileSync(TS_PATH, source.replace(line, next + eol));
console.log(`已更新 ${path.relative(process.cwd(), TS_PATH)}`);
