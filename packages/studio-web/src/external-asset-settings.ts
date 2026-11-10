/**
 * 外部素材服务的工作台设置。
 *
 * 分成三份：
 * - **服务清单**（`localStorage`）：有哪些外部素材服务、地址模板是什么。
 * - **退出清单**（`localStorage`）：用户明确退出了哪些服务。退出之后不再向它发请求，
 *   但已经缓存进项目的素材仍然可用——退出不该毁掉已有设计。
 * - **授权头**（`sessionStorage`）：服务要的令牌。它跟 AI 密钥一个待遇：只活在本次
 *   会话，不落盘、不进文档、不进备份。
 *
 * 密钥之所以不放 `localStorage`：磁盘上的明文令牌等于长期有效的凭证，
 * 而服务令牌通常和账号绑定，泄露的代价比模型密钥还大。
 */

/** 只用到这三个方法，方便在没有 DOM 的环境里测试。 */
export interface ExternalAssetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 一个外部素材服务的配置。 */
export interface ExternalAssetProviderConfig {
  /** 服务标识；与素材 id 一起构成缓存键。 */
  id: string;
  /** 面板上的显示名。 */
  label: string;
  /** 取素材的地址模板，`{id}` 会被替换成编码后的素材 id。 */
  urlTemplate: string;
  /** 该服务是否要求交付物里带上归因。 */
  requiresAttribution?: boolean;
  /** 缓存有效期（毫秒）；缺省表示永不过期。 */
  cacheTtlMs?: number;
  /** 服务没有在响应头里给归因时的兜底值。 */
  attribution?: { author?: string; license?: string; source?: string };
}

/** 工作台侧的外部素材设置。 */
export interface ExternalAssetSettings {
  /** 已登记的服务。 */
  providers: ExternalAssetProviderConfig[];
  /** 已退出的服务 id。 */
  disabledProviders: string[];
  /** 各服务的授权头（只在会话里）。 */
  headers: Record<string, Record<string, string>>;
}

export const EXTERNAL_ASSET_SETTINGS_KEY = "studio:external-assets";
export const EXTERNAL_ASSET_HEADERS_SESSION_KEY = "studio:external-assets:headers";

export const DEFAULT_EXTERNAL_ASSET_SETTINGS: ExternalAssetSettings = {
  providers: [],
  disabledProviders: [],
  headers: {},
};

/** 没有 localStorage 时的兜底：设置只活在当前页面内存里。 */
const memoryStore = new Map<string, string>();
const memoryStorage: ExternalAssetStorage = {
  getItem: key => memoryStore.get(key) ?? null,
  setItem: (key, value) => { memoryStore.set(key, value); },
  removeItem: key => { memoryStore.delete(key); },
};

/** 读工作台设置。 */
export function readExternalAssetSettings(persistent?: ExternalAssetStorage, session?: ExternalAssetStorage): ExternalAssetSettings {
  const store = resolvePersistent(persistent);
  const settings: ExternalAssetSettings = { providers: [], disabledProviders: [], headers: {} };
  if (store) {
    try {
      const raw = store.getItem(EXTERNAL_ASSET_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ExternalAssetSettings>;
        settings.providers = Array.isArray(parsed.providers) ? parsed.providers.filter(isProviderConfig) : [];
        settings.disabledProviders = Array.isArray(parsed.disabledProviders)
          ? parsed.disabledProviders.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          : [];
      }
    } catch {
      // 设置读坏了就用默认值，不让整个工作台起不来。
    }
  }
  const secrets = resolveSession(session);
  if (secrets) {
    try {
      const raw = secrets.getItem(EXTERNAL_ASSET_HEADERS_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings.headers = parseHeaders(parsed as Record<string, unknown>);
      }
    } catch {
      // 读坏了就当没有授权头。
    }
  }
  return settings;
}

/** 写工作台设置。授权头只进会话存储，不落盘。 */
export function writeExternalAssetSettings(settings: ExternalAssetSettings, persistent?: ExternalAssetStorage, session?: ExternalAssetStorage): void {
  const store = resolvePersistent(persistent);
  store?.setItem(EXTERNAL_ASSET_SETTINGS_KEY, JSON.stringify({
    providers: settings.providers,
    disabledProviders: settings.disabledProviders,
  }));
  const secrets = resolveSession(session);
  if (!secrets) return;
  if (!Object.keys(settings.headers).length) {
    secrets.removeItem(EXTERNAL_ASSET_HEADERS_SESSION_KEY);
    return;
  }
  secrets.setItem(EXTERNAL_ASSET_HEADERS_SESSION_KEY, JSON.stringify(settings.headers));
}

