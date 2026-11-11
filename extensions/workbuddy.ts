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
	createAssistantMessageEventStream,
	openAICompletionsApi,
	type Api,
	type AssistantMessage,
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
	/** 只支持思考模式（不能关思考）——这类模型必须每次都带 reasoning_effort。 */
	onlyReasoning?: boolean;
	credits?: string | null;
}

/**
 * 离线/未登录时的兜底目录（2026-11-11 抓取）。登录后 refreshModels 用上游最新数据覆盖。
 * 重新生成：node scripts/wb-models-snapshot.mjs（只保留有 maxInputTokens 的聊天模型）。
 */
const FALLBACK_MODELS: WbModel[] = [{"id":"auto","name":"Auto","maxInputTokens":256000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":null},{"id":"hy4free","name":"Hy4","maxInputTokens":960000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["high"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.00 credits"},{"id":"hy4std","name":"Hy4","maxInputTokens":960000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["high"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.29 credits"},{"id":"fast-model","name":"快速","maxInputTokens":300000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.15"},{"id":"balanced-model","name":"均衡","maxInputTokens":300000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.50"},{"id":"deep-model","name":"极致","maxInputTokens":300000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x1.00"},{"id":"hy3","name":"Hy3","maxInputTokens":192000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.00 credits"},{"id":"hy3-x","name":"Hy3","maxInputTokens":192000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.05"},{"id":"hy4-preview-x","name":"Hy4 preview","maxInputTokens":960000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["high"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.29"},{"id":"default","name":"Default","maxInputTokens":200000,"maxOutputTokens":24000,"supportsReasoning":null,"reasoning":null,"supportsImages":false,"onlyReasoning":null,"credits":"x2.20 credits"},{"id":"glm-5.3","name":"GLM-5.3","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.69"},{"id":"glm-5.3-flash","name":"GLM-5.3-Flash","maxInputTokens":1000000,"maxOutputTokens":131072,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.08"},{"id":"glm-5.2","name":"GLM-5.2","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.79 credits"},{"id":"glm-5.0","name":"GLM-5.0","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"onlyReasoning":null,"credits":"x0.80 credits"},{"id":"glm-4.7","name":"GLM-4.7","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"onlyReasoning":null,"credits":"x0.23 credits"},{"id":"glm-4.6","name":"GLM-4.6","maxInputTokens":168000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":null,"supportsImages":false,"onlyReasoning":null,"credits":"x0.23 credits"},{"id":"glm-4.6v","name":"GLM-4.6V","maxInputTokens":128000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":null,"credits":"x0.11 credits"},{"id":"minimax-m2.5","name":"MiniMax-M2.5","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"onlyReasoning":true,"credits":"x0.18 credits"},{"id":"kimi-k3-1","name":"Kimi-K3","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x1.62 credits"},{"id":"kimi-k2.8-preview","name":"Kimi-K2.8-Preview","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":true,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.77 credits"},{"id":"kimi-k2.5","name":"Kimi-K2.5","maxInputTokens":164000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.45 credits"},{"id":"kimi-k2-thinking","name":"Kimi-K2-Thinking","maxInputTokens":164000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"onlyReasoning":true,"credits":"x0.54 credits"},{"id":"deepseek-v4-flash","name":"Deepseek-V4-Flash","maxInputTokens":1000000,"maxOutputTokens":50000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.17 credits"},{"id":"deepseek-v4.1-flash","name":"DeepSeek-V4.1-Flash","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":true,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.11 credits"},{"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.51 credits"},{"id":"deepseek-v3-2-volc","name":"DeepSeek-V3.2","maxInputTokens":96000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"onlyReasoning":true,"credits":"x0.29 credits"},{"id":"hunyuan-2.0-thinking","name":"Hunyuan-2.0-Thinking","maxInputTokens":128000,"maxOutputTokens":24000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"onlyReasoning":true,"credits":"x0.04 credits"},{"id":"hunyuan-chat","name":"Hunyuan-Turbos","maxInputTokens":200000,"maxOutputTokens":8192,"supportsReasoning":null,"reasoning":null,"supportsImages":false,"onlyReasoning":null,"credits":null},{"id":"space-bunny","name":"Space-Bunny","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"max","summary":"auto","supportedEfforts":["low","medium","high","xhigh","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.08 credits"},{"id":"step-5-preview","name":"Step-5-Preview","maxInputTokens":1000000,"maxOutputTokens":64000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","medium","high"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.33 credits"},{"id":"mimo-v2.6-pro","name":"Xiaomi MiMo-V2.6-Pro","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"effort":"high","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.13 credits"},{"id":"minimax-m3.1-flash","name":"MiniMax-M3.1-Flash","maxInputTokens":1000000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"max","summary":"auto","supportedEfforts":["low","medium","high","xhigh","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.08 credits"},{"id":"kimi-k3.1-pro","name":"Kimi-K3.1-Pro","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.97 credits"},{"id":"minimax-m2.7","name":"MiniMax-M2.7","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.26 credits"},{"id":"minimax-m3-pay","name":"MiniMax-M3","maxInputTokens":512000,"maxOutputTokens":128000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x0.25 credits"},{"id":"glm-5.3-flashx","name":"GLM-5.3-FlashX","maxInputTokens":1000000,"maxOutputTokens":131072,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x0.19 credits"},{"id":"glm-5.0-turbo","name":"GLM-5.0-Turbo","maxInputTokens":200000,"maxOutputTokens":48000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":false,"onlyReasoning":true,"credits":"x0.95 credits"},{"id":"kimi-k3-2","name":"Kimi-K3","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"effort":"medium","summary":"auto"},"supportsImages":true,"onlyReasoning":true,"credits":"x1.62"},{"id":"kimi-k3.1-pro-highspeed","name":"Kimi-K3.1-Pro-Highspeed","maxInputTokens":1000000,"maxOutputTokens":32000,"supportsReasoning":true,"reasoning":{"canDisableThinking":false,"defaultEffort":"high","summary":"auto","supportedEfforts":["low","high","max"]},"supportsImages":true,"onlyReasoning":true,"credits":"x1.56 credits"}];



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

/**
 * 排队（6020 / 6021 / 6022）。
 *
 * 上游把「拥堵」和「排队」拆成两条链路：聊天请求先回 429 + 业务码把你挡进队列，
 * 客户端再拿这个 requestId 轮询 /v2/chat/queue/status，放行后重新发一次请求。
 * pi 的通用重试不懂这套（3 次 × 2/4/8s），第二次重发还会撞 6022——队列里那个
 * requestId 还占着位——所以最后总是「Retry failed after 3 attempts」。
 * 这里在 provider 内部补上这条链路：按 retry_after 等、轮询队列、放行后重发，
 * 等待进度写进状态栏；用户中断时顺手把队位退掉（6022 的根就是没退队）。
 */
const QUEUE_CODES = new Set([6020, 6021, 6022]);
/** queue/status 里表示「还没轮到」的取值；其余（expired / cancelled / ready…）都当放行。 */
const QUEUE_WAITING_STATES = new Set(["waiting", "queued", "pending", "in_queue", "queueing"]);

function envMs(name: string, fallback: number, allowZero = false): number {
	const value = Number(process.env[name]);
	if (!Number.isFinite(value)) return fallback;
	if (value > 0) return Math.floor(value);
	return allowZero && value === 0 ? 0 : fallback;
}

const QUEUE_POLL_MS = envMs("PI_WB_QUEUE_POLL_MS", 5000);
/** 排队总预算；0 = 不等待，撞到排队直接报一句人话（想快速换模型时用）。 */
const QUEUE_MAX_WAIT_MS = envMs("PI_WB_QUEUE_MAX_WAIT_MS", 15 * 60 * 1000, true);
/** 没有队列信息的裸 429：等这么久再发一次（对方没给 retry_after 时的保守值）。 */
const QUEUE_BARE_RETRY_MS = envMs("PI_WB_QUEUE_BARE_RETRY_MS", 20_000);

export interface QueueInfo {
	code: number;
	requestId?: string;
	position?: number;
	size?: number;
	retryAfterMs?: number;
	estimatedWaitMs?: number;
	userType?: string;
}

function fieldNumber(text: string, key: string): number | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(text);
	return match ? Number(match[1]) : undefined;
}

function fieldString(text: string, key: string): string | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
	return match ? match[1] : undefined;
}

/**
 * 从「429: {…}」这种报错文本里认出排队，抽出席位信息；不是排队返回 null。
 * 报错体可能被上游截断，所以 JSON 解析失败时退回正则抽关键字段。
 */
export function parseQueueInfo(text: string): QueueInfo | null {
	const raw = String(text ?? "");
	let code = fieldNumber(raw, "code");
	let requestId = fieldString(raw, "requestId");
	let data: Record<string, unknown> = {};
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
			if (typeof parsed.code === "number") code = parsed.code;
			if (typeof parsed.requestId === "string") requestId = parsed.requestId;
			if (parsed.data && typeof parsed.data === "object") data = parsed.data as Record<string, unknown>;
		} catch {
			// 截断/拼接过的报错体：正则抽字段就够做等待决策
		}
	}
	if (code === undefined || !QUEUE_CODES.has(code)) return null;
	const retryAfter = typeof data.retry_after === "number" ? data.retry_after : fieldNumber(raw, "retry_after");
	const estimated = typeof data.estimated_wait === "number" ? data.estimated_wait : fieldNumber(raw, "estimated_wait");
	const position = typeof data.queue_position === "number" ? data.queue_position : fieldNumber(raw, "queue_position");
	const size = typeof data.queue_size === "number" ? data.queue_size : fieldNumber(raw, "queue_size");
	const userType = typeof data.client_user_type === "string" ? data.client_user_type : fieldString(raw, "client_user_type");
	return {
		code,
		requestId,
		position,
		size,
		retryAfterMs: retryAfter === undefined ? undefined : retryAfter * 1000,
		estimatedWaitMs: estimated === undefined ? undefined : estimated * 1000,
		userType,
	};
}

function looksThrottled(text: string): boolean {
	return /\b429\b/.test(text) || /too many requests|rate.?limit|频率/i.test(text);
}

/** 队列状态。拿不到（网络/上游没这条）就返回 undefined，调用方按计时继续等。 */
async function queueStatus(token: string, model: string, requestId: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetch(`${BASE}/v2/chat/queue/status`, {
			method: "POST",
			headers: { ...chatHeaders(token), "X-Conversation-Request-ID": requestId },
			body: JSON.stringify({ model }),
			signal: signal ?? AbortSignal.timeout(15_000),
		});
		if (!res.ok) return undefined;
		const text = await res.text().catch(() => "");
		const parsed = text ? (JSON.parse(text) as { data?: { status?: unknown } }) : {};
		return typeof parsed.data?.status === "string" ? parsed.data.status : undefined;
	} catch {
		return undefined;
	}
}

