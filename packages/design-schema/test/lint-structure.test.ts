import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  lintDocument,
  lintIssueActionable,
  type DesignDocument,
  type DesignNode,
  type TextNode,
} from "../src/index";

/**
 * 结构审查的三组新规则（2026-11-10）。
 *
 * 老的 lint 规则全是**单节点**的——只看一个节点自己有没有毛病。这三组规则看的是
 * **节点之间的关系**：跨页面的一致性、组件语义、设计内容的可访问性。
 *
 * 这里刻意把判据写成「宁可漏报也不误报」：跨页面一致性只在同名 + 同类型 +
 * 跨页面且差异落在肉眼可见的属性上时才报；组件语义只在能说清「哪个属性、哪个
 * 变体」时报；可访问性只看设计稿内容本身能表达的东西。
 */

function frame(id: string, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

function text(id: string, overrides: Partial<TextNode> = {}): TextNode {
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
    text: "内容",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...overrides,
  } as TextNode;
}

/** 造一篇多页文档：每页给定根节点 id。 */
function multiPage(rootIds: Record<string, string[]>): DesignDocument {
  const document = createDocument("doc:lint", "Lint");
  document.pageOrder = [];
  document.pages = {};
  for (const [pageId, children] of Object.entries(rootIds)) {
    document.pages[pageId] = { id: pageId, name: pageId, childIds: children };
    document.pageOrder.push(pageId);
  }
  return document;
}

// ── 跨页面一致性 ────────────────────────────────────────────────────

test("lint: 页面画板尺寸不一致会警告", () => {
  const document = multiPage({ "page:1": ["frame:a"], "page:2": ["frame:b"] });
  document.nodes["frame:a"] = frame("frame:a", { layout: { ...defaultLayout(), width: 1440, height: 900 } });
  document.nodes["frame:b"] = frame("frame:b", { layout: { ...defaultLayout(), width: 1200, height: 800 } });

  const issue = lintDocument(document).find(item => item.code === "page-size-mismatch");
  assert.equal(issue?.severity, "warning");
  assert.match(issue?.detail ?? "", /1440×900/);
  assert.match(issue?.detail ?? "", /1200×800/);
});

test("lint: 页面尺寸一致时不报；hug/fill 尺寸不比", () => {
  const same = multiPage({ "page:1": ["frame:a"], "page:2": ["frame:b"] });
  same.nodes["frame:a"] = frame("frame:a", { layout: { ...defaultLayout(), width: 1440, height: 900 } });
  same.nodes["frame:b"] = frame("frame:b", { layout: { ...defaultLayout(), width: 1440, height: 900 } });
  assert.equal(lintDocument(same).some(item => item.code === "page-size-mismatch"), false);

  // hug 的尺寸是算出来的，比出来没有意义。
  const hugged = multiPage({ "page:1": ["frame:a"], "page:2": ["frame:b"] });
  hugged.nodes["frame:a"] = frame("frame:a", { layout: { ...defaultLayout(), width: 1440, height: 900 } });
  hugged.nodes["frame:b"] = frame("frame:b", {
    layout: { ...defaultLayout(), width: 1200, height: 800, widthMode: "hug", heightMode: "hug" },
  });
  assert.equal(lintDocument(hugged).some(item => item.code === "page-size-mismatch"), false);
});

test("lint: 同名节点跨页面长得不一样会警告", () => {
  const document = multiPage({ "page:1": ["frame:a"], "page:2": ["frame:b"] });
  document.nodes["frame:a"] = frame("frame:a", {
    name: "按钮",
    parentId: "page:1",
    layout: { ...defaultLayout(), width: 120, height: 40 },
  });
  document.nodes["frame:b"] = frame("frame:b", {
    name: "按钮",
    parentId: "page:2",
    layout: { ...defaultLayout(), width: 160, height: 48 },
  });

  const issue = lintDocument(document).find(item => item.code === "cross-page-inconsistency");
  assert.equal(issue?.severity, "warning");
  assert.match(issue?.detail ?? "", /120×40 vs 160×48/);
});

test("lint: 同名节点同页面不算跨页面不一致；同名但类型不同也不算", () => {
  const samePage = multiPage({ "page:1": ["frame:a"] });
  samePage.nodes["frame:a"] = frame("frame:a", { name: "按钮", layout: { ...defaultLayout(), width: 120 } });
  samePage.nodes["frame:b"] = frame("frame:b", {
    name: "按钮",
    parentId: "frame:a",
    layout: { ...defaultLayout(), width: 160 },
  });
  samePage.nodes["frame:a"]!.childIds = ["frame:b"];
  assert.equal(lintDocument(samePage).some(item => item.code === "cross-page-inconsistency"), false);

  const differentType = multiPage({ "page:1": ["frame:a"], "page:2": ["text:b"] });
  differentType.nodes["frame:a"] = frame("frame:a", { name: "内容", layout: { ...defaultLayout(), width: 120 } });
  differentType.nodes["text:b"] = text("text:b", { name: "内容", parentId: "page:2" });
  assert.equal(lintDocument(differentType).some(item => item.code === "cross-page-inconsistency"), false);
});

test("lint: 跨页面一致性可以按规则关掉", () => {
  const document = multiPage({ "page:1": ["frame:a"], "page:2": ["frame:b"] });
  document.nodes["frame:a"] = frame("frame:a", { name: "按钮", layout: { ...defaultLayout(), width: 120 } });
  document.nodes["frame:b"] = frame("frame:b", { name: "按钮", parentId: "page:2", layout: { ...defaultLayout(), width: 160 } });
  const issues = lintDocument(document, { rules: { "cross-page-inconsistency": false } });
  assert.equal(issues.some(item => item.code === "cross-page-inconsistency"), false);
});

