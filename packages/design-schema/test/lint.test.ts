import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  lintDocument,
  lintSummary,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 设计 lint。
 *
 * 与 `validateDocument()` 不同：lint 不阻止保存，只提示「会让设计系统腐坏」的问题；
 * 规则只在文档确实有对应 token 体系时才报告，避免给没有 token 的文档制造噪声。
 */

function node(id: string, overrides: Partial<DesignNode> = {}): DesignNode {
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

function documentWith(nodes: DesignNode[], tokens: DesignDocument["tokens"] = {}): DesignDocument {
  const document = createDocument("doc:lint", "Lint");
  document.tokens = tokens;
  for (const item of nodes) document.nodes[item.id] = item;
  const roots = nodes.filter(item => item.parentId === "page:1");
  document.pages["page:1"]!.childIds = roots.map(item => item.id);
  for (const item of nodes) {
    if (item.parentId === "page:1") continue;
    const parent = document.nodes[item.parentId];
    if (parent) parent.childIds = [...parent.childIds, item.id];
  }
  return document;
}

const colorToken = { "gray.900": { type: "color" as const, value: "#111111" } };
const numberToken = { "space.md": { type: "number" as const, value: 16 } };

test("lint: 没有颜色 token 的文档不报硬编码填充", () => {
  const document = documentWith([node("frame:1", { appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] } })]);
  assert.deepEqual(lintDocument(document).filter(issue => issue.code === "hardcoded-fill"), []);
});

test("lint: 有颜色 token 时硬编码填充给提示，绑定后消失", () => {
  const hardcoded = node("frame:1", { appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] } });
  const bound = node("frame:2", {
    appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] },
    bindings: { fill: "gray.900" },
  });

  const loose = lintDocument(documentWith([hardcoded], colorToken));
  const issue = loose.find(item => item.code === "hardcoded-fill");
  assert.equal(issue?.nodeId, "frame:1");
  assert.equal(issue?.detail, "#ff0000");

  const bound_ = lintDocument(documentWith([bound], colorToken));
  assert.equal(bound_.some(item => item.code === "hardcoded-fill"), false);
});

test("lint: 通过别名绑定填充不算硬编码", () => {
  const document = documentWith(
    [node("frame:1", {
      appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] },
      bindings: { fill: "text.primary" },
    })],
    { ...colorToken, "text.primary": { type: "alias", value: "gray.900" } },
  );
  assert.equal(lintDocument(document).some(item => item.code === "hardcoded-fill"), false);
});

test("lint: 自动布局间距没绑数值 token 时提示", () => {
  const container = node("frame:1", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 12 } });
  const bound = node("frame:2", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 12 }, bindings: { spacing: "space.md" } });

  const issues = lintDocument(documentWith([container], numberToken));
  assert.equal(issues.find(item => item.code === "unbound-spacing")?.detail, "12px");

  assert.equal(lintDocument(documentWith([bound], numberToken)).some(item => item.code === "unbound-spacing"), false);
  // 没有数值 token 时不报。
  assert.equal(lintDocument(documentWith([container])).some(item => item.code === "unbound-spacing"), false);
});

test("lint: 位置不在栅格上会警告，布局托管的子节点不检查", () => {
  const off = node("frame:1", { layout: { ...defaultLayout(), x: 13, y: 8 } });
  const issue = lintDocument(documentWith([off])).find(item => item.code === "off-grid");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.detail, "x=13");

  // stack 子节点的位置由布局引擎决定，报它没有意义。
  const container = node("frame:stack", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical" } });
  const child = node("frame:child", { parentId: "frame:stack", layout: { ...defaultLayout(), x: 13, y: 8 } });
  const document = documentWith([container, child]);
  assert.equal(lintDocument(document).some(item => item.code === "off-grid"), false);
});

