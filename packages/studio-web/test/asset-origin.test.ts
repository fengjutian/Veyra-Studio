import assert from "node:assert/strict";
import test from "node:test";
import type { AssetMetadata } from "@ufira/design-schema";
import { assetOriginSummary, hasAssetOrigin, mergeAssetOrigin } from "../src/asset-origin";

/** 资源来源/授权的编辑逻辑。 */

const asset: AssetMetadata = { id: "asset:one", hash: "a".repeat(64), mimeType: "image/png", byteLength: 3, name: "photo.png" };

test("origin: 摘要按来源 / 作者 / 许可证拼接，空字段不占位", () => {
  assert.equal(assetOriginSummary({ source: "Unsplash", author: "Jane", license: "CC-BY-4.0" }), "Unsplash · Jane · CC-BY-4.0");
  assert.equal(assetOriginSummary({ license: "CC0" }), "CC0");
  assert.equal(assetOriginSummary({ note: "内部素材" }), undefined);
  assert.equal(assetOriginSummary(undefined), undefined);
});

test("origin: 只填备注也算登记过", () => {
  assert.equal(hasAssetOrigin({ note: "内部素材" }), true);
  assert.equal(hasAssetOrigin({ source: "  " }), false);
  assert.equal(hasAssetOrigin(undefined), false);
});

test("origin: 合并表单值会去掉空字段，并保留资源身份字段", () => {
  const merged = mergeAssetOrigin(asset, { source: "  Unsplash ", author: "", license: "CC0", note: "  " });
  assert.deepEqual(merged, { ...asset, origin: { source: "Unsplash", license: "CC0" } });
  // 身份字段不动。
  assert.equal(merged.hash, asset.hash);
  assert.equal(merged.byteLength, asset.byteLength);
});

test("origin: 全部留空时整个 origin 被移除，而不是留一个空对象", () => {
  const withOrigin: AssetMetadata = { ...asset, origin: { source: "Unsplash", license: "CC0" } };
  const merged = mergeAssetOrigin(withOrigin, { source: "", author: "", license: "", note: "" });
  assert.equal(merged.origin, undefined);
  assert.equal("origin" in merged, false);
});
