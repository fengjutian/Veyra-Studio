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

/**
 * 规划器的默认单次请求超时。
 *
 * 300 秒而不是 60 秒：带推理的模型出「整页计划」时，**光思考阶段就可能好几分钟**
 * （实测首字延迟 270 秒，正文只占 30 秒）。60 秒的默认会让这类请求必然超时，
 * 而超时之后重试只会再等一轮——预算不够这件事该在默认值上解决。
 */
const DEFAULT_TIMEOUT_MS = 300_000;

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
  /**
   * 密钥环：多把密钥轮换用。
   *
   * 给了它就按环来用：请求遇到 401/403（密钥过期、被吊销、额度用尽）时**自动**
   * 换下一把重试，而不是整个失败。轮换是密钥生命周期管理的一部分——服务端
   * 换密钥不应该让客户端当场罢工。
   */
  apiKeys?: readonly string[];
  /**
   * 环的起点：先用哪一把。
   *
   * 界面上「当前使用第几把」必须真的生效——不给这个值的话环永远从第一把开始，
   * 用户手动切到第 3 把也不起作用。下标按环的顺序算（也就是 `apiKeys` 的顺序）。
   */
  apiKeyIndex?: number;
  /** 鉴权失败换钥时回调：界面可以提示「已切到第 2 把密钥」。 */
  onKeyRotated?(index: number, total: number, reason: string): void;
  /** 注入 fetch 便于测试；默认用全局 fetch */
  fetch?: FetchLike;
  /** 覆盖默认 system 提示 */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 打开后请求会带 response_format: json_object，部分兼容服务不支持 */
  jsonMode?: boolean;
  /**
   * 模型的思考开关（只有支持该参数的端点认）。
   *
   * 为什么需要它：**带推理的模型默认会先思考再回答**，而思考本身要花掉大量 token
   * 与时间。实测 MiniMax-M3 出一份「整页后台管理端」计划：思考开着时 338 秒还没写完
   * JSON（token 预算被打爆，解析器只能报「计划缺少 summary」），关掉之后 **12 秒** 写完。
   *
   * 取值与 MiniMax 开放平台一致：`adaptive`（自适应思考）、`disabled`（不思考）。
   * 不传这个参数就不带 `thinking` 字段，走端点自己的默认行为。
   */
  thinking?: { type: "adaptive" | "disabled"; budgetTokens?: number };
  /** 用 SSE 流式接收回复；每段增量通过 `request.onDelta` 回调。 */
  stream?: boolean;
  /**
   * 单次请求的超时（毫秒）。默认 300 秒。
   *
   * 为什么不是 60 秒：**带推理的模型（MiniMax-M3 / M3.1-Flash 等）出一份整页计划，
   * 思考阶段本身就要好几分钟**。实测同一份「整页后台管理端」提示，
   * 首字延迟就到 270 秒、之后正文只花 30 秒——60 秒的默认会让「从零生成一页」
   * 在真实产品里必然超时：短问短答够用，整页计划不够。
   */
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
  // 密钥环：给 apiKeys 就按环用；只给 apiKey 就当环里的一把。
  const ring: KeyRing = { keys: collectKeys(options), index: 0 };
  // 环的起点按用户选中的那把算（越界就夹回第一把）。
  if (ring.keys.length) ring.index = Math.min(Math.max(0, Math.trunc(options.apiKeyIndex ?? 0)), ring.keys.length - 1);

  return {
    async plan(request: AiPlanRequest): Promise<AiCommandPlan> {
      const prompt = buildPlannerPrompt(request);
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: options.systemPrompt ?? prompt.system },
          { role: "user", content: userContent(prompt.user, request.image) },
        ],
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
      if (options.jsonMode) body.response_format = { type: "json_object" };
      if (options.thinking) {
        body.thinking = {
          type: options.thinking.type,
          ...(options.thinking.budgetTokens !== undefined ? { budget_tokens: options.thinking.budgetTokens } : {}),
        };
      }
      if (options.stream) body.stream = true;

      const signal = request.signal ?? options.signal;
      const { raw, content } = await post(endpoint, ring, body, options, retries, retryDelayMs, signal, request.onDelta);
      return parsePlanResponse(content ?? extractContent(raw));
    },
  };
}

