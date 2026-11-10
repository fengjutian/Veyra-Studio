import type { ExternalAssetFetchResult, ExternalAssetProvider } from "./external-assets";

/**
 * 通过 HTTP 取素材的服务。
 *
 * 这是一类最常见的外部素材服务：给定一个模板（例如
 * `https://cdn.example.com/assets/{id}.png`），把素材 id 填进去取回字节。
 *
 * 三件事写在这里，不散在调用方：
 * - **id 会被编码**：`{id}` 位置填的是编码后的 id，不能让外部 id 里的 `/` 或 `..`
 *   变成路径穿越。
 * - **响应体大小有上限**：服务返回的是二进制，声明一个上限免得对方（或中间人）
 *   把几百兆塞进内存。
 * - **归因可以来自响应头**：服务若在 `x-asset-author` / `x-asset-license` /
 *   `x-asset-source` 里带归因，就采信它——省得用户手填。
 */
export interface HttpExternalAssetProviderConfig {
  /** 服务标识，写进 `AssetMetadata.external.provider`。 */
  id: string;
  /** 面板上的显示名。 */
  label: string;
  /** 取素材的地址模板，`{id}` 会被替换成编码后的素材 id。 */
  urlTemplate: string;
  /** 附加请求头（例如授权）。 */
  headers?: Record<string, string>;
  /** 服务是否要求交付物里带上归因。 */
  requiresAttribution?: boolean;
  /** 缓存有效期（毫秒）。 */
  cacheTtlMs?: number;
  /** 服务没有在响应头里给归因时的兜底值。 */
  attribution?: { author?: string; license?: string; source?: string };
  /** 单次响应体的字节上限；默认 20 MB。 */
  maxBytes?: number;
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 默认的响应体上限：与浏览器端插入图片的 20 MB 一致。 */
export const DEFAULT_EXTERNAL_ASSET_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 造一个走 HTTP 的外部素材服务。
 */
export function createHttpExternalAssetProvider(config: HttpExternalAssetProviderConfig): ExternalAssetProvider {
  const maxBytes = config.maxBytes ?? DEFAULT_EXTERNAL_ASSET_MAX_BYTES;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return {
    id: config.id,
    label: config.label,
    ...(config.requiresAttribution ? { requiresAttribution: true } : {}),
    ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
    async fetch(request): Promise<ExternalAssetFetchResult> {
      if (!fetchImpl) throw new Error("当前环境没有 fetch，无法访问外部素材服务");
      const url = config.urlTemplate.replace("{id}", encodeURIComponent(request.id));
      const response = await fetchImpl(url, {
        ...(config.headers ? { headers: config.headers } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) throw new Error(`外部素材服务「${config.label}」返回 ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`外部素材服务「${config.label}」返回的内容超过上限（${declared} > ${maxBytes} 字节）`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new Error(`外部素材服务「${config.label}」返回的内容超过上限（${bytes.byteLength} > ${maxBytes} 字节）`);
      }
      const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
      const headerAttribution = {
        author: response.headers.get("x-asset-author") ?? undefined,
        license: response.headers.get("x-asset-license") ?? undefined,
        source: response.headers.get("x-asset-source") ?? undefined,
      };
      const attribution = {
        author: headerAttribution.author ?? config.attribution?.author,
        license: headerAttribution.license ?? config.attribution?.license,
        source: headerAttribution.source ?? config.attribution?.source,
      };
      const hasAttribution = Object.values(attribution).some(Boolean);
      return {
        bytes,
        mimeType,
        attribution: hasAttribution ? attribution : undefined,
      };
    },
  };
}
