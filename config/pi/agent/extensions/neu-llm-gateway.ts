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
 *   4. /model 中选择模型，或命令行： pi --model neu-llm-gateway/qwen3.8-27b
 *
 * 登出： /logout neu-llm-gateway
 *
 * ============================================================================
 * 网关实况（实测于 LiteLLM 1.97.0 @ 10.105.1.5:4001）
 * ============================================================================
 * 模型清单以 GET /v1/models 为准，当前 8 个：7 个对话模型 + 1 个 rerank。
 * bge-reranker-v2-m3 走 /v1/rerank，不是对话模型，本扩展不注册。
 *
 * 上游节点（GET /model/info 可见）与上下文：
 *   qwen3.8-27b              → vLLM 10.105.1.154/155 + 10.33.52.10/11/12  256K (max_model_len=262144)
 *   qwen3.8-flash-next       → vLLM 10.105.1.151/152/153                   256K
 *   qwen3.6-35b-a3b          → vLLM 10.105.1.157                           256K
 *   qwen3.6-35b-a3b-showcase → vLLM 10.105.1.154                           256K
 *   moma_deepseek-v4-flash   → 移动云 tokenplan (zhenze-huhehaote.cmecloud.cn)  1M (1048576)
 *   moma_deepseek-v4.1-flash → 移动云 tokenplan                                1M
 *   moma_glm-5.3             → 移动云 tokenplan                                1M
 * 网关配置里仍有 deepseek-v4-flash / qwen3.6-27b，但已被屏蔽（403 Model is blocked），不注册。
 *
 * 思考开关 / 思考强度（全部实测，2026-09-17）：
 *   · Qwen 系（qwen3.8-* / qwen3.6-*）：只有 chat_template_kwargs.enable_thinking
 *     能开关思考；顶层 enable_thinking、reasoning_effort、thinking:{type}、
 *     thinking_budget / thinking_token_budget 一律被上游忽略。
 *     qwen3.8 默认思考开；qwen3.6-35b-a3b(-showcase) 默认思考关，需显式打开。
 *     档位实际只有 关/开，故用 "qwen-chat-template" 且 thinkingLevelMap 只留
 *     off + high（选 low/medium 会被 pi 收敛到这两档）。
 *   · moma_deepseek-*：enable_thinking 开关思考（默认开）；reasoning_effort 无效；
 *     顶层 thinking_token_budget 是精确的思考预算上限（发 64 就恰好只思考 64 token），
 *     故配 thinkingTokenBudgetField，配合 settings.json 的 thinkingBudgets 使用，例如：
 *       "thinkingBudgets": { "low": 2048, "high": 16384 }
 *     未配置 thinkingBudgets 时即为纯 关/开。
 *   · moma_glm-5.3：思考关不掉——enable_thinking=false 不会停思考，反而把思考内容
 *     漏进正文；任何 thinking 参数都不发最稳妥（不设 thinkingFormat），
 *     thinkingLevelMap 把 off 置 null。
 *
 * 其它上游兼容性（均为这些上游的共性）：
 *   - 上游不识 developer 角色 → supportsDeveloperRole: false（用 system）
 *   - reasoning_effort 均无效 → supportsReasoningEffort: false
 *   - 老网关只认 max_tokens → maxTokensField: "max_tokens"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// 可配置项
// =============================================================================

/** 网关地址（OpenAI 兼容，SDK 会自动拼接 /chat/completions） */
const GATEWAY_BASE_URL = "http://10.105.1.5:4001/v1";

/** Provider ID（/login、/model、--model 都使用这个名字） */
const PROVIDER_ID = "neu-llm-gateway";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ModelDef {
  id: string;
  name: string;
  /** true 时 pi 按 thinkingFormat 发送思考参数；false 时不发（最稳妥） */
  reasoning: boolean;
  /**
   * 思考开关的序列化方式：
   *   - "qwen-chat-template"：chat_template_kwargs.enable_thinking（本网关 vLLM 系唯一有效的方式）
   *   - 不设置：不发送任何思考参数（适用于思考关不掉的模型）
   */
  thinkingFormat?: "qwen" | "qwen-chat-template" | "chat-template" | "deepseek";
  /** 顶层思考预算字段；配套 settings.json 的 thinkingBudgets 生效 */
  thinkingTokenBudgetField?: "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";
  /** 支持的思考档位；null 表示该档不支持（UI 中隐藏） */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  contextWindow: number;
  maxTokens: number;
}

/**
 * 模型列表（与 GET /v1/models 的 7 个对话模型一一对应）。
 * 上下文为上游实测值；maxTokens 为输出上限，pi 会再按剩余上下文自动收紧。
 */
const MODELS: ModelDef[] = [
  // ── 内网 vLLM · Qwen3.8：256K 上下文，默认思考开，只有 关/开 两档 ──
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "qwen3.8-flash-next",
    name: "Qwen3.8 Flash Next",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    contextWindow: 262144,
    maxTokens: 32768,
  },

  // ── 内网 vLLM · Qwen3.6 35B-A3B：256K，默认思考关，enable_thinking=true 打开 ──
  {
    id: "qwen3.6-35b-a3b",
    name: "Qwen3.6 35B-A3B",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "qwen3.6-35b-a3b-showcase",
    name: "Qwen3.6 35B-A3B Showcase",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
    contextWindow: 262144,
    maxTokens: 32768,
  },

  // ── 移动云 tokenplan · MoMA DeepSeek：1M 上下文，思考可开关 + 预算上限 ──
  {
    id: "moma_deepseek-v4-flash",
    name: "MoMA DeepSeek V4 Flash",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingTokenBudgetField: "thinking_token_budget",
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "moma_deepseek-v4.1-flash",
    name: "MoMA DeepSeek V4.1 Flash",
    reasoning: true,
    thinkingFormat: "qwen-chat-template",
    thinkingTokenBudgetField: "thinking_token_budget",
    contextWindow: 1048576,
    maxTokens: 65536,
  },

  // ── 移动云 tokenplan · MoMA GLM-5.3：1M 上下文，思考关不掉 ──
  {
    id: "moma_glm-5.3",
    name: "MoMA GLM-5.3",
    reasoning: true,
    thinkingLevelMap: { off: null },
    contextWindow: 1048576,
    maxTokens: 65536,
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
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      compat: {
        // 多数自建网关不接受 developer 角色，统一用 system
        supportsDeveloperRole: false,
        // 不发送 reasoning_effort，避免与 thinking 开关冲突
        supportsReasoningEffort: false,
        // 老版本网关不一定支持 max_completion_tokens
        maxTokensField: "max_tokens",
        // 思考开关的序列化方式（见文件顶部注释）
        ...(m.thinkingFormat ? { thinkingFormat: m.thinkingFormat } : {}),
        // 思考预算字段（仅上游确实支持的模型才设置）
        ...(m.thinkingTokenBudgetField ? { thinkingTokenBudgetField: m.thinkingTokenBudgetField } : {}),
      },
    })),
  });
}