/**
 * user 段的内容。
 *
 * 有图时按 OpenAI 兼容的多模态格式发：`content` 从字符串变成**内容块数组**，
 * 文本块在前、图片块在后。没有这一步，图根本发不出去——`content` 只能是
 * 字符串的端点会直接报错。
 */
function userContent(text: string, image: AiPlanRequest["image"]): unknown {
  if (!image) return text;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: image.dataUrl } },
  ];
}

/** 密钥环：当前用哪一把，以及环里的全部密钥。 */
interface KeyRing {
  keys: string[];
  index: number;
}

/**
 * 收集要用的密钥。
 *
 * `apiKeys` 是环；`apiKey` 是「当前这把」，它不在环里就放第一位（在环里就
 * 不重复）。去重、去掉空串——免得环里混进一个空密钥导致无意义的换钥。
 */
function collectKeys(options: OpenAiCompatiblePlannerOptions): string[] {
  const ring = [...(options.apiKeys ?? [])];
  const single = options.apiKey?.trim();
  if (single && !ring.includes(single)) ring.unshift(single);
  return ring.map(key => key.trim()).filter((key, index, all) => key.length > 0 && all.indexOf(key) === index);
}

/** 按当前密钥拼请求头。 */
function headersFor(key: string | undefined, options: OpenAiCompatiblePlannerOptions): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  if (key?.trim()) headers.Authorization = `Bearer ${key.trim()}`;
  return headers;
}

interface PostResult {
  /** 非流式响应的原始 JSON。 */
  raw: string;
  /** 流式响应累积出来的回复文本。 */
  content?: string;
}

async function post(
  endpoint: string,
  ring: KeyRing,
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

  // 网络重试与换钥是两套预算：换钥不消耗网络重试次数，反之亦然。
  let networkRetries = 0;
  let keyOffset = 0;
  for (;;) {
    const key = ring.keys.length ? ring.keys[(ring.index + keyOffset) % ring.keys.length] : undefined;
    try {
      const result = await postOnce(fetchImpl, endpoint, headersFor(key, options), body, options, signal, handleDelta, state);
      // 请求成功了：记住这次用的是哪一把，下次接着用。
      if (ring.keys.length) ring.index = (ring.index + keyOffset) % ring.keys.length;
      return result;
    } catch (error) {
      // 鉴权失败：换下一把密钥再试。环里的密钥都用过还不行，就把错误抛出去。
      const authFailure = error instanceof AiProviderError && (error.status === 401 || error.status === 403);
      if (authFailure && keyOffset + 1 < ring.keys.length) {
        keyOffset += 1;
        const nextIndex = (ring.index + keyOffset) % ring.keys.length;
        options.onKeyRotated?.(nextIndex, ring.keys.length, `鉴权失败（HTTP ${error.status}），已切到第 ${nextIndex + 1} 把密钥`);
        continue;
      }
      const canRetry = error instanceof AiProviderError && error.retryable && networkRetries < retries && !state.emitted;
      if (!canRetry) throw error;
      await wait(retryDelayMs * 2 ** networkRetries, signal);
      networkRetries += 1;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
    if (signal?.aborted) throw new AiCancelledError();
    if (timedOut) throw new AiTimeoutError(timeoutMs);
    // 网络层错误通常是瞬时的，值得重试。
    throw new AiProviderError(`调用模型服务失败：${describeError(error)}`, undefined, true);
  }

  // 超时与取消监听要一直保留到响应体读完：流式响应在头部返回之后才传输正文，
  // 提前清理会让"中途取消/超时"永远等不到 abort，界面就一直卡在生成中。
  try {
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      throw new AiProviderError(`模型服务返回 ${response.status}：${raw.slice(0, 300)}`, response.status, isRetryableStatus(response.status));
    }

    if (options.stream && response.body) {
      const content = await readSse(response.body, onDelta);
      return { raw: "", content };
    }

    const raw = await response.text();
    return { raw };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (signal?.aborted) throw new AiCancelledError();
    if (timedOut) throw new AiTimeoutError(timeoutMs);
    throw new AiProviderError(`读取模型响应失败：${describeError(error)}`, response.status, !state.emitted);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }
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

  while (true) {
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
