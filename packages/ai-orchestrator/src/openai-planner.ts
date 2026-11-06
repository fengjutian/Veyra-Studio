import { parsePlanResponse } from "./plan-parser";
import { buildPlannerPrompt } from "./prompt";
import type { AiCommandPlan, AiPlanRequest, AiPlanner } from "./safe-ai-editor";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface OpenAiCompatiblePlannerOptions {
  /** OpenAI 兼容端点的基础地址，例如 https://api.openai.com/v1 或 http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  /** 可选：本地模型或免鉴权网关可以留空 */
  apiKey?: string;
  /** 注入 fetch 便于测试；默认用全局 fetch */
  fetch?: FetchLike;
  /** 覆盖默认 system 提示 */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 打开后请求会带 response_format: json_object，部分兼容服务不支持 */
  jsonMode?: boolean;
  timeoutMs?: number;
  /** 附加请求头，例如代理网关的自定义认证头 */
  headers?: Record<string, string>;
}

/**
 * 面向 OpenAI 兼容接口的 Planner。
 *
 * 端点固定是 `{baseUrl}/chat/completions`，因此任何提供这套协议的网关（云厂商、
 * 本地推理服务、自建代理）都能直接用，不需要为每家单独写适配器。
 */
export function createOpenAiCompatiblePlanner(options: OpenAiCompatiblePlannerOptions): AiPlanner {
  const baseUrl = options.baseUrl.trim();
  const model = options.model.trim();
  if (!baseUrl) throw new Error("AI 服务地址不能为空");
  if (!model) throw new Error("AI 模型名不能为空");
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async plan(request: AiPlanRequest): Promise<AiCommandPlan> {
      const prompt = buildPlannerPrompt(request);
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: options.systemPrompt ?? prompt.system },
          { role: "user", content: prompt.user },
        ],
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
      if (options.jsonMode) body.response_format = { type: "json_object" };

      const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
      if (options.apiKey?.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`;

      const raw = await post(endpoint, headers, body, options);
      const content = extractContent(raw);
      return parsePlanResponse(content);
    },
  };
}

async function post(endpoint: string, headers: Record<string, string>, body: Record<string, unknown>, options: OpenAiCompatiblePlannerOptions): Promise<string> {
  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  if (!fetchImpl) throw new AiProviderError("当前环境没有可用的 fetch，无法调用模型服务");

  const controller = resolveAbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 60000) : undefined;
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error) {
    throw new AiProviderError(`调用模型服务失败：${describeError(error)}`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const raw = await response.text();
  if (!response.ok) throw new AiProviderError(`模型服务返回 ${response.status}：${raw.slice(0, 300)}`, response.status);
  return raw;
}

function extractContent(raw: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AiProviderError(`模型服务返回的不是合法 JSON：${describeError(error)}`);
  }
  if (typeof payload !== "object" || payload === null) throw new AiProviderError("模型服务返回的不是 JSON 对象");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) throw new AiProviderError("模型服务返回里没有 choices");
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map(part => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === "string")
      .join("");
    if (text.trim()) return text;
  }
  throw new AiProviderError("模型服务返回里没有可用的回复内容");
}

interface AbortControllerLike {
  signal: unknown;
  abort(): void;
}

function resolveAbortController(): AbortControllerLike | undefined {
  const ctor = (globalThis as { AbortController?: new () => AbortControllerLike }).AbortController;
  return ctor ? new ctor() : undefined;
}

function resolveGlobalFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as unknown as FetchLike) : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" ? "请求超时" : error.message;
  return String(error);
}
