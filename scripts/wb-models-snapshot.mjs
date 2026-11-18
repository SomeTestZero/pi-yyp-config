#!/usr/bin/env node
/**
 * 刷新 extensions/workbuddy.ts 里的 FALLBACK_MODELS_CN / FALLBACK_MODELS_INTL（离线/未登录兜底目录）。
 *
 * 真机目录永远以上游目录接口为准（扩展运行时 refreshModels 会拉）；
 * 快照只在没登录 / 拉取失败时用，所以要跟着上游一起更新。两站目录不同，分开抓、分开存。
 *
 * 用法：
 *   node scripts/wb-models-snapshot.mjs                # 原地刷新两个站点
 *   node scripts/wb-models-snapshot.mjs --site intl    # 只刷新指定站点（cn|intl）
 *   node scripts/wb-models-snapshot.mjs --diff         # 只打印差异，不改文件
 *
 * 依赖 ~/.pi/agent/auth.json 里的 workbuddy-cn / workbuddy-intl oauth 凭证
 * （过期也不要紧，30 天内有效）；缺凭证的站点跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_PATH = path.resolve(HERE, "../extensions/workbuddy.ts");
const AUTH_PATH = process.env.PI_AUTH ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi/agent/auth.json");

/** 与扩展里的 SITES 保持一致。 */
const SITES = {
	cn: { base: "https://copilot.tencent.com", origin: "https://www.codebuddy.cn", language: "zh-CN", constant: "FALLBACK_MODELS_CN" },
	intl: { base: "https://www.codebuddy.ai", origin: "https://www.codebuddy.ai", language: "en-US", constant: "FALLBACK_MODELS_INTL" },
};
/** 目录接口用官方 CLI 插件形态（与扩展内 AUTH_UA 保持一致）。 */
const AUTH_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
 * 与扩展里的 fetchCatalog 同口径：两套目录都读，取并集（同一 id 以 personal 目录为准）。
 * Intl 的 personal 目录是 404，跳过即可，只用 /v3/config。
 */
const CATALOG_PATHS = ["/v2/enterprises/personal/models", "/v3/config"];

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

async function fetchSite(site, wb) {
	const headers = {
		"content-type": "application/json",
		accept: "application/json, text/plain, */*",
		"x-requested-with": "XMLHttpRequest",
		origin: site.origin,
		referer: `${site.origin}/`,
		"user-agent": AUTH_UA,
		"x-codebuddy-request": "1",
		"accept-language": site.language,
		...(wb.uid ? { "x-machine-id": stableId(wb.uid, "machine"), "x-session-id": stableId(wb.uid, "session") } : {}),
		authorization: `Bearer ${wb.access}`,
	};
	const merged = new Map();
	let ok = 0;
	for (const p of CATALOG_PATHS) {
		let res;
		try {
			res = await fetch(`${site.base}${p}`, { headers, signal: AbortSignal.timeout(30000) });
		} catch (error) {
			console.log(`  跳过 ${p}（网络失败：${error.message}）`);
			continue;
		}
		const text = await res.text();
		if (!res.ok) {
			console.log(`  跳过 ${p}（HTTP ${res.status}：${text.slice(0, 120)}）`);
			continue;
		}
		const parsed = JSON.parse(text);
		if (parsed.code !== 0) {
			console.log(`  跳过 ${p}（业务码 ${parsed.code}：${parsed.msg ?? ""}）`);
			continue;
		}
		ok++;
		const models = Array.isArray(parsed.data?.models) ? parsed.data.models : [];
		for (const model of models) if (model?.id && !merged.has(model.id)) merged.set(model.id, model);
	}
	if (ok === 0) throw new Error("两个目录接口都失败");
	const models = [...merged.values()];
	// 与扩展里的 isChatModel 同口径：没有 maxInputTokens 的（生图/生视频）不进模型列表。
	const chat = models.filter((model) => Boolean(model.id && model.maxInputTokens)).map(project);
	if (chat.length === 0) throw new Error("上游返回 0 个聊天模型，拒绝覆盖快照");
	return { chat, total: models.length };
}

const args = process.argv.slice(2);
const diffOnly = args.includes("--diff");
const siteArg = args.includes("--site") ? args[args.indexOf("--site") + 1] : undefined;
if (siteArg && !SITES[siteArg]) throw new Error(`--site 只支持 cn|intl，收到：${siteArg}`);
const targets = siteArg ? [siteArg] : Object.keys(SITES);

const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
let source = fs.readFileSync(TS_PATH, "utf8");
let updated = 0;
let failed = 0;

for (const key of targets) {
	const site = SITES[key];
	console.log(`\n[${key}] ${site.base}`);
	// 兼容旧键 auth.workbuddy（仅 CN）。
	const wb = auth[`workbuddy-${key}`] ?? (key === "cn" ? auth.workbuddy : undefined);
	if (!wb?.access) {
		console.log(`  跳过：auth.json 里没有 workbuddy-${key} 凭证（先 /login workbuddy-${key}）`);
		failed++;
		continue;
	}
	let chat, total;
	try {
		({ chat, total } = await fetchSite(site, wb));
	} catch (error) {
		console.log(`  跳过：${error.message}`);
		failed++;
		continue;
	}

	const line = new RegExp(`const ${site.constant}: WbModel\\[\\] = \\[.*?\\];`, "s");
	const match = line.exec(source);
	if (!match) throw new Error(`workbuddy.ts 里找不到 ${site.constant} 数组`);
	const previous = JSON.parse(match[0].slice(match[0].indexOf("=") + 1).replace(/;$/, ""));
	const before = new Map(previous.map((model) => [model.id, JSON.stringify(model)]));
	const after = new Map(chat.map((model) => [model.id, JSON.stringify(model)]));
	const added = chat.filter((model) => !before.has(model.id)).map((model) => model.id);
	const removed = previous.filter((model) => !after.has(model.id)).map((model) => model.id);
	const changed = chat.filter((model) => before.has(model.id) && before.get(model.id) !== after.get(model.id)).map((model) => model.id);

	console.log(`  上游聊天模型 ${chat.length} 个（目录共 ${total} 个，已滤掉生图/生视频）`);
	if (added.length) console.log("  新增：", added.join(", "));
	if (removed.length) console.log("  下架：", removed.join(", "));
	for (const id of changed) {
		const old = JSON.parse(before.get(id));
		const now = chat.find((model) => model.id === id);
		const diffs = Object.keys(now)
			.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(old[k]))
			.map((k) => `${k} ${JSON.stringify(old[k])} → ${JSON.stringify(now[k])}`);
		console.log(`  变更 ${id}：${diffs.join("；")}`);
	}

	const next = `const ${site.constant}: WbModel[] = ${JSON.stringify(chat)};`;
	if (next === match[0]) {
		console.log("  快照已是上游最新，无需改动");
		continue;
	}
	if (diffOnly) {
		console.log(`\n${next}`);
		continue;
	}
	// 只替换到 ';' 为止，保留原有换行（仓库是 CRLF）。
	source = source.replace(line, next);
	updated++;
	console.log(`  已更新 ${site.constant}`);
}

if (!diffOnly && updated > 0) {
	fs.writeFileSync(TS_PATH, source);
	console.log(`\n已写入 ${path.relative(process.cwd(), TS_PATH)}`);
}
if (failed === targets.length) process.exit(1);
