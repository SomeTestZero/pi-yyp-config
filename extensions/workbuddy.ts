/**
 * WorkBuddy provider for pi —— 用 WorkBuddy 订阅额度直接跑模型。
 *
 * 为什么不走本地反代：pi 从 /login 直接走 WorkBuddy 官方给插件/CLI 的 OAuth 设备授权，
 * 拿到 token 后由本扩展直接与上游通信。没有本地端口、没有额外进程；换机器只要重新
 * `/login workbuddy` 一次（auth.json 按 pi-sync 的约定永不同步）。
 *
 * 与官方客户端的一致性：出站头补 x-agent-* / x-product / x-private-data 等归因头，
 * 否则用量不归到 WorkBuddy 使用端（实测）；模型目录直接读
 * `/v2/enterprises/personal/models`，上下文、最大输出、思考档位、积分倍率都以它为准。
 *
 * 注意：这是非官方客户端，属于灰色用法（订阅协议只覆盖 WorkBuddy/CodeBuddy 自家产品）；
 * 账号风险自担。官方合规路径是 Coding Plan / Token Plan 的 API Key。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	openAICompletionsApi,
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";

const BASE = "https://copilot.tencent.com";
const ORIGIN = "https://www.codebuddy.cn";
const VERSION = "5.8.0";
/** 聊天出站 UA：官方桌面端三段式（WorkBuddy 5.8.x 实测形状）。 */
const CHAT_UA = `WorkBuddy/${VERSION} WorkBuddy/${VERSION} CLI/2.137.1`;
/** 登录/目录接口用官方 CLI 插件形态。 */
const AUTH_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 上游是 OpenAI 兼容，但有四处必须显式声明：
 * · 只认 stream（pi 本来就走流式）
 * · 不认 stream_options（关掉 include_usage；usage 上游仍会自己给）
 * · 不认小写 role=developer（用 system）
 * · max_tokens 字段名
 */
const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	thinkingFormat: "openai" as const,
	maxTokensField: "max_tokens" as const,
	supportsUsageInStreaming: false,
	supportsStrictMode: false,
};

interface WbModel {
	id: string;
	name?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	supportsReasoning?: boolean | null;
	supportsImages?: boolean | null;
	reasoning?: {
		effort?: string;
		defaultEffort?: string;
		supportedEfforts?: string[];
		canDisableThinking?: boolean;
	} | null;
	credits?: string | null;
}

/** 离线/未登录时的兜底目录（2026-11 抓取）。登录后 refreshModels 用上游最新数据覆盖。 */
const FALLBACK_MODELS: WbModel[] = [{"id":"auto","name":"Auto","maxInputTokens":256000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"credits":null},{"id":"hy3","name":"Hy3","maxInputTokens":192000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"credits":"x0.00 credits"},{"id":"hy3-x","name":"Hy3","maxInputTokens":192000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high"]},"supportsImages":true,"credits":"x0.05"},{"id":"hy4-preview","name":"Hy4 preview","maxInputTokens":960000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["high"]},"supportsImages":true,"credits":"x0.29"},{"id":"hy4-preview-x","name":"Hy4 preview","maxInputTokens":960000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["high"]},"supportsImages":true,"credits":"x0.29"},{"id":"default","name":"Default","maxInputTokens":200000,"maxOutputTokens":24000,"supportsReasoning":null,"reasoning":null,"supportsImages":false,"credits":"x2.20 credits"},{"id":"glm-5.3","name":"GLM-5.3","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"credits":"x0.69"},{"id":"glm-5.3-flash","name":"GLM-5.3-Flash","maxInputTokens":1000000,"maxOutputTokens":131072,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"credits":"x0.08"},{"id":"glm-5.2","name":"GLM-5.2","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"credits":"x0.79 credits"},{"id":"glm-5.0","name":"GLM-5.0","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"credits":"x0.80 credits"},{"id":"glm-4.7","name":"GLM-4.7","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"credits":"x0.23 credits"},{"id":"glm-4.6","name":"GLM-4.6","maxInputTokens":168000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"credits":"x0.23 credits"},{"id":"glm-4.6v","name":"GLM-4.6V","maxInputTokens":128000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"credits":"x0.11 credits"},{"id":"minimax-m2.5","name":"MiniMax-M2.5","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"credits":"x0.18 credits"},{"id":"kimi-k3-1","name":"Kimi-K3","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"credits":"x1.62 credits"},{"id":"kimi-k2.8-preview","name":"Kimi-K2.8-Preview","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":true,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"credits":"x0.77 credits"},{"id":"kimi-k2.5","name":"Kimi-K2.5","maxInputTokens":164000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"credits":"x0.45 credits"},{"id":"kimi-k2-thinking","name":"Kimi-K2-Thinking","maxInputTokens":164000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"credits":"x0.54 credits"},{"id":"deepseek-v4-flash","name":"Deepseek-V4-Flash","maxInputTokens":1000000,"maxOutputTokens":50000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"credits":"x0.17 credits"},{"id":"deepseek-v4.1-flash","name":"DeepSeek-V4.1-Flash","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":true,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"credits":"x0.11 credits"},{"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"credits":"x0.51 credits"},{"id":"deepseek-v3-2-volc","name":"DeepSeek-V3.2","maxInputTokens":96000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"credits":"x0.29 credits"},{"id":"hunyuan-2.0-thinking","name":"Hunyuan-2.0-Thinking","maxInputTokens":128000,"maxOutputTokens":24000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"credits":"x0.04 credits"},{"id":"hunyuan-chat","name":"Hunyuan-Turbos","maxInputTokens":200000,"maxOutputTokens":8192,"supportsReasoning":null,"reasoning":null,"supportsImages":false,"credits":null},{"id":"space-bunny","name":"Space-Bunny","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"max","summary":"auto","supportedEfforts":["low","medium","high","xhigh","max"]},"supportsImages":true,"credits":"x0.08 credits"},{"id":"step-5-preview","name":"Step-5-Preview","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","medium","high"]},"supportsImages":true,"credits":"x0.33 credits"},{"id":"mimo-v2.6-pro","name":"Xiaomi MiMo-V2.6-Pro","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"credits":"x0.13 credits"},{"id":"minimax-m3.1-flash","name":"MiniMax-M3.1-Flash","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"max","summary":"auto","supportedEfforts":["low","medium","high","xhigh","max"]},"supportsImages":true,"credits":"x0.08 credits"},{"id":"kimi-k3.1-pro","name":"Kimi-K3.1-Pro","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"credits":"x0.97 credits"}];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stableId(uid: string, purpose: "machine" | "session"): string {
	// 不用随机值：同账号每次换机器 ID 更像异常来源。用 uid 派生稳定的设备标识。
	let hash = 0;
	for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
	return `wb-${purpose}-${hash.toString(16)}-${uid.slice(0, 8)}`;
}

