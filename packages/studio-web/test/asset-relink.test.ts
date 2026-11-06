import assert from "node:assert/strict";
import test from "node:test";
import type { AssetMetadata } from "@ufira/design-schema";
import { assetLabel, formatBytes, missingAssetIds, relinkError, relinkSuccessMessage } from "../src/asset-relink";

const asset: AssetMetadata = { id: "asset:one", hash: "a".repeat(64), mimeType: "image/png", byteLength: 2048, name: "封面.png" };

test("文件大小按量级显示", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(200 * 1024), "200 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(-1), "未知大小");
  assert.equal(formatBytes(Number.NaN), "未知大小");
});

test("资源名优先用原文件名，没有名字时回退到 id", () => {
  assert.equal(assetLabel(asset), "封面.png");
  assert.equal(assetLabel({ ...asset, name: "  " }), "asset:one");
  assert.equal(assetLabel({ ...asset, name: undefined }), "asset:one");
});

test("重新关联只接受内容哈希一致的文件", () => {
  assert.equal(relinkError(asset, asset.hash), undefined);
  const message = relinkError(asset, "b".repeat(64));
  assert.match(message ?? "", /封面\.png/);
  assert.match(message ?? "", /不一致/);
});

test("缺失集合按资源 id 去重", () => {
  const ids = missingAssetIds([asset, { ...asset }, { ...asset, id: "asset:two" }]);
  assert.equal(ids.size, 2);
  assert.equal(ids.has("asset:one"), true);
});

test("重新关联成功的文案带上恢复了多少节点", () => {
  assert.match(relinkSuccessMessage(asset, 3), /3 个图片节点重新显示/);
  assert.doesNotMatch(relinkSuccessMessage(asset, 0), /重新显示/);
});
