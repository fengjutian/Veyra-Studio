import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToReact } from "../src/index";

function frame(id: string, parentId = "page:1"): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.pages["page:1"].childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

/** 把生成的 TSX 里的 style 对象抠出来，还原成 `prop:value` 的集合。 */
function reactStyles(code: string): string[][] {
  const blocks: string[][] = [];
  const pattern = /style=\{\{([\s\S]*?)\}\}/g;
  for (const match of code.matchAll(pattern)) {
    const body = match[1] ?? "";
    const pairs: string[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim().replace(/,$/, "");
      if (!trimmed) continue;
      const index = trimmed.indexOf(":");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim().replace(/^"|"$/g, "");
      const value = trimmed.slice(index + 1).trim().replace(/^"|"$/g, "");
      pairs.push(`${key}:${value}`);
    }
    blocks.push(pairs);
  }
  return blocks;
}

/** HTML 导出里第一个节点的 style 声明。 */
function htmlFirstStyle(document: string): string[] {
  const match = /style="([^"]*)"/.exec(document);
  assert.ok(match, "HTML 导出里应该有 style 属性");
  return (match[1] ?? "").split(";").filter(Boolean).map(item => item.trim());
}

test("导出的组件带 props 接口，文字与图片地址变成 prop", () => {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  const text: DesignNode = { ...frame("text", root.id), type: "text", text: "你好", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  root.childIds = [text.id];
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  document.nodes[text.id] = text;

  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // 组件名默认取页面名。
  assert.match(result.code, /export interface Page1Props/);
  assert.match(result.code, /text\?: string/);
  // 默认值就是设计稿里的文字：调用方不传 prop 时看到的就是设计稿。
  assert.match(result.code, /text = "你好"/);
  assert.deepEqual(result.props.map(prop => prop.name), ["text"]);
  assert.equal(result.props[0]?.defaultValue, "你好");
});

test("图片地址是 prop；取不到地址时给占位并记诊断", () => {
  const document = createDocument("doc:1", "Demo");
  const image: DesignNode = { ...frame("cover"), type: "image", assetId: "asset:1", fit: "cover" };
  document.assets["asset:1"] = { id: "asset:1", hash: "a".repeat(64), mimeType: "image/png", byteLength: 10 };
  document.pages["page:1"].childIds = [image.id];
  document.nodes[image.id] = image;

  const withUrl = exportPageToReact(document, {
    pageId: "page:1",
    viewport: { width: 800, height: 600 },
    resolveAsset: () => "data:image/png;base64,AAAA",
  });
  assert.match(withUrl.code, /coverSrc\?: string/);
  assert.match(withUrl.code, /src=\{coverSrc\}/);

  const withoutUrl = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(withoutUrl.code, /role="img"/);
  assert.equal(withoutUrl.diagnostics[0]?.feature, "image-asset");
  assert.equal(withoutUrl.diagnostics[0]?.support, "unsupported");
});

test("拒绝不安全的图片地址", () => {
  const document = createDocument("doc:1", "Demo");
  const image: DesignNode = { ...frame("cover"), type: "image", assetId: "asset:1", fit: "cover" };
  document.assets["asset:1"] = { id: "asset:1", hash: "a".repeat(64), mimeType: "image/png", byteLength: 10 };
  document.pages["page:1"].childIds = [image.id];
  document.nodes[image.id] = image;
  const result = exportPageToReact(document, {
    pageId: "page:1",
    viewport: { width: 800, height: 600 },
    resolveAsset: () => "javascript:alert(1)",
  });
  assert.doesNotMatch(result.code, /javascript:/);
  assert.equal(result.diagnostics[0]?.support, "unsupported");
});

test("样式与 HTML 导出逐条一致（两边共用同一套计算）", () => {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  root.layout = { ...defaultLayout(), x: 40, y: 60, width: 360, height: 220 };
  root.appearance.fills = [{ type: "solid", color: "#ffffff" }];
  root.appearance.stroke = "#e2e8f0";
  root.appearance.strokeWidth = 2;
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;

  const html = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  const react = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });

  const htmlPairs = htmlFirstStyle(html.document);
  const reactPairs = reactStyles(react.code)[0] ?? [];
  // React 额外补了 HTML 靠全局规则兜底的三条（box-sizing / min-width / min-height）。
  const extra = new Set(["boxSizing:border-box", "minWidth:0", "minHeight:0"]);
  const reactShared = reactPairs.filter(pair => !extra.has(pair));
  assert.deepEqual([...reactShared].sort(), [...htmlPairs].sort());
});
test("token 绑定变成 CSS 变量，且变量定义在根元素上", () => {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  root.appearance.fills = [{ type: "solid", color: "#000000" }];
  root.bindings = { fill: "Color/Primary" };
  document.tokens["Color/Primary"] = { type: "color", value: "#3366ff" };
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;

  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.code, /"--color-primary": "#3366ff"/);
  assert.match(result.code, /background: "var\(--color-primary\)"/);
});

test("字重是数字而不是字符串（字符串会让 TypeScript 报错）", () => {
  const document = createDocument("doc:1", "Demo");
  const text: DesignNode = {
    ...frame("title"),
    type: "text",
    text: "标题",
    fontFamily: "Inter",
    fontSize: 24,
    lineHeight: 32,
    fontWeight: 700,
  };
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.code, /fontWeight: 700,/);
  assert.doesNotMatch(result.code, /fontWeight: "700"/);
});

test("带段内样式的文字不做 prop 化，并如实记诊断", () => {
  const document = createDocument("doc:1", "Demo");
  const text: DesignNode = {
    ...frame("rich"),
    type: "text",
    text: "一半一半",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    runs: [{ from: 0, to: 2, style: { fontWeight: 700 } }],
  };
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.equal(result.props.length, 0);
  assert.equal(result.diagnostics[0]?.feature, "text-prop");
  assert.match(result.code, /<span style=\{\{/);
});

test("含特殊字符的文字用字符串表达式，不会截断 JSX", () => {
  const document = createDocument("doc:1", "Demo");
  // 用带段内样式的文字：它不走 prop 路径，内容直接落在 JSX 里。
  const text: DesignNode = {
    ...frame("t"),
    type: "text",
    text: "<b>{x}</b>",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    runs: [{ from: 0, to: 3, style: { fontWeight: 700 } }],
  };
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.code, /\{"<b>"\}/);
  assert.match(result.code, /\{"\{x\}<\/b>"\}/);
  assert.doesNotMatch(result.code, />\{x\}</);
});

test("组件名与 prop 名都做了合法化", () => {
  const document = documentWith([frame("frame-1")]);
  document.nodes["frame-1"]!.name = "首页 / hero 区";
  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 }, componentName: "首页 / hero 区" });
  assert.equal(result.componentName, "首页Hero区");
  assert.match(result.code, /export function 首页Hero区\(/);
});

test("只导出选中的分支", () => {
  const document = documentWith([frame("a"), frame("b")]);
  const result = exportPageToReact(document, { pageId: "page:1", viewport: { width: 800, height: 600 }, nodeIds: ["a"] });
  assert.match(result.code, /data-node-id="a"/);
  assert.doesNotMatch(result.code, /data-node-id="b"/);
});