function commonHeaders(token?: string, uid?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/plain, */*",
		"x-requested-with": "XMLHttpRequest",
		origin: ORIGIN,
		referer: `${ORIGIN}/`,
		"user-agent": AUTH_UA,
		"x-codebuddy-request": "1",
		"accept-language": "zh-CN",
	};
	if (uid) {
		headers["x-machine-id"] = stableId(uid, "machine");
		headers["x-session-id"] = stableId(uid, "session");
	}
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

/** 聊天出站头：补官方客户端指纹，确保用量归因到 WorkBuddy。 */
function chatHeaders(token: string): Record<string, string> {
	return {
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
		"user-agent": CHAT_UA,
		origin: ORIGIN,
		referer: `${ORIGIN}/`,
		"x-requested-with": "XMLHttpRequest",
		"accept-language": "zh-CN",
		"x-agent-purpose": "conversation",
		"x-agent-intent": "craft",
		"x-ide-name": "WorkBuddy",
		"x-ide-type": "WorkBuddy",
		"x-ide-version": VERSION,
		"x-product": "SaaS",
		"x-private-data": "true",
		"x-codebuddy-request": "1",
	};
}

class PendingLogin extends Error {}

async function wbRequest<T>(
	path: string,
	opts: { method?: string; body?: unknown; token?: string; uid?: string; signal?: AbortSignal } = {},
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: opts.method ?? "GET",
		headers: commonHeaders(opts.token, opts.uid),
		body: opts.method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
		signal: opts.signal ?? AbortSignal.timeout(30_000),
	});
	const text = await res.text().catch(() => "");
	let parsed: { code?: unknown; msg?: unknown; data?: unknown };
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`WorkBuddy 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
	}
	if (!res.ok) throw new Error(`WorkBuddy 接口失败（HTTP ${res.status}）：${String(parsed.msg ?? text).slice(0, 160)}`);
	if (typeof parsed.code === "number" && parsed.code !== 0) {
		// 登录轮询未完成时是业务码非 0，不是网络错误 —— 调用方需要继续等。
		throw new PendingLogin(`WorkBuddy 业务码 ${parsed.code}：${String(parsed.msg ?? "")}`);
	}
	return (parsed.data ?? {}) as T;
}

interface TokenData {
	accessToken?: string;
	refreshToken?: string;
	expiresIn?: number;
	domain?: string;
}

function toCredentials(token: TokenData, extra: Record<string, unknown> = {}): OAuthCredentials {
	if (typeof token.accessToken !== "string" || !token.accessToken) throw new Error("WorkBuddy 未返回 accessToken");
	const expiresIn = typeof token.expiresIn === "number" && token.expiresIn > 0 ? token.expiresIn : 28 * 24 * 3600;
	return {
		access: token.accessToken,
		refresh: typeof token.refreshToken === "string" ? token.refreshToken : "",
		// 提前 5 分钟过期，避免边界上刚好失效。
		expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
		domain: token.domain,
		...extra,
	};
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const start = await wbRequest<{ state?: string; authUrl?: string }>("/v2/plugin/auth/state?platform=CLI", {
		method: "POST",
		body: {},
	});
	if (!start.state || !start.authUrl) throw new Error("WorkBuddy 登录接口未返回 state/authUrl");
	callbacks.onAuth({ url: start.authUrl, instructions: "用你的 WorkBuddy 账号完成登录/授权" });

	const deadline = Date.now() + LOGIN_TIMEOUT_MS;
	let token: TokenData | undefined;
	for (;;) {
		try {
			token = await wbRequest<TokenData>(`/v2/plugin/auth/token?state=${encodeURIComponent(start.state)}`);
			break;
		} catch (error) {
			if (!(error instanceof PendingLogin)) throw error;
			if (callbacks.signal?.aborted) throw new Error("WorkBuddy 登录已取消");
			if (Date.now() >= deadline) throw new Error("WorkBuddy 登录超时，请重新 /login workbuddy");
			callbacks.onProgress?.(`等待授权… ${Math.round((deadline - Date.now()) / 1000)}s`);
			await sleep(POLL_MS);
		}
	}

	// uid 只用于目录接口的设备头；拿不到不阻塞登录。
	let uid: string | undefined;
	let nickname: string | undefined;
	try {
		const account = await wbRequest<{ uid?: string; nickname?: string }>(
			`/v2/plugin/login/account?state=${encodeURIComponent(start.state)}`,
			{ token: token.accessToken },
		);
		uid = account.uid;
		nickname = account.nickname;
	} catch {
		// ignore
	}
	return toCredentials(token, { uid, nickname });
}

async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const headers = commonHeaders();
	delete headers["content-type"];
	headers["x-refresh-token"] = credentials.refresh;
	headers["x-auth-refresh-source"] = "plugin";

	const res = await fetch(`${BASE}/v2/plugin/auth/token/refresh`, {
		method: "POST",
		headers,
		body: "{}",
		signal,
	});
	const text = await res.text().catch(() => "");
	let parsed: { code?: unknown; msg?: unknown; data?: unknown };
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`WorkBuddy 刷新返回非 JSON（HTTP ${res.status}）`);
	}
	if (!res.ok) throw new Error(`WorkBuddy 刷新被拒（HTTP ${res.status}）：${String(parsed.msg ?? text).slice(0, 160)}`);
	if (typeof parsed.code === "number" && parsed.code !== 0) {
		throw new Error(`WorkBuddy 刷新失败（业务码 ${parsed.code}）：${String(parsed.msg ?? "")}`);
	}
	const data = (parsed.data ?? {}) as TokenData;
	const next = toCredentials(data, { uid: credentials.uid, nickname: credentials.nickname });
	return {
		...credentials,
		...next,
		// 两个 token 一起轮换：新 refresh 必须覆盖旧值。
		refresh: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : credentials.refresh,
	};
}

function creditSuffix(credits: string | null | undefined): string {
	const match = credits ? /x([0-9.]+)/.exec(credits) : null;
	if (!match) return "";
	return match[1] === "0.00" ? " (free)" : ` (${match[1]}x)`;
}

function thinkingLevelMap(model: WbModel): Record<string, string | null> | undefined {
	const reasoning = model.reasoning ?? {};
	const supported = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
	const fixed = reasoning.defaultEffort ?? reasoning.effort;
	if (supported.length > 0) {
		const has = (value: string) => supported.includes(value);
		return {
			// canDisableThinking 的模型也没有可靠的“关闭”参数，统一不给 off，避免发出无效值。
			off: null,
			minimal: null,
			low: has("low") ? "low" : supported[0],
			medium: has("medium") ? "medium" : has("high") ? "high" : supported[0],
			high: has("high") ? "high" : supported[supported.length - 1],
			xhigh: has("xhigh") ? "xhigh" : has("max") ? "max" : null,
			max: has("max") ? "max" : has("xhigh") ? "xhigh" : null,
		};
	}
	if (fixed) {
		// 固定档位的模型：无论选哪档，上游都按它自己的默认 effort 跑。
		return { off: null, minimal: null, low: fixed, medium: fixed, high: fixed, xhigh: null, max: null };
	}
	return undefined;
}

function toModelConfig(model: WbModel) {
	const thinking = thinkingLevelMap(model);
	return {
		id: model.id,
		name: `${model.name ?? model.id}${creditSuffix(model.credits)}`,
		contextWindow: model.maxInputTokens ?? 128000,
		maxTokens: model.maxOutputTokens ?? 32000,
		reasoning: model.supportsReasoning === true || (model.supportsReasoning == null && Boolean(model.reasoning)),
		input: (model.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		...(thinking ? { thinkingLevelMap: thinking } : {}),
		cost: ZERO_COST,
		compat: COMPAT,
	};
}

async function fetchCatalog(token: string, uid: string | undefined, signal: AbortSignal): Promise<WbModel[]> {
	const data = await wbRequest<{ models?: WbModel[] }>("/v2/enterprises/personal/models", { token, uid, signal });
	return Array.isArray(data.models) ? data.models : [];
}

function isChatModel(model: WbModel): boolean {
	return Boolean(model.id && model.maxInputTokens);
}

let uiContext: any;
let sessionCredits = 0;

function renderCredits(): void {
	uiContext?.ui.setStatus("workbuddy", sessionCredits > 0 ? `WorkBuddy ${sessionCredits.toFixed(2)} cr` : undefined);
}

function noteCredit(credit: number): void {
	sessionCredits += credit;
	renderCredits();
}

function streamSimple(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const token = options?.apiKey;
	if (!token) throw new Error("WorkBuddy 未登录：先运行 /login workbuddy");

	const outbound: Model<Api> = {
		...model,
		headers: { ...(model.headers ?? {}), ...chatHeaders(token) },
	};

	return openAICompletionsApi().streamSimple(outbound, context, {
		...options,
		onProviderStreamEvent: async (data, eventModel) => {
			// usage.credit 是本次请求消耗的积分（上游最终 chunk 里给）。
			const usage = (data as { usage?: { credit?: unknown } } | undefined)?.usage;
			if (usage && typeof usage.credit === "number" && usage.credit > 0) {
				if (process.env.PI_WB_DEBUG) console.error("[wb] credit", usage.credit);
				noteCredit(usage.credit);
			}
			await options?.onProviderStreamEvent?.(data, eventModel);
		},
	});
}

export default function workbuddyExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		sessionCredits = 0;
		renderCredits();
	});

	pi.registerCommand("wb", {
		description: "WorkBuddy：本次积分 / 模型倍率 / 刷新模型目录",
		handler: async (args, ctx) => {
			if (args.trim() === "refresh") {
				const result = await ctx.modelRegistry.refresh({ force: true, providers: ["workbuddy"] });
				const failed = [...result.errors.values()].map((error) => error.message).join("; ");
				ctx.ui.notify(
					failed ? `WorkBuddy 模型刷新失败：${failed}` : "WorkBuddy 模型目录已刷新",
					failed ? "warning" : "info",
				);
				return;
			}
			const token = await ctx.modelRegistry.getApiKeyForProvider("workbuddy").catch(() => undefined);
			if (!token) {
				ctx.ui.notify("WorkBuddy 未登录：先运行 /login workbuddy", "warning");
				return;
			}
			const models = ctx.modelRegistry.getModelsOfType("chat", "workbuddy");
			const lines = models.map((model) => {
				const context = `${Math.round(model.contextWindow / 1000)}K`;
				const output = `${Math.round(model.maxTokens / 1000)}K`;
				return `${model.name}  · ctx ${context} / out ${output}`;
			});
			await ctx.ui.select(`WorkBuddy · 本次已用 ${sessionCredits.toFixed(2)} credits`, lines);
		},
	});

	pi.registerProvider("workbuddy", {
		name: "WorkBuddy",
		baseUrl: `${BASE}/v2`,
		api: "openai-completions",
		oauth: {
			name: "WorkBuddy",
			isSubscription: true,
			login,
			refreshToken,
			getApiKey: (credentials) => credentials.access,
		},
		models: FALLBACK_MODELS.filter(isChatModel).map(toModelConfig),
		async refreshModels(context) {
			if (context.credential?.type !== "oauth") return FALLBACK_MODELS.filter(isChatModel).map(toModelConfig);
			try {
				const uid = typeof context.credential.uid === "string" ? context.credential.uid : undefined;
				const models = await fetchCatalog(context.credential.access, uid, context.signal);
				const chat = models.filter(isChatModel);
				if (chat.length === 0) return FALLBACK_MODELS.filter(isChatModel).map(toModelConfig);
				return chat.map(toModelConfig);
			} catch {
				return FALLBACK_MODELS.filter(isChatModel).map(toModelConfig);
			}
		},
		streamSimple,
	});
}