test("lint: grid 选项为 1 时关闭栅格规则，也可以按规则关闭", () => {
  const off = node("frame:1", { layout: { ...defaultLayout(), x: 13 } });
  assert.equal(lintDocument(documentWith([off]), { grid: 1 }).some(item => item.code === "off-grid"), false);
  assert.equal(lintDocument(documentWith([off]), { rules: { "off-grid": false } }).some(item => item.code === "off-grid"), false);
});

test("lint: 同级重名只报一条，跨页不算同级", () => {
  const first = node("frame:1", { name: "Card" });
  const second = node("frame:2", { name: "Card" });
  const issues = lintDocument(documentWith([first, second])).filter(item => item.code === "duplicate-name");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.nodeId, "frame:1");
  assert.match(issues[0]?.detail ?? "", /frame:1, frame:2/);

  const document = createDocument("doc:lint", "Lint");
  document.pages["page:1"]!.childIds = ["a"];
  document.nodes.a = node("a", { name: "Card" });
  document.pages["page:2"] = { id: "page:2", name: "Second", childIds: ["b"] } as never;
  document.pageOrder.push("page:2");
  document.nodes.b = node("b", { name: "Card", parentId: "page:2" });
  assert.equal(lintDocument(document).some(item => item.code === "duplicate-name"), false);
});

test("lint: 同级的文本框叠在一起要报 text-overlap", () => {
  // 实测出来的：AI 把两行文字塞进高度不够的框里，渲染出来名字和邮箱叠成两行。
  // 每一行单独看都合法（字号正常、内容非空、位置在栅格上），只有两个框叠着才是问题。
  const text = (id: string, x: number, y: number, height: number): DesignNode =>
    node(id, {
      type: "text",
      layout: { ...defaultLayout(), x, y, width: 200, height },
      text: id,
      fontSize: 14,
      lineHeight: 21,
    } as Partial<DesignNode>);

  const overlapping = documentWith([text("text:a", 16, 20, 18), text("text:b", 16, 30, 18)]);
  const issues = lintDocument(overlapping).filter(item => item.code === "text-overlap");
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? "", /text:a/);
  assert.match(issues[0]?.message ?? "", /text:b/);

  // 挨着但不叠：不算问题。
  const adjacent = documentWith([text("text:a", 16, 20, 18), text("text:b", 16, 38, 18)]);
  assert.equal(lintDocument(adjacent).some(item => item.code === "text-overlap"), false);
});

test("lint: 节点超出页面画布要报 out-of-bounds", () => {
  // 实测出来的：模型把内容排得比画布高，页面底部的按钮条落在 900 之外，
  // 截图上只看得见半条。每一行单独看都合法，只有相对整页画布才知道越界了。
  const document = documentWith([node("frame:1", { layout: { ...defaultLayout(), x: 1200, y: 20, width: 400, height: 100 } })]);
  document.pages["page:1"]!.width = 1440;
  document.pages["page:1"]!.height = 900;
  const issues = lintDocument(document).filter(item => item.code === "out-of-bounds");
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.detail ?? "", /右边超出 160px/);
});

test("lint: 越界只报根因，被牵连的子节点不重复报", () => {
  // 根因几乎总是最外层那个超尺寸的容器；把它挪好，里面的子节点跟着就好。
  // 只报根因，结论数量能从几十条收敛到几条，模型一轮修得完。
  const card = node("frame:card", { layout: { ...defaultLayout(), x: 1200, y: 20, width: 400, height: 200 } });
  const label = node("text:1", {
    parentId: "frame:card",
    type: "text",
    text: "标签",
    fontSize: 14,
    lineHeight: 20,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 200, height: 20 },
  } as Partial<DesignNode>);
  const document = documentWith([card, label]);
  document.pages["page:1"]!.width = 1440;
  document.pages["page:1"]!.height = 900;
  const issues = lintDocument(document).filter(item => item.code === "out-of-bounds");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.nodeId, "frame:card");
});

