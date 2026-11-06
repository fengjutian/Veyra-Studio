import type { ProjectRepository } from "@ufira/design-persistence";
import type { AssetMetadata } from "@ufira/design-schema";

/**
 * 画布上图片资源的对象 URL 缓存。
 *
 * 画布每帧都会重新渲染，而资源字节要异步从 IndexedDB 读，直接在每个节点里
 * 读一次会让同一张图被反复解码。这里按 `项目 + 内容哈希` 缓存 Promise：
 * 同一张图被十个节点引用也只读一次、只生成一个 URL。
 *
 * 缓存不需要主动过期：内容哈希变了就是另一份资源，键自然不同。唯一的例外是
 * "之前读不到、后来补上了"，由 {@link forgetAssetUrl} 在写入资源后清掉。
 */
const cache = new Map<string, Promise<string | undefined>>();
let version = 0;

/** 缓存版本号：写入资源后加一，让已经渲染过的节点重新读一次。 */
export function assetUrlCacheVersion(): number {
  return version;
}

function cacheKey(projectId: string, hash: string): string {
  return `${projectId}:${hash}`;
}

/** 读取一张图片的对象 URL；仓库里没有对应字节时返回 undefined。 */
export function loadAssetUrl(repository: ProjectRepository, projectId: string, asset: AssetMetadata): Promise<string | undefined> {
  const key = cacheKey(projectId, asset.hash);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = repository.getAsset(projectId, asset.hash)
    .then(bytes => bytes ? URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: asset.mimeType })) : undefined)
    .catch(() => undefined);
  cache.set(key, pending);
  return pending;
}

/** 资源被重新写入后清掉旧结果，让画布重新读一次。 */
export function forgetAssetUrl(projectId: string, hash: string): void {
  cache.delete(cacheKey(projectId, hash));
  version += 1;
}

/** 切项目或删除项目时整体清空。 */
export function resetAssetUrlCache(): void {
  cache.clear();
  version += 1;
}

/** Blob 只接受真正的 ArrayBuffer，这里把 Uint8Array 的窗口裁出来。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
