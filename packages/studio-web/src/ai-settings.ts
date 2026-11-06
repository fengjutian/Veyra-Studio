/**
 * AI 模型设置。
 *
 * 分成两份存：
 * - 非敏感配置（是否启用、端点、模型名）落在 `localStorage`，刷新后还在；
 * - **API Key 只写 `sessionStorage`**，关掉标签页就失效。密钥不写进设计文档、
 *   不进 IndexedDB、不会被导出带走，也不会在磁盘上留副本。
 *
 * 早期版本把密钥一起写进了 localStorage。读取时会把旧记录里的密钥挪到会话存储、
 * 并把磁盘那份里的密钥抹掉，用户不需要手动清理。
 */
export interface AiSettings {
  /** 是否启用真实模型；关闭时退回演示规划器 */
  enabled: boolean;
  /** OpenAI 兼容端点的基础地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** 可选：本地模型或免鉴权网关可以留空。只存在当前会话里。 */
  apiKey: string;
}

/** 只用到这三个方法，方便在没有 DOM 的环境里测试。 */
export interface AiSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AI_SETTINGS_KEY = "studio:ai-settings";
/** 密钥单独一个键，只放在 sessionStorage。 */
export const AI_SETTINGS_SESSION_KEY = "studio:ai-settings:session";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
};

/** 没有 sessionStorage 时的兜底：密钥只活在当前页面内存里。 */
const memorySession = new Map<string, string>();
const memorySessionStorage: AiSettingsStorage = {
  getItem: key => memorySession.get(key) ?? null,
  setItem: (key, value) => { memorySession.set(key, value); },
  removeItem: key => { memorySession.delete(key); },
};

export function readAiSettings(persistent?: AiSettingsStorage, session?: AiSettingsStorage): AiSettings {
  const store = resolvePersistent(persistent);
  const secrets = resolveSession(session);
  const settings = { ...DEFAULT_AI_SETTINGS };
  let legacyKey = "";

  if (store) {
    try {
      const raw = store.getItem(AI_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AiSettings>;
        settings.enabled = parsed.enabled === true;
        settings.baseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_AI_SETTINGS.baseUrl;
        settings.model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AI_SETTINGS.model;
        if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
          legacyKey = parsed.apiKey.trim();
          // 迁移：旧版密钥挪进会话存储，并把磁盘副本里的密钥抹掉。
          if (secrets && !secrets.getItem(AI_SETTINGS_SESSION_KEY)) secrets.setItem(AI_SETTINGS_SESSION_KEY, legacyKey);
          persistConfig(store, settings);
        }
      }
    } catch {
      return { ...DEFAULT_AI_SETTINGS };
    }
  }

  const sessionKey = secrets?.getItem(AI_SETTINGS_SESSION_KEY) ?? "";
  return { ...settings, apiKey: sessionKey || legacyKey };
}

export function writeAiSettings(settings: AiSettings, persistent?: AiSettingsStorage, session?: AiSettingsStorage): void {
  const store = resolvePersistent(persistent);
  const secrets = resolveSession(session);
  if (store) persistConfig(store, settings);
  const key = settings.apiKey.trim();
  if (!secrets) return;
  if (key) secrets.setItem(AI_SETTINGS_SESSION_KEY, key);
  else secrets.removeItem(AI_SETTINGS_SESSION_KEY);
}

export function clearAiSettings(persistent?: AiSettingsStorage, session?: AiSettingsStorage): void {
  resolvePersistent(persistent)?.removeItem(AI_SETTINGS_KEY);
  resolveSession(session)?.removeItem(AI_SETTINGS_SESSION_KEY);
}

/** 是否可以调用真实模型：必须显式启用，并且地址和模型名都填了。 */
export function aiSettingsComplete(settings: AiSettings): boolean {
  return settings.enabled === true && Boolean(settings.baseUrl.trim() && settings.model.trim());
}

/** 只把非敏感字段写回持久存储。调用方保证这里不会出现密钥。 */
function persistConfig(store: AiSettingsStorage, settings: AiSettings): void {
  store.setItem(AI_SETTINGS_KEY, JSON.stringify({
    enabled: settings.enabled === true,
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
  }));
}

function resolvePersistent(storage?: AiSettingsStorage): AiSettingsStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: AiSettingsStorage }).localStorage;
  } catch {
    return undefined;
  }
}

function resolveSession(storage?: AiSettingsStorage): AiSettingsStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { sessionStorage?: AiSettingsStorage }).sessionStorage ?? memorySessionStorage;
  } catch {
    return memorySessionStorage;
  }
}
