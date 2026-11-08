import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computePageLayout, createEstimateTextMeasurer } from "@ufira/design-layout";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 导出基线（golden files）。
 *
 * 这里不比较像素，而是把**确定的产物**锁进仓库：HTML 交付物、SVG 交付物，以及
 * 布局引擎解出的包围盒。字体等不确定因素走 `createEstimateTextMeasurer`（纯字符
 * 宽度估算，跨平台一致）。任何一次无意的几何、CSS 或 token 变量变化都会在这里
 * 变成 diff，而不是等用户发现导出的东西错位。
 *
 * 重新生成基线：`UPDATE_GOLDEN=1 npm run test -w packages/design-export`
 */
const GOLDEN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const VIEWPORT = { width: 960, height: 680 };
const PAGE_ID = "page:main";

/** 1×1 透明 PNG，作为图片资源的稳定导出内容。 */
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fixture(): DesignDocument {
  const document = createDocument("project:golden", "Golden", PAGE_ID);
  document.pages[PAGE_ID]!.name = "首页";
  document.meta.createdAt = "2026-01-01T00:00:00.000Z";
  document.meta.updatedAt = "2026-01-01T00:00:00.000Z";
  document.tokens = {
    "color.primary": { type: "color", value: "#2563eb" },
    "color.surface": { type: "color", value: "#ffffff" },
    "spacing.md": { type: "number", value: 16 },
  };
  document.assets["asset:dot"] = { id: "asset:dot", hash: "a".repeat(64), mimeType: "image/png", byteLength: 70, name: "dot.png" };

  const nodes: DesignNode[] = [
    {
      id: "frame:card", type: "frame", name: "卡片", parentId: PAGE_ID, childIds: ["text:title", "text:body", "rect:accent"],
      visible: true, locked: false,
      layout: { ...defaultLayout(), mode: "stack", direction: "vertical", x: 40, y: 40, width: 320, height: 200, widthMode: "fixed", heightMode: "hug", gap: 12, padding: { top: 16, right: 16, bottom: 16, left: 16 }, align: "stretch" },
      appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ffffff" }], stroke: "#e2e8f0", cornerRadius: 16 },
      bindings: { fill: "color.surface" },
    },
    {
      id: "text:title", type: "text", name: "标题", parentId: "frame:card", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 288, height: 28, widthMode: "fill", heightMode: "hug" },
      appearance: defaultAppearance(),
      text: "设计系统卡片",
      fontFamily: "Inter", fontSize: 20, lineHeight: 28, fontWeight: 600, letterSpacing: 1,
    },
    {
      id: "text:body", type: "text", name: "正文", parentId: "frame:card", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 288, height: 60, widthMode: "fill", heightMode: "hug" },
      appearance: defaultAppearance(),
      text: "这段文字用来验证换行、字重、对齐和字间距在导出里保持一致。",
      fontFamily: "Inter", fontSize: 13, lineHeight: 20, textAlign: "left",
    },
    {
      id: "rect:accent", type: "rectangle", name: "色块", parentId: "frame:card", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 48, height: 48 },
      appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#2563eb" }], cornerRadius: 8 },
      bindings: { fill: "color.primary" },
    },
    {
      id: "image:hero", type: "image", name: "主图", parentId: PAGE_ID, childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), x: 400, y: 40, width: 240, height: 160 },
      appearance: defaultAppearance(),
      assetId: "asset:dot", fit: "cover",
    },
    {
      id: "ellipse:dot", type: "ellipse", name: "圆点", parentId: PAGE_ID, childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), x: 400, y: 240, width: 64, height: 64 },
      appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
    },
    {
      id: "node:badge", type: "component", name: "徽章", parentId: PAGE_ID, childIds: ["text:badge-label"],
      visible: true, locked: false,
      layout: { ...defaultLayout(), x: 680, y: 40, width: 120, height: 32 },
      appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#eef2ff" }], cornerRadius: 999 },
    },
    {
      id: "text:badge-label", type: "text", name: "徽章文字", parentId: "node:badge", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 88, height: 20, widthMode: "fill", heightMode: "hug" },
      appearance: defaultAppearance(),
      text: "Beta", fontFamily: "Inter", fontSize: 12, lineHeight: 16, textAlign: "center",
    },
    {
      id: "instance:badge", type: "instance", name: "徽章实例", parentId: PAGE_ID, childIds: ["instance:badge--text:badge-label"],
      visible: true, locked: false,
      layout: { ...defaultLayout(), x: 680, y: 90, width: 120, height: 32 },
      appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#eef2ff" }], cornerRadius: 999 },
      componentId: "component:badge", overrides: { "text:badge-label": { text: "v0.2" } },
    },
    {
      id: "instance:badge--text:badge-label", type: "text", name: "徽章文字", parentId: "instance:badge", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 88, height: 20, widthMode: "fill", heightMode: "hug" },
      appearance: defaultAppearance(),
      text: "v0.2", fontFamily: "Inter", fontSize: 12, lineHeight: 16, textAlign: "center",
    },
    {
      id: "frame:hidden", type: "frame", name: "隐藏层", parentId: PAGE_ID, childIds: [],
      visible: false, locked: false,
      layout: { ...defaultLayout(), x: 700, y: 300, width: 100, height: 100 },
      appearance: defaultAppearance(),
    },
    {
      id: "vector:logo", type: "vector", name: "矢量占位", parentId: PAGE_ID, childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), x: 400, y: 340, width: 80, height: 80 },
      appearance: defaultAppearance(),
    },
  ];
  document.nodes = Object.fromEntries(nodes.map(node => [node.id, node]));
  document.pages[PAGE_ID]!.childIds = nodes.filter(node => node.parentId === PAGE_ID).map(node => node.id);
  document.components["component:badge"] = { id: "component:badge", name: "徽章", rootNodeId: "node:badge" };
  return document;
}

function expectGolden(name: string, actual: string): void {
  const file = join(GOLDEN_DIRECTORY, name);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
    writeFileSync(file, actual, "utf8");
    return;
  }
  const expected = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(actual, expected, `${name} 与基线不一致；确认改动是有意的后再用 UPDATE_GOLDEN=1 重新生成`);
}

test("HTML 交付物与基线一致", () => {
  const result = exportPageToHtml(fixture(), {
    pageId: PAGE_ID,
    viewport: VIEWPORT,
    resolveAsset: () => TINY_PNG,
  });
  expectGolden("page.html", result.document);
});

test("SVG 交付物与基线一致", () => {
  const result = exportPageToSvg(fixture(), {
    pageId: PAGE_ID,
    viewport: VIEWPORT,
    resolveAsset: () => TINY_PNG,
    textMeasurer: createEstimateTextMeasurer(),
  });
  expectGolden("page.svg", result.svg);
});

test("选区导出的产物与基线一致", () => {
  const svg = exportPageToSvg(fixture(), {
    pageId: PAGE_ID,
    viewport: { width: 320, height: 200 },
    origin: { x: 40, y: 40 },
    nodeIds: ["frame:card"],
    resolveAsset: () => TINY_PNG,
    textMeasurer: createEstimateTextMeasurer(),
  });
  expectGolden("selection.svg", svg.svg);
});

test("布局包围盒与基线一致", () => {
  const layout = computePageLayout(fixture(), PAGE_ID, { viewport: VIEWPORT, textMeasurer: createEstimateTextMeasurer() });
  expectGolden("layout.json", `${JSON.stringify({ boxes: layout.boxes, warnings: layout.warnings }, null, 2)}\n`);
});
