import type { ExportDiagnostic } from "@ufira/design-export";
import type { ProjectRepository } from "@ufira/design-persistence";
import { assetIdForHash, type AssetMetadata, type DesignDocument, type NodeId } from "@ufira/design-schema";

/**
 * 外部素材服务。
 *
 * 「外部素材服务」指项目之外提供素材的服务（图标库、图库、设计系统商店）。
 * 用户从这类服务里拿一张图，通常伴随三个问题，本模块逐个回答：
 *
 * 1. **缓存**：同一个服务的同一个素材 id 应当只取一次。命中缓存时不再发请求，
 *    服务不可达时也能继续用。缓存由**文档里的资源元数据**（`AssetMetadata.external`）
 *    加**仓库里的字节**组成——不另建一套缓存存储，也就不会出现「缓存和文档对不上」。
 * 2. **归因**：服务可能要求交付物里带上作者与许可证。取回来的素材把归因信息写进
 *    `AssetMetadata.origin`，随文档走；交付时能列出一份归因清单，缺归因会出诊断。
 * 3. **退出策略**：用户可以「退出」某个服务——之后不再向它发请求。已缓存的素材
 *    仍然可用（退出不应该毁掉已有设计），但会被标出来；彻底清理由用户显式发起。
 *
 * 规格见 `docs/external-assets.md`。
 */

/** 素材的归因信息：谁做的、什么许可、从哪来。 */
export interface ExternalAssetAttribution {
  /** 作者或版权方。 */
  author?: string;
  /** 许可证：SPDX 标识（`CC-BY-4.0`）或一句人话。 */
  license?: string;
  /** 来源：素材库名或原始 URL。 */
  source?: string;
}

/** 向服务要一份素材。 */
export interface ExternalAssetFetchRequest {
  /** 服务内部的素材 id。 */
  readonly id: string;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/** 服务返回的一份素材。 */
export interface ExternalAssetFetchResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  /** 建议的文件名。 */
  readonly name?: string;
  /** 归因信息。 */
  readonly attribution?: ExternalAssetAttribution;
}

/**
 * 一个外部素材服务。
 *
 * 服务只负责「怎么取」，缓存、归因、退出策略都在这一层之外——所以同一个服务
 * 既能被工作台用，也能被 MCP 适配器用，行为完全一致。
 */
export interface ExternalAssetProvider {
  /** 服务标识，写进 `AssetMetadata.external.provider`。 */
  readonly id: string;
  /** 面板上的显示名。 */
  readonly label: string;
  /** 该服务是否要求交付物里带上归因。 */
  readonly requiresAttribution?: boolean;
  /** 缓存有效期（毫秒）；超过后重新拉取。缺省表示永不过期。 */
  readonly cacheTtlMs?: number;
  /** 拉一份素材。 */
  fetch(request: ExternalAssetFetchRequest): Promise<ExternalAssetFetchResult>;
}

/** 一次「取素材」的结果。 */
export type ExternalAssetResolution =
  /** 命中缓存：没有向服务发请求。 */
  | { kind: "cached"; asset: AssetMetadata; bytes?: Uint8Array; attribution?: ExternalAssetAttribution; note?: string }
  /** 向服务取到了（首次取，或缓存过期后重新取）。 */
  | {
    kind: "fetched";
    asset: AssetMetadata;
    bytes: Uint8Array;
    attribution?: ExternalAssetAttribution;
    refreshed?: boolean;
    /** 内容变了导致资源 id 变化时，旧的那条资源 id（调用方可据此清理）。 */
    supersededAssetId?: string;
  }
  /** 服务已退出，且本地没有可用缓存。 */
  | { kind: "disabled"; providerId: string; externalId: string; reason: string }
  /** 服务没注册。 */
  | { kind: "unknown-provider"; providerId: string };

/** 取素材需要的全部外部依赖。 */
export interface ResolveExternalAssetParams {
  readonly provider: ExternalAssetProvider;
  readonly externalId: string;
  readonly document: DesignDocument;
  readonly repository: ProjectRepository;
  /** 已退出的服务 id；这些服务不会再被请求。 */
  readonly disabledProviders?: readonly string[];
  readonly now?: Date;
}

