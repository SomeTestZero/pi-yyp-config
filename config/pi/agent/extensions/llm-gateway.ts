/**
 * LLM 网关 Provider 扩展（OpenAI 兼容端点）
 *
 * 端点形式：
 *   POST http://10.105.1.5:4001/v1/chat/completions
 *   Authorization: Bearer <YOUR_API_KEY>
 *
 * 使用方法：
 *   1. 保存本文件后重启 pi（或运行 /reload）
 *   2. 运行 /login neu-llm-gateway  （或在 /login 列表中选中 "NEU LLM Gateway"）输入 API Key，
 *      Key 会保存在 ~/.pi/agent/auth.json，之后无需重复输入
 *   3. 也可以不登录，改用环境变量： set LLM_GATEWAY_API_KEY=sk-xxx
 *   4. /model 中选择模型，或命令行： pi --model neu-llm-gateway/qwen3.6-27b
 *
 * 登出： /logout neu-llm-gateway
 *
 * 常见网关后端与 thinking 参数对照（如果请求报错，改这里）：
 *   - LiteLLM 转发到 DeepSeek 官方 API ： thinkingFormat: "deepseek"（发送 thinking:{type:"enabled"/"disabled"}）
 *   - LiteLLM 转发到 DashScope Qwen   ： thinkingFormat: "qwen"（发送顶层 enable_thinking）
 *   - vLLM 本地推理 Qwen3              ： thinkingFormat: "qwen-chat-template"（发送 chat_template_kwargs.enable_thinking）
 *   - vLLM 本地推理 DeepSeek           ： thinkingFormat: "chat-template"
 *   - 网关不支持任何 thinking 参数时   ：把对应模型的 reasoning 设为 false（模型返回的 reasoning_content 仍会正常显示）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// 可配置项
// =============================================================================

/** 网关地址（OpenAI 兼容，SDK 会自动拼接 /chat/completions） */
const GATEWAY_BASE_URL = "http://10.105.1.5:4001/v1";

/** Provider ID（/login、/model、--model 都使用这个名字） */
const PROVIDER_ID = "neu-llm-gateway";

/**
 * 模型列表。
 * reasoning: true 时 pi 会根据 thinkingFormat 发送思考开关参数；
 * reasoning: false 时不发送任何 thinking 参数（最稳妥，模型若返回
 * reasoning_content 流仍然会被 pi 识别并展示）。
 */
const MODELS = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "qwen3.6-27b",
    name: "Qwen3.6 27B",
    reasoning: true,
    thinkingFormat: "qwen" as const, // 可改为 "qwen-chat-template"（vLLM）
    contextWindow: 131072,
    maxTokens: 16384,
  },
  {
    id: "qwen3.6-35b-a3b",
    name: "Qwen3.6 35B-A3B",
    reasoning: true,
    thinkingFormat: "qwen" as const, // 可改为 "qwen-chat-template"（vLLM）
    contextWindow: 131072,
    maxTokens: 16384,
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    reasoning: true,
    thinkingFormat: "qwen" as const, // 可改为 "qwen-chat-template"（vLLM）
    contextWindow: 131072,
    maxTokens: 16384,
  },
  {
    id: "moma_deepseek-v4-flash",
    name: "MoMA DeepSeek V4 Flash",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 8192,
  },
];

// =============================================================================
// 注册 Provider
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "NEU LLM Gateway (10.105.1.5:4001)",
    baseUrl: GATEWAY_BASE_URL,
    api: "openai-completions",

    // 环境变量兜底：未通过 /login 保存 Key 时读取 $LLM_GATEWAY_API_KEY。
    // 保存过 /login 的 Key 时，以 auth.json 中的为准。
    apiKey: "$LLM_GATEWAY_API_KEY",

    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: {
        // 多数自建网关不接受 developer 角色，统一用 system
        supportsDeveloperRole: false,
        // 不发送 reasoning_effort，避免与 thinking 开关冲突
        supportsReasoningEffort: false,
        // 老版本网关不一定支持 max_completion_tokens
        maxTokensField: "max_tokens",
        // 思考开关的序列化方式（见文件顶部注释）
        ...(m.reasoning && "thinkingFormat" in m && m.thinkingFormat
          ? { thinkingFormat: m.thinkingFormat }
          : {}),
      },
    })),
  });
}