// ── 组件语义 ────────────────────────────────────────────────────────

test("lint: 变体集的属性没在某个变体上覆盖会警告", () => {
  const document = createDocument("doc:lint", "Lint");
  document.componentSets = { "set:1": { id: "set:1", name: "按钮", properties: ["状态", "尺寸"] } };
  document.components = {
    "comp:1": { id: "comp:1", name: "默认", rootNodeId: "frame:1", variantSetId: "set:1", variant: { 状态: "默认", 尺寸: "中" } },
    "comp:2": { id: "comp:2", name: "悬停", rootNodeId: "frame:2", variantSetId: "set:1", variant: { 状态: "悬停" } },
  };
  document.nodes["frame:1"] = frame("frame:1");
  document.nodes["frame:2"] = frame("frame:2");
  document.pages["page:1"]!.childIds = ["frame:1", "frame:2"];

  const issue = lintDocument(document).find(item => item.code === "variant-property-missing");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.nodeId, "frame:2");
  assert.equal(issue?.detail, "尺寸");
});

test("lint: 实例设置了组件没声明的属性会警告", () => {
  const document = createDocument("doc:lint", "Lint");
  document.components = {
    "comp:1": {
      id: "comp:1",
      name: "按钮",
      rootNodeId: "frame:1",
      properties: [{ id: "label", name: "文字", type: "text", defaultValue: "确定" }],
    },
  };
  document.nodes["frame:1"] = frame("frame:1");
  document.nodes["inst:1"] = frame("inst:1", {
    type: "instance",
    componentId: "comp:1",
    propValues: { label: "取消", ghost: "x" },
  } as unknown as Partial<DesignNode>);
  document.pages["page:1"]!.childIds = ["frame:1", "inst:1"];

  const issue = lintDocument(document).find(item => item.code === "instance-unknown-property");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.nodeId, "inst:1");
  assert.equal(issue?.detail, "ghost");
});

test("lint: 组件声明的属性没有绑定到任何节点会提示", () => {
  const document = createDocument("doc:lint", "Lint");
  document.components = {
    "comp:1": {
      id: "comp:1",
      name: "按钮",
      rootNodeId: "frame:1",
      properties: [
        { id: "label", name: "文字", type: "text", defaultValue: "确定" },
        { id: "tone", name: "色调", type: "color", defaultValue: "#000000" },
      ],
    },
  };
  document.nodes["frame:1"] = frame("frame:1");
  document.nodes["text:1"] = text("text:1", {
    parentId: "frame:1",
    componentPropertyBindings: { text: "label" },
  });
  document.nodes["frame:1"]!.childIds = ["text:1"];
  document.pages["page:1"]!.childIds = ["frame:1"];

  const issue = lintDocument(document).find(item => item.code === "unused-component-property");
  assert.equal(issue?.severity, "info");
  assert.equal(issue?.detail, "色调");
});

// ── 可访问性 ────────────────────────────────────────────────────────

test("lint: 空文本会提示", () => {
  const document = createDocument("doc:lint", "Lint");
  document.nodes["text:1"] = text("text:1", { text: "   " });
  document.pages["page:1"]!.childIds = ["text:1"];
  const issue = lintDocument(document).find(item => item.code === "empty-text");
  assert.equal(issue?.severity, "info");
  assert.equal(issue?.nodeId, "text:1");
});

test("lint: 字号低于可读下限会警告", () => {
  const document = createDocument("doc:lint", "Lint");
  document.nodes["text:1"] = text("text:1", { fontSize: 8 });
  document.nodes["text:2"] = text("text:2", { fontSize: 16 });
  document.pages["page:1"]!.childIds = ["text:1", "text:2"];
  const issue = lintDocument(document).find(item => item.code === "tiny-text");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.nodeId, "text:1");
  assert.equal(issue?.detail, "8px");
});

test("lint: 带交互的节点用默认名会警告；有意义的名字就不报", () => {
  const document = createDocument("doc:lint", "Lint");
  const interaction = { eventType: "click" as const, actionType: "navigate" as const, destination: null };
  document.nodes["frame:1"] = frame("frame:1", { name: "Frame", interactions: [interaction] });
  document.nodes["frame:2"] = frame("frame:2", { name: "提交按钮", interactions: [interaction] });
  document.pages["page:1"]!.childIds = ["frame:1", "frame:2"];

  const issues = lintDocument(document).filter(item => item.code === "interactive-without-name");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.nodeId, "frame:1");
  assert.equal(issues[0]?.severity, "warning");
});

// ── 能不能自动修（决定是否进体检层的待修清单） ──────────────────────

test("lint: 需要人决策的结论不算可自动修", () => {
  // 有明确修法的：模型能自己改对。
  assert.equal(lintIssueActionable("hardcoded-fill"), true);
  assert.equal(lintIssueActionable("off-grid"), true);
  assert.equal(lintIssueActionable("empty-text"), true);
  assert.equal(lintIssueActionable("tiny-text"), true);
  assert.equal(lintIssueActionable("interactive-without-name"), true);
  assert.equal(lintIssueActionable("variant-property-missing"), true);
  assert.equal(lintIssueActionable("instance-unknown-property"), true);

  // 没有唯一答案的：统一成多大？以哪边为准？该删属性还是加绑定？
  // 这些丢给模型只会让它反复瞎猜——那正是编排循环「震荡」的来源。
  assert.equal(lintIssueActionable("page-size-mismatch"), false);
  assert.equal(lintIssueActionable("cross-page-inconsistency"), false);
  assert.equal(lintIssueActionable("unused-component-property"), false);
});