test("lint: 同级的两个容器压住要报 frame-overlap", () => {
  // 实测出来的：新建订单页的「收货信息」卡片被下面的「支付方式」卡片盖掉半张。
  // 文本重叠规则查不出来——压住的是两张卡片，文字框本身没有互相压。
  const left = node("frame:a", { layout: { ...defaultLayout(), x: 20, y: 20, width: 400, height: 300 } });
  const right = node("frame:b", { layout: { ...defaultLayout(), x: 200, y: 100, width: 400, height: 300 } });
  const issues = lintDocument(documentWith([left, right])).filter(item => item.code === "frame-overlap");
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.message ?? "", /frame:a/);
  assert.match(issues[0]?.message ?? "", /frame:b/);
});

test("lint: 铺满页面的背景层不算容器重叠", () => {
  // 登录页的整页背景里就放着登录卡片，这本来就该叠着，不能报。
  const background = node("frame:bg", { layout: { ...defaultLayout(), x: 0, y: 0, width: 960, height: 680 } });
  const card = node("frame:card", { layout: { ...defaultLayout(), x: 280, y: 130, width: 400, height: 420 } });
  const document = documentWith([background, card]);
  assert.equal(lintDocument(document).some(item => item.code === "frame-overlap"), false);
});

test("lint: 子节点跑出父容器要报 out-of-parent", () => {
  // 实测出来的：模型把卡片改窄（1032 → 824）来解决「超出画布」，却没动里面的子节点——
  // 文字于是跑出卡片 184px。改父不改子，边界就破了。
  const card = node("frame:card", { layout: { ...defaultLayout(), x: 20, y: 20, width: 300, height: 200 } });
  const label = node("text:1", {
    parentId: "frame:card",
    type: "text",
    text: "标签",
    fontSize: 14,
    lineHeight: 20,
    layout: { ...defaultLayout(), x: 250, y: 10, width: 200, height: 20 },
  } as Partial<DesignNode>);
  const issues = lintDocument(documentWith([card, label])).filter(item => item.code === "out-of-parent");
  assert.equal(issues.length, 1);
  assert.match(issues[0]?.detail ?? "", /右边超出 150px/);
});

test("lint: 背景层里的子节点不算跑出父容器", () => {
  // 背景层铺满页面，它里面的东西超出背景边界是允许的。
  const background = node("frame:bg", { layout: { ...defaultLayout(), x: 0, y: 0, width: 960, height: 680 } });
  const stray = node("text:x", {
    parentId: "frame:bg",
    type: "text",
    text: "跑到外面了",
    fontSize: 14,
    lineHeight: 20,
    layout: { ...defaultLayout(), x: 900, y: 600, width: 300, height: 20 },
  } as Partial<DesignNode>);
  const document = documentWith([background, stray]);
  assert.equal(lintDocument(document).some(item => item.code === "out-of-parent"), false);
});

test("lint: 汇总按严重程度计数", () => {  const summary = lintSummary([    { code: "off-grid", severity: "warning", message: "" },
    { code: "duplicate-name", severity: "info", message: "" },
  ]);
  assert.deepEqual(summary, { warnings: 1, infos: 1, total: 2 });
});

test("lint: 空文档没有结论", () => {
  assert.deepEqual(lintDocument(createDocument("doc:empty", "Empty")), []);
});

// —— 判定阈值可配（默认行为不变）——
//
// 这些阈值以前是写死的魔数。密集排布的稿子和疏朗排布的稿子要的尺度根本不一样，
// 一个阈值不可能同时对，所以要能配。

