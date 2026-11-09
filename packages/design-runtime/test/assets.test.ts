import assert from "node:assert/strict";
import test from "node:test";
import { DocumentValidationError, createDocument, defaultAppearance, defaultLayout, type AssetMetadata, type DesignNode } from "@ufira/design-schema";
import { CommandError, DesignRuntime } from "../src/index";

const asset: AssetMetadata = { id: "asset:one", hash: "a".repeat(64), mimeType: "image/png", byteLength: 3, name: "photo.png" };

const imageNode = (id: string, assetId: string): DesignNode => ({
  id,
  type: "image",
  name: id,
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), width: 320, height: 200 },
  appearance: defaultAppearance(),
  assetId,
  fit: "cover",
});

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

test("registers an asset and creates the image node in one transaction", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  assert.deepEqual(runtime.snapshot().assets["asset:one"], asset);
  assert.equal(runtime.snapshot().nodes["image:1"]?.type, "image");
});

test("rejects an image node whose asset was never registered", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  assert.throws(
    () => runtime.execute(envelope(0, [{ type: "node.create", payload: { node: imageNode("image:1", "asset:missing") } }])),
    DocumentValidationError,
  );
  assert.equal(runtime.snapshot().nodes["image:1"], undefined);
});

test("keeps the asset identity stable across content hashes", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset } }]));
  // 同一份内容重复登记是幂等的。
  runtime.execute(envelope(1, [{ type: "asset.upsert", payload: { asset } }]));
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "asset.upsert", payload: { asset: { ...asset, hash: "b".repeat(64) } } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().assets["asset:one"]?.hash, asset.hash);
});

test("validates asset metadata before registering it", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  assert.throws(() => runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset: { ...asset, id: " " } } }])), CommandError);
  assert.throws(() => runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset: { ...asset, hash: "" } } }])), CommandError);
  assert.throws(() => runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset: { ...asset, mimeType: "" } } }])), CommandError);
  assert.throws(() => runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset: { ...asset, byteLength: -1 } } }])), CommandError);
});

test("updates origin metadata without touching the asset identity", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "asset.upsert", payload: { asset } }]));
  const withOrigin = { ...asset, origin: { source: "unsplash.com/photos/abc", author: "Jane Doe", license: "CC-BY-4.0" } };
  runtime.execute(envelope(1, [{ type: "asset.upsert", payload: { asset: withOrigin } }]));

  const stored = runtime.snapshot().assets["asset:one"];
  assert.deepEqual(stored?.origin, withOrigin.origin);
  assert.equal(stored?.hash, asset.hash);
  assert.equal(stored?.byteLength, asset.byteLength);

  // 清空来源也是一次普通 upsert：字段整体替换，不留下空对象。
  const { origin: _dropped, ...cleared } = withOrigin;
  runtime.execute(envelope(2, [{ type: "asset.upsert", payload: { asset: cleared } }]));
  assert.equal(runtime.snapshot().assets["asset:one"]?.origin, undefined);
});

test("patches only the fit of an image node", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  runtime.execute(envelope(1, [{ type: "image.patch", payload: { id: "image:1", patch: { fit: "contain" } } }]));
  const node = runtime.snapshot().nodes["image:1"];
  assert.equal(node?.type === "image" ? node.fit : undefined, "contain");
});

test("swaps the asset of an image node without touching its layout", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const replacement = { ...asset, id: "asset:two", hash: "b".repeat(64), name: "replacement.png" };
  runtime.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  const before = runtime.snapshot().nodes["image:1"]!;

  runtime.execute(envelope(1, [
    { type: "asset.upsert", payload: { asset: replacement } },
    { type: "image.patch", payload: { id: "image:1", patch: { assetId: replacement.id } } },
  ]));

  const after = runtime.snapshot().nodes["image:1"]!;
  assert.equal(after.type === "image" ? after.assetId : undefined, replacement.id);
  assert.deepEqual(after.layout, before.layout);
  assert.deepEqual(after.appearance, before.appearance);
});

test("refuses to point an image at an unregistered asset", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  assert.throws(() => runtime.execute(envelope(1, [{ type: "image.patch", payload: { id: "image:1", patch: { assetId: "asset:missing" } } }])), CommandError);
  const node = runtime.snapshot().nodes["image:1"];
  assert.equal(node?.type === "image" ? node.assetId : undefined, "asset:one");
});

test("refuses image patches on non-image nodes and unknown fits", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: { ...imageNode("frame:1", "asset:one"), type: "frame", assetId: undefined, fit: undefined } } }]));
  assert.throws(() => runtime.execute(envelope(1, [{ type: "image.patch", payload: { id: "frame:1", patch: { fit: "cover" } } }])), CommandError);

  runtime.execute(envelope(1, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  assert.throws(() => runtime.execute(envelope(2, [{ type: "image.patch", payload: { id: "image:1", patch: { fit: "stretch" } } }])), CommandError);
});

test("deletes an unused asset and keeps one that is still referenced", () => {  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", "asset:one") } },
  ]));
  // 节点还引用着资源，删元数据会让文档立刻不合法。
  assert.throws(() => runtime.execute(envelope(1, [{ type: "asset.delete", payload: { id: "asset:one" } }])), CommandError);

  runtime.execute(envelope(1, [{ type: "node.delete", payload: { id: "image:1" } }]));
  runtime.execute(envelope(2, [{ type: "asset.delete", payload: { id: "asset:one" } }]));
  assert.equal(runtime.snapshot().assets["asset:one"], undefined);
});

test("refuses to delete an asset that does not exist", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  assert.throws(() => runtime.execute(envelope(0, [{ type: "asset.delete", payload: { id: "asset:missing" } }])), CommandError);
});