/**
 * 缓存键：`provider` 与素材 id **两段**。
 *
 * 两段都要在——只有素材 id 会在服务之间撞车（两个服务都有 `logo.png`）。这里刻意
 * **不把两段拼成一个字符串**：拼接要选分隔符，而分隔符本身可能出现在素材 id 里
 * （`a:b` + `c` 与 `a` + `b:c` 会拼成同一个键）。缓存查找直接比两个字段，不绕这个坑。
 */
export interface ExternalAssetCacheKey {
  provider: string;
  externalId: string;
}

/** 服务是否已退出（用户明确表示不再使用它）。 */
export function isProviderDisabled(disabledProviders: readonly string[] | undefined, providerId: string): boolean {
  return (disabledProviders ?? []).includes(providerId);
}

/**
 * 文档里已缓存的、来自某个服务某个 id 的素材。
 *
 * 缓存是「文档里的一条资源元数据」，所以查找是纯扫描——素材数量不大，
 * 换来的是「缓存和文档永远一致」，不需要额外的一致性维护。
 *
 * 同一个服务、同一个素材 id 可能有**多条**记录：服务那边更新了内容，重取之后
 * 字节变了，资源 id（内容哈希）也跟着变，旧的记录还留在文档里（可能还被某个
 * 节点引用着）。这时要取**最近拉取的那条**，否则会一直命中过期的那份。
 */
export function findCachedExternalAsset(document: DesignDocument, providerId: string, externalId: string): AssetMetadata | undefined {
  let latest: AssetMetadata | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const asset of Object.values(document.assets)) {
    if (asset.external?.provider !== providerId || asset.external.providerAssetId !== externalId) continue;
    const fetchedAt = Date.parse(asset.external.fetchedAt);
    const at = Number.isNaN(fetchedAt) ? Number.NEGATIVE_INFINITY : fetchedAt;
    if (!latest || at > latestAt) {
      latest = asset;
      latestAt = at;
    }
  }
  return latest;
}

/** 缓存是否已过期。 */
export function isExternalCacheStale(asset: AssetMetadata, now: Date): boolean {
  const expiresAt = asset.external?.expiresAt;
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry <= now.getTime();
}

/**
 * 按归因信息拼出资源元数据。
 *
 * 归因写进 `origin`（人读的那份），服务与素材 id 写进 `external`（机器读的那份）：
 * 两者职责不同——`origin` 用户可以自己改，`external` 是缓存键，不能被随手改掉。
 */
