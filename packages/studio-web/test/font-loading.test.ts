import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { collectFontFamilies, prepareFonts, type FontFaceSetLike } from "../src/font-loading";

function textNode(id: string, fontFamily: string): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "文字",
    fontFamily,
    fontSize: 16,
    lineHeight: 24,
  };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  return {
    schemaVersion: 2,
    id: "doc:1",
    revision: 0,
    meta: { name: "Demo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    pageOrder: ["page:1"],
    pages: { "page:1": { id: "page:1", name: "Page 1", childIds: nodes.map(node => node.id) } },
    nodes: Object.fromEntries(nodes.map(node => [node.id, node])),
    components: {},
    tokens: {},
    assets: {},
  };
}

test("collects unique, sorted font families from text nodes only", () => {
  const document = documentWith([
    textNode("a", "Inter"),
    textNode("b", "Georgia"),
    textNode("c", "Inter"),
    textNode("d", "   "),
    { ...textNode("e", "Ignored"), type: "frame" } as DesignNode,
  ]);
  assert.deepEqual(collectFontFamilies(document), ["Georgia", "Inter"]);
});

test("loads each family with a quoted 16px shorthand", async () => {
  const calls: string[] = [];
  const fonts: FontFaceSetLike = {
    load: async font => { calls.push(font); return []; },
  };
  const loaded = await prepareFonts(["Inter", "SF Pro"], { fonts });
  assert.deepEqual(calls, ['16px "Inter"', '16px "SF Pro"']);
  assert.deepEqual(loaded, ["Inter", "SF Pro"]);
});

test("a missing font is skipped instead of failing the whole load", async () => {
  const fonts: FontFaceSetLike = {
    load: async font => {
      if (font.includes("Ghost")) throw new Error("not found");
      return [];
    },
  };
  assert.deepEqual(await prepareFonts(["Inter", "Ghost"], { fonts, timeoutMs: 50 }), ["Inter"]);
});

test("a font that never resolves is dropped after the timeout", async () => {
  const fonts: FontFaceSetLike = { load: () => new Promise(() => undefined) };
  const started = Date.now();
  assert.deepEqual(await prepareFonts(["Slow"], { fonts, timeoutMs: 10 }), []);
  assert.ok(Date.now() - started < 1000);
});

test("without a font set or families there is nothing to do", async () => {
  assert.deepEqual(await prepareFonts([], { fonts: { load: async () => [] } }), []);
  const loaded = await prepareFonts(["Inter"]);
  // node 环境没有 document.fonts，应安静返回空数组。
  assert.deepEqual(loaded, []);
});

test("names with quotes are neutralized before reaching the font loader", async () => {
  const calls: string[] = [];
  const fonts: FontFaceSetLike = { load: async font => { calls.push(font); return []; } };
  await prepareFonts(['Weird"Name'], { fonts });
  assert.deepEqual(calls, ['16px "WeirdName"']);
});
