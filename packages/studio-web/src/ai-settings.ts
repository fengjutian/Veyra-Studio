/**
 * AI 模型设置。
 *
 * 设置只存在浏览器 localStorage：不会写进设计文档、不会进 IndexedDB 事务日志、
 * 也不会被导出带走。仓库里不保存任何外部服务账号。
 */
export interface AiSettings {
  /** 是否启用真实模型；关闭时退回演示规划器 */
  enabled: boolean;
  /** OpenAI 兼容端点的基础地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** 可选：本地模型或免鉴权网关可以留空 */
  apiKey: string;
}

/** 只用到 localStorage 的三个方法，方便在没有 DOM 的环境里测试。 */
export interface AiSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AI_SETTINGS_KEY = "studio:ai-settings";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
};

export function readAiSettings(storage?: AiSettingsStorage): AiSettings {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = store.getItem(AI_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      enabled: parsed.enabled === true,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_AI_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AI_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function writeAiSettings(settings: AiSettings, storage?: AiSettingsStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  store.setItem(AI_SETTINGS_KEY, JSON.stringify({
    enabled: settings.enabled === true,
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
    apiKey: settings.apiKey.trim(),
  }));
}

export function clearAiSettings(storage?: AiSettingsStorage): void {
  resolveStorage(storage)?.removeItem(AI_SETTINGS_KEY);
}

/** 是否可以调用真实模型：必须显式启用，并且地址和模型名都填了。 */
export function aiSettingsComplete(settings: AiSettings): boolean {
  return settings.enabled === true && Boolean(settings.baseUrl.trim() && settings.model.trim());
}

function resolveStorage(storage?: AiSettingsStorage): AiSettingsStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: AiSettingsStorage }).localStorage;
  } catch {
    return undefined;
  }
}
