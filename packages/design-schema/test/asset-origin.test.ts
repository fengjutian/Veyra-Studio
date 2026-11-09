import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, validateDocument, type AssetMetadata } from "../src/index";

/** 资源来源/授权元数据的 schema 边界。 */

function documentWithAsset(asset: AssetMetadata) {
  const document = createDocument("doc:origin", "Origin");
  document.assets[asset.id] = asset;
  return document;
}

const base: AssetMetadata = { id: "asset:one", hash: "a".repeat(64), mimeType: "image/png", byteLength: 3, name: "photo.png" };

test("asset origin: 合法来源通过校验", () => {
  const document = documentWithAsset({
    ...base,
    origin: { source: "unsplash.com/photos/abc", author: "Jane Doe", license: "CC-BY-4.0", note: "仅限本项目" },
  });
  assert.deepEqual(validateDocument(document), document);
});

test("asset origin: 全部字段可选，空对象也合法", () => {
  const document = documentWithAsset({ ...base, origin: {} });
  assert.deepEqual(validateDocument(document), document);
});

test("asset origin: 旧文档没有 origin 依然合法", () => {
  const document = documentWithAsset(base);
  assert.deepEqual(validateDocument(document), document);
});

test("asset origin: 字段类型必须是字符串", () => {
  const document = documentWithAsset({ ...base, origin: { source: 42 as unknown as string } });
  assert.throws(() => validateDocument(document), /assets\.asset:one\.origin\.source/);
});
