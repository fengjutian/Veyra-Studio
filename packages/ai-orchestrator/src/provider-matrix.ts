/**
 * OpenAI 兼容端点的能力矩阵。
 *
 * 只要服务实现了 `/chat/completions`，理论上都能接；但各家在 `response_format`
 * （json_object）、流式、鉴权方式上并不一致。这里把已知服务的差异固化成一份表，
 * 让设置面板能提前告诉用户"这个端点能不能这么用"，而不是等请求失败。
 *
 * 表是人工维护的，依据各服务公开文档；未收录的端点按通用 OpenAI 协议处理，
 * 默认关闭 `jsonMode`（最保守的假设），流式仍然启用。
 */

export type AuthScheme = "bearer" | "none";

export interface ProviderCapabilities {
  /** 支持 `response_format: { type: "json_object" }`。 */
  jsonMode: boolean;
  /** 支持 SSE 流式回复。 */
  stream: boolean;
  auth: AuthScheme;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** 用作匹配前缀的规范地址。 */
  baseUrl: string;
  defaultModel: string;
  capabilities: ProviderCapabilities;
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    capabilities: { jsonMode: true, stream: true, auth: "bearer" },
    note: "官方协议基准实现，json_object 与流式都可用。",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    capabilities: { jsonMode: true, stream: true, auth: "bearer" },
    note: "兼容 OpenAI 协议，支持 json 输出与流式。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    capabilities: { jsonMode: true, stream: true, auth: "bearer" },
    note: "聚合网关；具体模型的 json 能力取决于被路由到的上游。",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5",
    capabilities: { jsonMode: false, stream: true, auth: "none" },
    note: "本地推理，免鉴权；json 模式随模型与版本差异较大，这里按不支持处理。",
  },
  {
    id: "vllm",
    label: "vLLM（本地）",
    baseUrl: "http://localhost:8000/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    capabilities: { jsonMode: false, stream: true, auth: "none" },
    note: "自托管推理；未开启 guided decoding 时不一定遵守 response_format。",
  },
  {
    id: "lmstudio",
    label: "LM Studio（本地）",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    capabilities: { jsonMode: false, stream: true, auth: "none" },
    note: "桌面端本地服务，免鉴权。",
  },
];

/** 未收录端点时的保守默认：不假设支持 json 模式。 */
export const FALLBACK_CAPABILITIES: ProviderCapabilities = { jsonMode: false, stream: true, auth: "bearer" };

export interface ProviderDescription {
  /** 命中的预设 id；未收录时为 "custom"。 */
  id: string;
  label: string;
  matched: boolean;
  capabilities: ProviderCapabilities;
  note: string;
}

/** 地址归一化：小写、去空白、去尾部斜杠，便于前缀匹配。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * 判断一个端点属于哪个已知服务。
 *
 * 用"相同或更深路径"匹配：`https://api.openai.com/v1` 和
 * `https://api.openai.com/v1/` 都命中 openai，`.../v1/proxy` 也算——很多网关
 * 会在官方路径后面挂一层代理。
 */
export function matchProvider(baseUrl: string): ProviderPreset | undefined {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return undefined;
  return PROVIDER_PRESETS
    .filter(preset => target === preset.baseUrl || target.startsWith(`${preset.baseUrl}/`))
    // 更长的前缀优先，避免 "/v1" 抢走更具体的地址。
    .sort((left, right) => right.baseUrl.length - left.baseUrl.length)[0];
}

/** 给设置面板用的描述：命中了就报服务名，没命中就说"按通用协议处理"。 */
export function describeProvider(baseUrl: string): ProviderDescription {
  const preset = matchProvider(baseUrl);
  if (!preset) {
    return {
      id: "custom",
      label: "未收录的兼容端点",
      matched: false,
      capabilities: FALLBACK_CAPABILITIES,
      note: "按通用 OpenAI 协议处理：默认关闭 json 模式、保留流式；实际能力以服务端为准。",
    };
  }
  return { id: preset.id, label: preset.label, matched: true, capabilities: preset.capabilities, note: preset.note };
}

/** 能力的中文标签，面板和文档共用一个口径。 */
export function capabilityLabels(capabilities: ProviderCapabilities): string[] {
  return [
    capabilities.stream ? "流式" : "非流式",
    capabilities.jsonMode ? "JSON 模式" : "纯文本输出",
    capabilities.auth === "bearer" ? "Bearer 鉴权" : "免鉴权",
  ];
}