/** 退队。失败无害：下一次请求撞 6022 再等一轮就好。 */
async function queueCancel(token: string, model: string, requestId: string): Promise<void> {
	try {
		await fetch(`${BASE}/v2/chat/queue/cancel`, {
			method: "POST",
			headers: { ...chatHeaders(token), "X-Conversation-Request-ID": requestId },
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(5_000),
		});
	} catch {
		// ignored
	}
}

function queueSummary(model: string, info: QueueInfo): string {
	const bits = [`${model} 排队中`];
	if (info.position !== undefined) {
		bits.push(info.size !== undefined ? `第 ${info.position}/${info.size} 位` : `第 ${info.position} 位`);
	}
	if (info.estimatedWaitMs !== undefined) bits.push(`约 ${Math.round(info.estimatedWaitMs / 1000)}s`);
	return bits.join("，");
}

function queueText(model: string, info: QueueInfo, waitedMs: number, status: string | undefined): string {
	const bits = [queueSummary(model, info)];
	if (status) bits.push(status);
	if (waitedMs >= 1000) bits.push(`已等 ${Math.round(waitedMs / 1000)}s`);
	return bits.join(" · ");
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

export interface QueueStreamOptions {
	token: string;
	model: string;
	signal?: AbortSignal;
	makeStream: () => AssistantMessageEventStream;
	/** 流都没开成时（同步抛错）拿来当错误载体，免得 result() 拿到 undefined。 */
	fallback: () => AssistantMessage;
	onStatus?: (text: string | undefined) => void;
	maxWaitMs?: number;
	pollMs?: number;
	now?: () => number;
	wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
	probe?: (token: string, model: string, requestId: string, signal?: AbortSignal) => Promise<string | undefined>;
	cancel?: (token: string, model: string, requestId: string) => Promise<void>;
}

/**
 * 把一次聊天包成「被挡就等、放行就重发」。
 *
 * 只在报错里认出排队/限流时接管；其它错误原样交给 pi 的重试层——那里有压缩、
 * 上下文溢出、账号态它才懂的处理。重发时不能再补 start 事件：pi 会把 start
 * 当成一条新消息塞进上下文，重发就会多出一条空的 assistant 消息。
 */
export function streamQueueAware(opts: QueueStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const now = opts.now ?? Date.now;
	const wait = opts.wait ?? sleepUnlessAborted;
	const probe = opts.probe ?? queueStatus;
	const cancel = opts.cancel ?? queueCancel;
	const pollMs = opts.pollMs ?? QUEUE_POLL_MS;
	const maxWaitMs = opts.maxWaitMs ?? QUEUE_MAX_WAIT_MS;

	const finishError = (message: AssistantMessage, reason: "error" | "aborted", errorMessage?: string) => {
		opts.onStatus?.(undefined);
		out.push({
			type: "error",
			reason,
			error: errorMessage === undefined ? message : { ...message, stopReason: reason === "aborted" ? "aborted" : "error", errorMessage },
		});
		out.end();
	};

	void (async () => {
		const deadline = now() + maxWaitMs;
		let startForwarded = false;
		let partial: AssistantMessage | undefined;
		let attempts = 0;

		try {
			for (;;) {
				attempts++;
				const inner = opts.makeStream();
				let failed: AssistantMessage | undefined;

				for await (const event of inner) {
					if (event.type === "start") {
						partial = event.partial;
						if (startForwarded) continue;
						startForwarded = true;
						out.push(event);
						continue;
					}
					if (event.type === "error") {
						failed = event.error;
						break;
					}
					out.push(event);
					if (event.type === "done") {
						opts.onStatus?.(undefined);
						out.end();
						return;
					}
				}

				const message = failed?.errorMessage ?? "";
				if (!failed) {
					finishError(partial ?? opts.fallback(), "error", "WorkBuddy 返回了空响应");
					return;
				}
				if (failed.stopReason === "aborted") {
					finishError(failed, "aborted");
					return;
				}

				const info = parseQueueInfo(message);
				const queued: QueueInfo | null = info ?? (looksThrottled(message) ? { code: 429 } : null);
				if (!queued) {
					finishError(failed, "error");
					return;
				}
				if (maxWaitMs <= 0) {
					finishError(failed, "error", `${queueSummary(opts.model, queued)}；PI_WB_QUEUE_MAX_WAIT_MS=0 不等待，稍后重试或换个模型`);
					return;
				}

				const attemptStart = now();
				const targetMs = Math.min(
					Math.max(queued.estimatedWaitMs ?? queued.retryAfterMs ?? QUEUE_BARE_RETRY_MS, pollMs),
					Math.max(0, deadline - now()),
				);
				let status: string | undefined;

				for (;;) {
					if (opts.signal?.aborted) {
						if (queued.requestId) void cancel(opts.token, opts.model, queued.requestId);
						finishError(failed, "aborted", "排队等待已取消");
						return;
					}
					const waitedMs = now() - attemptStart;
					opts.onStatus?.(queueText(opts.model, queued, waitedMs, status));
					if (waitedMs >= targetMs || now() >= deadline) break;
					await wait(Math.min(pollMs, Math.max(0, Math.min(targetMs - waitedMs, deadline - now()))), opts.signal);
					if (!queued.requestId) continue;
					status = await probe(opts.token, opts.model, queued.requestId, opts.signal);
					if (status && !QUEUE_WAITING_STATES.has(status)) break;
				}

				if (opts.signal?.aborted) {
					if (queued.requestId) void cancel(opts.token, opts.model, queued.requestId);
					finishError(failed, "aborted", "排队等待已取消");
					return;
				}
				if (now() >= deadline) {
					const limit = Math.round(maxWaitMs / 1000);
					if (queued.requestId) void cancel(opts.token, opts.model, queued.requestId);
					finishError(
						failed,
						"error",
						`${queueSummary(opts.model, queued)}，已等满 ${limit}s 未放行；稍后重试或换个模型（PI_WB_QUEUE_MAX_WAIT_MS 可调）`,
					);
					return;
				}
				if (process.env.PI_WB_DEBUG) console.error(`[wb] queue retry #${attempts}`, JSON.stringify(queued));
				opts.onStatus?.(undefined);
				// 重发（不再发 start）
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			finishError(partial ?? opts.fallback(), "error", `WorkBuddy 请求失败：${message}`);
		}
	})();

	return out;
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
		// onlyReasoning 的模型连“不发参数”都不行（glm-5.0-turbo 裸请求会 400
		// “reasoning effort value is not supported”），所以 off/minimal/max 也映射到固定档位，
		// 保证永远发得出 reasoning_effort。
		if (model.onlyReasoning) {
			return { off: fixed, minimal: fixed, low: fixed, medium: fixed, high: fixed, xhigh: fixed, max: fixed };
		}
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

/**
 * 模型目录有**两套**，都读一遍取并集：
 * · `/v2/enterprises/personal/models` —— WorkBuddy 个人版目录（含 Auto 三档 快速/均衡/极致）
 * · `/v3/config` —— CodeBuddy 客户端下发配置（含 personal 目录里没有的 glm-5.3-flashx / kimi-k3.1-pro-highspeed 等）
 * 两边都只用 `models` 字段；同一个 id 以 personal 目录为准（字段更全）。
 */
const CATALOG_PATHS = ["/v2/enterprises/personal/models", "/v3/config"];

async function fetchCatalog(token: string, uid: string | undefined, signal: AbortSignal): Promise<WbModel[]> {
	const merged = new Map<string, WbModel>();
	for (const path of CATALOG_PATHS) {
		try {
			const data = await wbRequest<{ models?: WbModel[] }>(path, { token, uid, signal });
			for (const model of Array.isArray(data.models) ? data.models : []) {
				if (model?.id && !merged.has(model.id)) merged.set(model.id, model);
			}
		} catch {
			// 单个目录挂了不影响另一个；两个都挂由调用方回落 FALLBACK_MODELS。
		}
	}
	return [...merged.values()];
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

	const makeStream = () =>
		openAICompletionsApi().streamSimple(outbound, context, {
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

	return streamQueueAware({
		token,
		model: model.id,
		signal: options?.signal,
		makeStream,
		fallback: () => ({
			role: "assistant",
			content: [],
			api: outbound.api,
			provider: outbound.provider,
			model: outbound.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		}),
		// 单独的 key：footer 里的积分由 workbuddy 这条负责，别互相覆盖
		onStatus: (text) => uiContext?.ui.setStatus("workbuddy-queue", text),
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
