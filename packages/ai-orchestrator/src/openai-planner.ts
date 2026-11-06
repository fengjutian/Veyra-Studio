import { parsePlanResponse } from "./plan-parser";
import { buildPlannerPrompt } from "./prompt";
import type { AbortSignalLike, AiCommandPlan, AiPlanRequest, AiPlanner } from "./safe-ai-editor";

export interface StreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** 流式响应体；网关支持 SSE 时会给出。 */
  body?: { getReader(): StreamReaderLike } | null;
}

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** 请求超时。和普通失败区分开，界面可以提示"调大超时"而不是"服务坏了"。 */
export class AiTimeoutError extends AiProviderError {
  constructor(readonly timeoutMs: number) {
    super(`模型服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`);
    this.name = "AiTimeoutError";
  }
}

/** 用户主动取消。不算错误，界面只说"已取消"。 */
export class AiCancelledError extends AiProviderError {
  constructor() {
    super("已取消本次 AI 请求");
    this.name = "AiCancelledError";
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
  /** 用 SSE 流式接收回复；每段增量通过 `request.onDelta` 回调。 */
  stream?: boolean;
  timeoutMs?: number;
  /** 失败后最多再试几次（只对网络错误、408/429/5xx 生效）。默认 2。 */
  retries?: number;
  /** 重试退避的起点，按 2 的倍数增长；测试里传 0 可以跳过等待。 */
  retryDelayMs?: number;
  /** 默认取消信号；单次 plan 也可以用 request.signal 覆盖。 */
  signal?: AbortSignalLike;
  /** 附加请求头，例如代理网关的自定义认证头 */
  headers?: Record<string, string>;
}

/**
 * 面向 OpenAI 兼容接口的 Planner。
 *
 * 端点固定是 `{baseUrl}/chat/completions`，因此任何提供这套协议的网关（云厂商、
 * 本地推理服务、自建代理）都能直接用，不需要为每家单独写适配器。
 *
 * 失败处理分三类：网络错误与 408/429/5xx 按指数退避重试；超时抛
 * `AiTimeoutError`；用户取消抛 `AiCancelledError`。后两者都不重试——重试一个
 * 已经超时或已取消的请求只会让用户多等一倍。
 */
export function createOpenAiCompatiblePlanner(options: OpenAiCompatiblePlannerOptions): AiPlanner {
  const baseUrl = options.baseUrl.trim();
  const model = options.model.trim();
  if (!baseUrl) throw new Error("AI 服务地址不能为空");
  if (!model) throw new Error("AI 模型名不能为空");
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);

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
      if (options.stream) body.stream = true;

      const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
      if (options.apiKey?.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`;

      const signal = request.signal ?? options.signal;
      const { raw, content } = await post(endpoint, headers, body, options, retries, retryDelayMs, signal, request.onDelta);
      return parsePlanResponse(content ?? extractContent(raw));
    },
  };
}

interface PostResult {
  /** 非流式响应的原始 JSON。 */
  raw: string;
  /** 流式响应累积出来的回复文本。 */
  content?: string;
}

async function post(
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: OpenAiCompatiblePlannerOptions,
  retries: number,
  retryDelayMs: number,
  signal: AbortSignalLike | undefined,
  onDelta: ((delta: string, fullText: string) => void) | undefined,
): Promise<PostResult> {
  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  if (!fetchImpl) throw new AiProviderError("当前环境没有可用的 fetch，无法调用模型服务");
  // 已经吐出增量的请求不能重试：重试会让用户看到重复的半截内容。
  const state = { emitted: false };
  const handleDelta = onDelta ? (delta: string, fullText: string) => { state.emitted = true; onDelta(delta, fullText); } : undefined;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await postOnce(fetchImpl, endpoint, headers, body, options, signal, handleDelta, state);
    } catch (error) {
      const canRetry = error instanceof AiProviderError && error.retryable && attempt < retries && !state.emitted;
      if (!canRetry) throw error;
      await wait(retryDelayMs * 2 ** attempt, signal);
    }
  }
}

async function postOnce(
  fetchImpl: FetchLike,
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: OpenAiCompatiblePlannerOptions,
  signal: AbortSignalLike | undefined,
  onDelta: ((delta: string, fullText: string) => void) | undefined,
  state: { emitted: boolean },
): Promise<PostResult> {
  if (signal?.aborted) throw new AiCancelledError();
  const controller = resolveAbortController();
  const timeoutMs = options.timeoutMs ?? 60000;
  let timedOut = false;
  const onAbort = () => controller?.abort();
  signal?.addEventListener?.("abort", onAbort);
  const timeout = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;

  let response: FetchResponseLike;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AiCancelledError();
    if (timedOut) throw new AiTimeoutError(timeoutMs);
    // 网络层错误通常是瞬时的，值得重试。
    throw new AiProviderError(`调用模型服务失败：${describeError(error)}`, undefined, true);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new AiProviderError(`模型服务返回 ${response.status}：${raw.slice(0, 300)}`, response.status, isRetryableStatus(response.status));
  }

  if (options.stream && response.body) {
    try {
      const content = await readSse(response.body, onDelta);
      return { raw: "", content };
    } catch (error) {
      if (signal?.aborted) throw new AiCancelledError();
      if (timedOut) throw new AiTimeoutError(timeoutMs);
      throw new AiProviderError(`读取模型响应失败：${describeError(error)}`, response.status, !state.emitted);
    }
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new AiCancelledError();
    if (timedOut) throw new AiTimeoutError(timeoutMs);
    throw new AiProviderError(`读取模型响应失败：${describeError(error)}`, response.status, true);
  }
  return { raw };
}

/**
 * 读取 SSE 流并拼出完整回复。
 *
 * 只认 `data:` 行；`[DONE]` 之后的内容一律忽略。无法解析的行跳过而不是报错——
 * 不同网关会插入自己的事件（注释、心跳），一条不认识的事件不该毁掉整次生成。
 */
async function readSse(body: { getReader(): StreamReaderLike }, onDelta: ((delta: string, fullText: string) => void) | undefined): Promise<string> {
  const Decoder = (globalThis as { TextDecoder?: new () => { decode(input?: Uint8Array, options?: { stream?: boolean }): string } }).TextDecoder;
  if (!Decoder) throw new AiProviderError("当前环境不支持流式解码（缺少 TextDecoder）");
  const decoder = new Decoder();
  const reader = body.getReader();
  let buffer = "";
  let content = "";
  let done = false;

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const delta = deltaContent(payload);
    if (!delta) return;
    content += delta;
    onDelta?.(delta, content);
  };

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);
  return content;
}

/** 从一条 SSE 事件的 JSON 里取出增量文本。 */
function deltaContent(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const choice = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || !choice.length) return undefined;
  const first = choice[0] as { delta?: { content?: unknown }; message?: { content?: unknown }; text?: unknown };
  const content = first.delta?.content ?? first.message?.content ?? first.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined))
      .filter((part): part is string => typeof part === "string")
      .join("");
  }
  return undefined;
}

/** 只有这些状态码值得重试：限流、超时和上游故障。4xx 是请求本身的问题，重试没用。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 退避等待；等待期间被取消就立刻结束，不再发起下一次请求。 */
function wait(ms: number, signal: AbortSignalLike | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new AiCancelledError()); return; }
    if (ms <= 0) { resolve(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(new AiCancelledError());
    };
    signal?.addEventListener?.("abort", onAbort);
  });
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
