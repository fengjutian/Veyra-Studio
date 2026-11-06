import { exportNodeSet } from "@ufira/design-export";
import type { ProjectRepository } from "@ufira/design-persistence";
import type { AssetMetadata, DesignDocument, NodeId } from "@ufira/design-schema";

/**
 * 导出时把图片资源交给导出器的桥。
 *
 * `design-export` 的 `resolveAsset` 是同步的，但资源字节在仓库里是异步读取的，
 * 所以导出前先把本次导出会用到的资源读出来转成 data URL，再交给导出器。
 * data URL 是同源内容，画布不会因此被污染，PNG 光栅化也能正常读回像素。
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 纯 JS 的 base64 编码。
 *
 * 不依赖 `btoa` 或 Node 的 `Buffer`：同一个实现要能在浏览器工作台和 node 测试里
 * 得到逐字节一致的结果。
 */
export function base64FromBytes(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : BASE64_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 0b111111];
  }
  return output;
}

/** 一份图片资源的 data URL。 */
export function assetDataUrl(asset: AssetMetadata, bytes: Uint8Array): string {
  return `data:${asset.mimeType};base64,${base64FromBytes(bytes)}`;
}

/**
 * 本次导出真正会画到的图片资源。
 *
 * 只导出选区时沿用导出器的 keep 集合（选中节点 + 子树 + 祖先链），否则整页遍历。
 * 同一个资源被多张图片引用时只解析一次。
 */
export function collectImageAssets(document: DesignDocument, pageId: string, nodeIds?: readonly NodeId[]): AssetMetadata[] {
  const page = document.pages[pageId];
  if (!page) return [];
  const keep = nodeIds?.length ? exportNodeSet(document, nodeIds) : undefined;
  const found = new Map<string, AssetMetadata>();
  const walk = (id: NodeId): void => {
    if (keep && !keep.has(id)) return;
    const node = document.nodes[id];
    if (!node) return;
    if (node.type === "image") {
      const asset = document.assets[node.assetId];
      if (asset && !found.has(asset.id)) found.set(asset.id, asset);
    }
    for (const childId of node.childIds) walk(childId);
  };
  for (const childId of page.childIds) walk(childId);
  return [...found.values()];
}

/**
 * 读取导出所需的资源，返回 `resolveAsset` 回调。
 *
 * 读不到的资源不在这里报错：让导出器自己产出 `image-asset` 诊断，语言和
 * 导出范围保持一致。
 */
export async function createAssetResolver(
  repository: ProjectRepository,
  document: DesignDocument,
  pageId: string,
  nodeIds?: readonly NodeId[],
): Promise<(asset: AssetMetadata) => string | undefined> {
  const urls = new Map<string, string>();
  for (const asset of collectImageAssets(document, pageId, nodeIds)) {
    const bytes = await repository.getAsset(document.id, asset.hash);
    if (bytes) urls.set(asset.id, assetDataUrl(asset, bytes));
  }
  return asset => urls.get(asset.id);
}

/**
 * 文档里声明了、但仓库中读不到字节的资源。
 *
 * 导入别人的 JSON 就会走到这里：文档带着资源元数据回来，字节却不在本地存储中。
 * 返回的是资源元数据，界面上可以直接报出名字和数量。
 */
export async function findMissingAssets(repository: ProjectRepository, document: DesignDocument): Promise<AssetMetadata[]> {
  const missing: AssetMetadata[] = [];
  for (const asset of Object.values(document.assets)) {
    const bytes = await repository.getAsset(document.id, asset.hash);
    if (!bytes) missing.push(asset);
  }
  return missing;
}