export function buildExternalAssetMetadata(params: {
  provider: ExternalAssetProvider;
  externalId: string;
  hash: string;
  mimeType: string;
  byteLength: number;
  name?: string;
  attribution?: ExternalAssetAttribution;
  fetchedAt: Date;
  ttlMs?: number;
}): AssetMetadata {
  const { provider, externalId, attribution } = params;
  const origin = {
    // 来源没有给 URL 时用服务名——「来源」本来就可以是素材库名。
    source: attribution?.source ?? provider.label,
    ...(attribution?.author ? { author: attribution.author } : {}),
    ...(attribution?.license ? { license: attribution.license } : {}),
  };
  const expiresAt = params.ttlMs !== undefined ? new Date(params.fetchedAt.getTime() + params.ttlMs).toISOString() : undefined;
  return {
    id: assetIdForHash(params.hash),
    hash: params.hash,
    mimeType: params.mimeType,
    byteLength: params.byteLength,
    ...(params.name ? { name: params.name } : {}),
    origin,
    external: {
      provider: provider.id,
      providerAssetId: externalId,
      fetchedAt: params.fetchedAt.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

/**
 * 取一份外部素材：先查缓存，再决定要不要发请求。
 *
 * 三条退路保证「退出服务」不会毁掉已有设计：
 * - 服务已退出但本地有缓存 → 用缓存（`cached`），并说明用的是本地副本；
 * - 服务已退出且没有缓存 → 拒绝（`disabled`），不会偷偷去请求；
 * - 服务不可达但有过期缓存 → 用过期缓存（`cached`），标注它是过期的。
 */
export async function resolveExternalAsset(params: ResolveExternalAssetParams): Promise<ExternalAssetResolution> {
  const { provider, externalId, document, repository, disabledProviders } = params;
  const now = params.now ?? new Date();
  const cached = findCachedExternalAsset(document, provider.id, externalId);
  const cachedBytes = cached ? await repository.getAsset(document.id, cached.hash) : undefined;

  if (isProviderDisabled(disabledProviders, provider.id)) {
    if (cached && cachedBytes) {
      return {
        kind: "cached",
        asset: cached,
        bytes: cachedBytes,
        attribution: attributionOf(cached),
        note: `服务「${provider.label}」已退出，这里用的是本地缓存`,
      };
    }
    return {
      kind: "disabled",
      providerId: provider.id,
      externalId,
      reason: `服务「${provider.label}」已退出，且本地没有缓存`,
    };
  }

  if (cached && cachedBytes && !isExternalCacheStale(cached, now)) {
    return { kind: "cached", asset: cached, bytes: cachedBytes, attribution: attributionOf(cached) };
  }

  const refreshed = Boolean(cached);
  let fetched: ExternalAssetFetchResult;
  try {
    fetched = await provider.fetch({ id: externalId });
  } catch (error) {
    // 服务不可达：有过期缓存就继续用，没有就如实报错——不假装成功。
    if (cached && cachedBytes) {
      return {
        kind: "cached",
        asset: cached,
        bytes: cachedBytes,
        attribution: attributionOf(cached),
        note: `服务「${provider.label}」取不到（${errorMessage(error)}），这里用的是过期缓存`,
      };
    }
    throw error;
  }

  const hash = await sha256Hex(fetched.bytes);
  const asset = buildExternalAssetMetadata({
    provider,
    externalId,
    hash,
    mimeType: fetched.mimeType,
    byteLength: fetched.bytes.byteLength,
    name: fetched.name,
    attribution: fetched.attribution,
    fetchedAt: now,
    ttlMs: provider.cacheTtlMs,
  });
  // 服务那边更新了内容 → 资源 id（内容哈希）变了，旧的元数据就成了没人引用的孤儿。
  // 它不会自己消失：留着会让归因清单里出现两条同一个外部素材。
  // 但**不能**在这里删——旧的那份可能还被某个节点引用着，删了会让文档立刻失效。
  // 清理交给调用方（它知道节点引用情况），这里只把「旧的还在」这件事说出来。
  return {
    kind: "fetched",
    asset,
    bytes: fetched.bytes,
    attribution: fetched.attribution,
    ...(refreshed ? { refreshed: true } : {}),
    ...(cached && cached.id !== asset.id ? { supersededAssetId: cached.id } : {}),
  };
}

/** 从资源元数据里读出归因信息。 */
export function attributionOf(asset: AssetMetadata): ExternalAssetAttribution | undefined {
  const origin = asset.origin;
  if (!origin) return undefined;
  const attribution: ExternalAssetAttribution = {
    ...(origin.author ? { author: origin.author } : {}),
    ...(origin.license ? { license: origin.license } : {}),
    ...(origin.source ? { source: origin.source } : {}),
  };
  return Object.keys(attribution).length ? attribution : undefined;
}

/** 归因清单里的一行。 */
export interface ExternalAttributionEntry {
  /** 本地资源 id。 */
  assetId: string;
  /** 素材名。 */
  assetName?: string;
  /** 服务 id 与显示名。 */
  providerId: string;
  providerLabel: string;
  /** 服务内部的素材 id。 */
  externalId: string;
  author?: string;
  license?: string;
  source?: string;
  /** 引用这份素材的节点。 */
  usedBy: NodeId[];
  /** 该服务已被用户退出。 */
  providerDisabled: boolean;
  /** 缓存是否已过期（过期后重新取时才会用到）。 */
  expired: boolean;
  /** 归因是否完整：服务要求归因时，作者与许可证都得有。 */
  complete: boolean;
}

/** 收集文档里所有外部素材的归因清单。 */
export function collectExternalAttributions(
  document: DesignDocument,
  options: { providers?: readonly ExternalAssetProvider[]; disabledProviders?: readonly string[]; now?: Date } = {},
): ExternalAttributionEntry[] {
  const providers = new Map((options.providers ?? []).map(provider => [provider.id, provider]));
  const now = options.now ?? new Date();
  const usage = new Map<string, NodeId[]>();
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "image") continue;
    const ids = usage.get(node.assetId) ?? [];
    ids.push(node.id);
    usage.set(node.assetId, ids);
  }

  const entries: ExternalAttributionEntry[] = [];
  for (const asset of Object.values(document.assets)) {
    const external = asset.external;
    if (!external) continue;
    const provider = providers.get(external.provider);
    const attribution = attributionOf(asset);
    const requiresAttribution = provider?.requiresAttribution ?? false;
    entries.push({
      assetId: asset.id,
      ...(asset.name ? { assetName: asset.name } : {}),
      providerId: external.provider,
      providerLabel: provider?.label ?? external.provider,
      externalId: external.providerAssetId,
      ...(attribution?.author ? { author: attribution.author } : {}),
      ...(attribution?.license ? { license: attribution.license } : {}),
      ...(attribution?.source ? { source: attribution.source } : {}),
      usedBy: usage.get(asset.id) ?? [],
      providerDisabled: isProviderDisabled(options.disabledProviders, external.provider),
      expired: isExternalCacheStale(asset, now),
      complete: !requiresAttribution || Boolean(attribution?.author && attribution?.license),
    });
  }
  return entries.sort((left, right) => left.assetId.localeCompare(right.assetId));
}

/** 归因清单的 Markdown 文本，供交付物附带。 */
export function renderAttributionMarkdown(entries: readonly ExternalAttributionEntry[]): string {
  if (!entries.length) return "";
  const lines = ["# 素材归因", ""];
  for (const entry of entries) {
    const parts = [entry.author, entry.license, entry.source].filter(Boolean).join(" · ");
    const flags = [
      entry.providerDisabled ? "服务已退出" : undefined,
      entry.complete ? undefined : "归因不完整",
    ].filter(Boolean);
    lines.push(`- ${entry.assetName ?? entry.assetId}（${entry.providerLabel} / ${entry.externalId}）${parts ? ` — ${parts}` : ""}${flags.length ? `  [${flags.join("，")}]` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 退出某个服务时能清掉什么、什么必须留下。
 *
 * 还在被节点引用的素材删了会让文档立刻失效（图片节点指向不存在的资源），
 * 所以这部分只报告不动手。
 */
export interface ExternalPurgePlan {
  providerId: string;
  /** 没有被引用的素材：可以安全清理。 */
  removable: AssetMetadata[];
  /** 仍被节点引用的素材：需要用户先换掉或删掉节点。 */
  referenced: Array<{ asset: AssetMetadata; nodeIds: NodeId[] }>;
}

/** 计算「清掉某个服务缓存」的影响面。 */
export function planExternalProviderPurge(document: DesignDocument, providerId: string): ExternalPurgePlan {
  const usage = new Map<string, NodeId[]>();
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "image") continue;
    const ids = usage.get(node.assetId) ?? [];
    ids.push(node.id);
    usage.set(node.assetId, ids);
  }

  const removable: AssetMetadata[] = [];
  const referenced: Array<{ asset: AssetMetadata; nodeIds: NodeId[] }> = [];
  for (const asset of Object.values(document.assets)) {
    if (asset.external?.provider !== providerId) continue;
    const nodeIds = usage.get(asset.id) ?? [];
    if (nodeIds.length) referenced.push({ asset, nodeIds });
    else removable.push(asset);
  }
  return { providerId, removable, referenced };
}

/**
 * 外部素材相关的导出诊断。
 *
 * 缺归因是**交付前必须知道**的事：服务要求署名而素材上没有署名信息，
 * 交付出去可能违反许可。所以它报诊断而不是安静通过。
 */
export function collectExternalAssetDiagnostics(
  document: DesignDocument,
  options: { providers?: readonly ExternalAssetProvider[]; disabledProviders?: readonly string[] } = {},
): ExportDiagnostic[] {
  const diagnostics: ExportDiagnostic[] = [];
  for (const entry of collectExternalAttributions(document, options)) {
    if (!entry.complete) {
      diagnostics.push({
        feature: "external-asset",
        support: "unsupported",
        message: `素材「${entry.assetName ?? entry.assetId}」来自「${entry.providerLabel}」，该服务要求归因，但作者或许可证没有登记`,
      });
    }
    if (entry.providerDisabled && entry.usedBy.length) {
      diagnostics.push({
        feature: "external-asset",
        support: "approximated",
        message: `素材「${entry.assetName ?? entry.assetId}」来自已退出的服务「${entry.providerLabel}」，交付物里用的是本地缓存`,
      });
    }
  }
  return diagnostics;
}

/** 素材字节的 SHA-256（与仓库校验资源用的是同一种摘要）。 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 SHA-256，无法为外部素材生成资源 id");
  // 拷进新的 ArrayBuffer：Uint8Array 的底层缓冲可能比视图长，直接传进去会带上多余字节。
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);
  const digest = await subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
