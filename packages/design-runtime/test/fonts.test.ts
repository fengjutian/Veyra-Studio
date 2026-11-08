import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

const frame = (id: string): DesignNode => ({
  id, type: "frame", name: id, parentId: "page:1", childIds: [],
  visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance(),
});

const text = (id: string, family: string): DesignNode => ({
  ...frame(id),
  type: "text",
  text: "Hello",
  fontFamily: family,
  fontSize: 16,
  lineHeight: 24,
});

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

function runtimeWithText(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: text("title", "Inter") } }]));
  return runtime;
}

test("registers a system font with default weight and style", () => {
  const runtime = runtimeWithText();
  runtime.execute(envelope(1, [{ type: "font.register", payload: { font: { family: "Inter" } } }]));
  assert.deepEqual(runtime.snapshot().fonts, [{ family: "Inter", weight: 400, style: "normal" }]);
});

test("re-registering the same family/weight/style replaces instead of duplicating", () => {
  const runtime = runtimeWithText();
  runtime.execute(envelope(1, [{ type: "font.register", payload: { font: { family: "Inter" } } }]));
  runtime.execute(envelope(2, [{ type: "font.register", payload: { font: { family: "Inter", weight: 700 } } }]));
  assert.deepEqual(runtime.snapshot().fonts?.map(font => font.weight), [400, 700]);

  runtime.execute(envelope(3, [{ type: "font.register", payload: { font: { family: "Inter", weight: 400 } } }]));
  assert.equal(runtime.snapshot().fonts?.length, 2);
});

test("rejects font declarations pointing at missing or non-font assets", () => {
  const runtime = runtimeWithText();
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "font.register", payload: { font: { family: "Inter", assetId: "asset:none" } } }])),
    /does not exist/,
  );
  runtime.execute(envelope(1, [{
    type: "asset.upsert",
    payload: { asset: { id: "asset:img", hash: "h1", mimeType: "image/png", byteLength: 10 } },
  }]));
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "font.register", payload: { font: { family: "Inter", assetId: "asset:img" } } }])),
    /not a font/,
  );
});

test("removing a font in use is refused, and allowed once the text switches away", () => {
  const runtime = runtimeWithText();
  runtime.execute(envelope(1, [{ type: "font.register", payload: { font: { family: "Inter" } } }]));
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "font.remove", payload: { family: "Inter" } }])),
    /still used by text node/,
  );
  runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: "title", patch: { fontFamily: "PingFang SC" } } }]));
  runtime.execute(envelope(3, [{ type: "font.remove", payload: { family: "Inter" } }]));
  assert.equal(runtime.snapshot().fonts, undefined);
});

test("a font asset cannot be deleted while a font declaration points at it", () => {
  const runtime = runtimeWithText();
  runtime.execute(envelope(1, [{
    type: "asset.upsert",
    payload: { asset: { id: "asset:font", hash: "h2", mimeType: "font/woff2", byteLength: 2048 } },
  }]));
  runtime.execute(envelope(2, [{ type: "font.register", payload: { font: { family: "Inter", assetId: "asset:font" } } }]));
  assert.throws(
    () => runtime.execute(envelope(3, [{ type: "asset.delete", payload: { id: "asset:font" } }])),
    /still used by font/,
  );
});