/** 退出（或重新加入）一个服务。 */
export function setProviderDisabled(settings: ExternalAssetSettings, providerId: string, disabled: boolean): ExternalAssetSettings {
  const others = settings.disabledProviders.filter(id => id !== providerId);
  return {
    ...settings,
    disabledProviders: disabled ? [...others, providerId] : others,
  };
}

/** 表单校验：服务登记需要 id、显示名与地址模板。 */
export function validateProviderInput(values: Record<string, string | undefined>): string | undefined {
  const id = values.id?.trim() ?? "";
  const label = values.label?.trim() ?? "";
  const urlTemplate = values.urlTemplate?.trim() ?? "";
  if (!id) return "服务标识不能为空";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return "服务标识只能用字母、数字、点、下划线和短横线";
  if (!label) return "服务名称不能为空";
  if (!urlTemplate) return "地址模板不能为空";
  if (!urlTemplate.includes("{id}")) return "地址模板里要有 {id} 占位符";
  if (!/^https:\/\//i.test(urlTemplate)) return "地址模板必须以 https:// 开头";
  return undefined;
}

/** 登记表单的值。 */
export function providerInputFromConfig(config: ExternalAssetProviderConfig): Record<string, string> {
  return {
    id: config.id,
    label: config.label,
    urlTemplate: config.urlTemplate,
    requiresAttribution: config.requiresAttribution ? "yes" : "",
    cacheTtlHours: config.cacheTtlMs !== undefined ? String(Math.round(config.cacheTtlMs / 3600000)) : "",
    author: config.attribution?.author ?? "",
    license: config.attribution?.license ?? "",
    source: config.attribution?.source ?? "",
  };
}

/** 把表单值变成服务配置。校验不过时返回 undefined。 */
export function providerConfigFromInput(values: Record<string, string | undefined>): ExternalAssetProviderConfig | undefined {
  if (validateProviderInput(values)) return undefined;
  const id = values.id!.trim();
  const label = values.label!.trim();
  const urlTemplate = values.urlTemplate!.trim();
  const cacheTtlHours = Number(values.cacheTtlHours);
  const attribution = {
    author: values.author?.trim() || undefined,
    license: values.license?.trim() || undefined,
    source: values.source?.trim() || undefined,
  };
  const hasAttribution = Object.values(attribution).some(Boolean);
  return {
    id,
    label,
    urlTemplate,
    ...(values.requiresAttribution === "yes" ? { requiresAttribution: true } : {}),
    ...(Number.isFinite(cacheTtlHours) && cacheTtlHours > 0 ? { cacheTtlMs: Math.round(cacheTtlHours * 3600000) } : {}),
    ...(hasAttribution ? { attribution } : {}),
  };
}

/** 服务是否已退出。 */
export function isExternalProviderDisabled(settings: ExternalAssetSettings, providerId: string): boolean {
  return settings.disabledProviders.includes(providerId);
}

function isProviderConfig(value: unknown): value is ExternalAssetProviderConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<ExternalAssetProviderConfig>;
  return typeof config.id === "string" && config.id.trim().length > 0
    && typeof config.label === "string" && config.label.trim().length > 0
    && typeof config.urlTemplate === "string" && config.urlTemplate.trim().length > 0;
}

function parseHeaders(value: Record<string, unknown>): Record<string, Record<string, string>> {
  const headers: Record<string, Record<string, string>> = {};
  for (const [providerId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof headerValue === "string" && headerValue.trim()) record[key] = headerValue;
    }
    if (Object.keys(record).length) headers[providerId] = record;
  }
  return headers;
}

function resolvePersistent(storage?: ExternalAssetStorage): ExternalAssetStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: ExternalAssetStorage }).localStorage;
  } catch {
    return undefined;
  }
}

function resolveSession(storage?: ExternalAssetStorage): ExternalAssetStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { sessionStorage?: ExternalAssetStorage }).sessionStorage ?? memoryStorage;
  } catch {
    return memoryStorage;
  }
}
