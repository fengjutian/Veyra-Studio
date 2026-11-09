import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { collectContrastIssues, contrastRatio, contrastThreshold, effectiveBackground, isLargeText, parseHexColor, relativeLuminance } from "../src/accessibility";

function frame(id: string, parentId: string, fill?: string): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 100 },
    appearance: { ...defaultAppearance(), ...(fill ? { fills: [{ type: "solid" as const, color: fill }] } : {}) },
  };
}

function text(id: string, parentId: string, options: { fill?: string; text?: string; fontSize?: number; fontWeight?: number; bind?: string } = {}): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: { ...defaultAppearance(), ...(options.fill ? { fills: [{ type: "solid" as const, color: options.fill }] } : {}) },
    text: options.text ?? "示例文字",
    fontFamily: "Inter",
    fontSize: options.fontSize ?? 14,
    lineHeight: 20,
    ...(options.fontWeight ? { fontWeight: options.fontWeight } : {}),
    ...(options.bind ? { bindings: { fill: options.bind } } : {}),
  } as DesignNode;
}

function documentWith(nodes: DesignNode[], tokens: DesignDocument["tokens"] = {}): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes = Object.fromEntries(nodes.map(node => [node.id, node]));
  document.pages["page:1"]!.childIds = nodes.filter(node => node.parentId === "page:1").map(node => node.id);
  document.tokens = tokens;
  return document;
}

test("parses 3/6 digit hex and rejects other formats", () => {
  assert.deepEqual(parseHexColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor(" #000000 "), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseHexColor("#2563eb"), { r: 37, g: 99, b: 235 });
  assert.equal(parseHexColor("red"), undefined);
  assert.equal(parseHexColor("transparent"), undefined);
  assert.equal(parseHexColor(undefined), undefined);
});

test("relative luminance matches the WCAG anchors", () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test("black on white is 21:1 and mid grey lands near 4.5", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  const grey = contrastRatio("#777777", "#ffffff");
  assert.ok(grey !== undefined && grey > 4.4 && grey < 4.6);
  assert.equal(contrastRatio("not-a-color", "#ffffff"), undefined);
});

test("large text thresholds follow WCAG", () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(18.66, 700), true);
  assert.equal(isLargeText(18.66, 400), false);
  assert.equal(isLargeText(16, 700), false);
  assert.equal(contrastThreshold(24, 400), 3);
  assert.equal(contrastThreshold(14, 400), 4.5);
});

test("backgrounds inherit from the nearest ancestor with a resolvable fill", () => {
  const card = frame("card", "page:1", "#eeeeee");
  const inner = frame("inner", "card");
  const label = text("label", "inner", { fill: "#999999" });
  card.childIds = ["inner"];
  inner.childIds = ["label"];
  const document = documentWith([card, inner, label]);
  assert.equal(effectiveBackground(document, label), "#eeeeee");
});

test("flags low-contrast text and keeps passing nodes out", () => {
  const card = frame("card", "page:1", "#ffffff");
  const bad = text("bad", "card", { fill: "#dddddd", text: "几乎看不见" });
  const good = text("good", "card", { fill: "#111111", text: "正常文字" });
  const large = text("large", "card", { fill: "#949494", fontSize: 28, text: "大标题" });
  card.childIds = ["bad", "good", "large"];
  const document = documentWith([card, bad, good, large]);

  const issues = collectContrastIssues(document);
  assert.deepEqual(issues.map(issue => issue.nodeId), ["bad"]);
  assert.equal(issues[0]?.threshold, 4.5);
  assert.ok((issues[0]?.ratio ?? 0) < 4.5);
  // 大字号只要 3:1，同一个灰色在大标题里可以通过。
  assert.equal(contrastRatio("#949494", "#ffffff")! > 3, true);
});

test("段内样式覆盖了整段文字时，不再按节点填充色报假问题", () => {
  // 底色浅、但整段被 runs 改成深色：渲染出来是深色的，不该报对比度不足。
  // 这个假问题会让编排循环反复「修」一个已经修好的地方（真实 Provider 验收里撞过）。
  const covered = text("covered", "page:1", { fill: "#999999", text: "八个字符的标题" });
  covered.runs = [{ from: 0, to: 7, style: { color: "#1f2937" } }];
  const document = documentWith([covered]);
  assert.deepEqual(collectContrastIssues(document), []);
});

test("段内样式只盖住一部分时，剩下那段仍然会被报出来", () => {
  const partial = text("partial", "page:1", { fill: "#999999", text: "八个字符的标题" });
  partial.runs = [{ from: 0, to: 4, style: { color: "#1f2937" } }];
  const document = documentWith([partial]);
  const issues = collectContrastIssues(document);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.nodeId, "partial");
  // 报出来的是**没被盖住**的那一段。
  assert.equal(issues[0]?.foreground, "#999999");
  assert.equal(issues[0]?.text, "的标题");
});

test("uses token colours when a text node is bound", () => {
  const document = documentWith(
    [text("t", "page:1", { bind: "color.ink" })],
    { "color.ink": { type: "color", value: "#f0f0f0" } },
  );
  const issues = collectContrastIssues(document);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.foreground, "#f0f0f0");
});

test("skips empty text and evaluates gradient fills through their first stop", () => {
  const gradient = text("gradient", "page:1", {});
  gradient.appearance = { ...gradient.appearance, fills: [{ type: "linear", angle: 0, stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#111111" }] }] };
  const document = documentWith([
    text("empty", "page:1", { text: "   " }),
    gradient,
  ]);
  // 渐变按首个色标近似：首色标是深色，和白色背景对比度足够，因此不报问题。
  assert.deepEqual(collectContrastIssues(document), []);
});
