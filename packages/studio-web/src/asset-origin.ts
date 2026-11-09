/**
 * 资源的来源与授权。
 *
 * 交付时最常被问的不是「这张图多大」，而是「哪来的、能不能商用」。这里只做两件
 * 跟文档有关的事：把一条紧凑的摘要显示在资源列表里，以及把表单输入合并回资源
 * 元数据（空字段直接去掉，不留下 `source: ""` 这种看着像登记过、其实是空的记录）。
 *
 * 纯函数，属性面板与测试共用。
 */

import type { AssetMetadata, AssetOrigin } from "@ufira/design-schema";

/** 资源列表里的一行摘要；没有登记过任何字段时返回 `undefined`。 */
export function assetOriginSummary(origin: AssetOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const parts = [origin.source, origin.author, origin.license].map(part => part?.trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/** 是否登记过来源/授权（只填了 note 也算登记）。 */
export function hasAssetOrigin(origin: AssetOrigin | undefined): boolean {
  if (!origin) return false;
  return [origin.source, origin.author, origin.license, origin.note].some(value => Boolean(value?.trim()));
}

/**
 * 把表单值合并进资源元数据。
 *
 * - 空字符串视为「清空该字段」，不会写回空串；
 * - 四个字段全空时整个 `origin` 被去掉（而不是留一个空对象）；
 * - 其余字段（id / hash / mimeType / byteLength / name）原样保留——这次编辑
 *   只该改来源信息，不该顺手改动内容身份。
 */
export function mergeAssetOrigin(asset: AssetMetadata, values: Record<string, string | undefined>): AssetMetadata {
  const next: AssetOrigin = {};
  const assign = (key: keyof AssetOrigin, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) next[key] = trimmed;
  };
  assign("source", values.source);
  assign("author", values.author);
  assign("license", values.license);
  assign("note", values.note);

  const merged: AssetMetadata = { ...asset };
  if (hasAssetOrigin(next)) merged.origin = next;
  else delete merged.origin;
  return merged;
}