test("lint: 文本重叠面积阈值可配", () => {
  const text = (id: string, y: number): DesignNode =>
    node(id, {
      type: "text",
      text: id,
      fontSize: 14,
      lineHeight: 20,
      layout: { ...defaultLayout(), x: 16, y, width: 200, height: 18 },
    } as Partial<DesignNode>);

  const document = documentWith([text("text:a", 20), text("text:b", 30)]);
  assert.equal(lintDocument(document).filter(item => item.code === "text-overlap").length, 1);

  // 阈值调到 2000：同样的重叠（1600px²）不再算问题。
  assert.equal(lintDocument(document, { textOverlapArea: 2_000 }).some(item => item.code === "text-overlap"), false);
  // 阈值调到 1：轻微重叠也算问题。
  assert.equal(lintDocument(document, { textOverlapArea: 1 }).filter(item => item.code === "text-overlap").length, 1);
});

test("lint: 越界容差可配", () => {
  const document = documentWith([node("frame:1", { layout: { ...defaultLayout(), x: 1200, y: 20, width: 400, height: 100 } })]);
  document.pages["page:1"]!.width = 1440;
  document.pages["page:1"]!.height = 900;
  assert.equal(lintDocument(document).filter(item => item.code === "out-of-bounds").length, 1);

  // 容差放到 200：右边只超出 160px，不再算越界。
  assert.equal(lintDocument(document, { outOfBoundsTolerance: 200 }).some(item => item.code === "out-of-bounds"), false);
});

test("lint: 容器重叠面积阈值可配", () => {
  const left = node("frame:a", { layout: { ...defaultLayout(), x: 20, y: 20, width: 400, height: 300 } });
  const right = node("frame:b", { layout: { ...defaultLayout(), x: 200, y: 100, width: 400, height: 300 } });
  const document = documentWith([left, right]);
  assert.equal(lintDocument(document).filter(item => item.code === "frame-overlap").length, 1);

  // 重叠 48400px²，阈值放到十万就不再算压住。
  assert.equal(lintDocument(document, { frameOverlapArea: 100_000 }).some(item => item.code === "frame-overlap"), false);
});

test("lint: 文本超出父容器的容差可配", () => {
  const card = node("frame:card", { layout: { ...defaultLayout(), x: 20, y: 20, width: 300, height: 200 } });
  const label = node("text:label", {
    parentId: "frame:card",
    type: "text",
    text: "标签",
    fontSize: 14,
    lineHeight: 20,
    layout: { ...defaultLayout(), x: 250, y: 10, width: 200, height: 20 },
  } as Partial<DesignNode>);
  const document = documentWith([card, label]);
  assert.equal(lintDocument(document).filter(item => item.code === "out-of-parent").length, 1);

  // 容差放到 200：右边只超出 150px，不再算跑出父容器。
  assert.equal(lintDocument(document, { textOverflowTolerance: 200 }).some(item => item.code === "out-of-parent"), false);
});

test("lint: 可读字号下限可配", () => {
  const label = node("text:tiny", {
    type: "text",
    text: "小字",
    fontSize: 10,
    lineHeight: 14,
    layout: { ...defaultLayout(), x: 16, y: 16, width: 100, height: 20 },
  } as Partial<DesignNode>);
  const document = documentWith([label]);
  assert.equal(lintDocument(document).filter(item => item.code === "tiny-text").length, 1);
  assert.equal(lintDocument(document, { minReadableFontSize: 8 }).some(item => item.code === "tiny-text"), false);
});

test("lint: 背景层判定比例可配", () => {
  const background = node("frame:bg", { layout: { ...defaultLayout(), x: 0, y: 0, width: 600, height: 480 } });
  const card = node("frame:card", { layout: { ...defaultLayout(), x: 100, y: 100, width: 400, height: 400 } });
  const document = documentWith([background, card]);
  document.pages["page:1"]!.width = 1000;
  document.pages["page:1"]!.height = 800;

  // 默认 0.9：背景只有 60%，不算背景层，于是和卡片压住了。
  assert.equal(lintDocument(document).filter(item => item.code === "frame-overlap").length, 1);
  // 比例调到 0.5：背景层被放行，不再报压住。
  assert.equal(lintDocument(document, { backgroundSizeRatio: 0.5 }).some(item => item.code === "frame-overlap"), false);
});
