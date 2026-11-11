import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument } from "@ufira/design-schema";
import { buildPlannerPrompt, summarizeDocument } from "../src/index";

function documentWithText(): DesignDocument {
  const document = createDocument("doc:1", "测试文档", "page:1");
  document.nodes["text:1"] = {
    id: "text:1",
    type: "text",
    name: "标题",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 48, y: 212, width: 160, height: 48 },
    appearance: { ...defaultAppearance() },
    text: "双击编辑文本",
    fontFamily: "Inter",
    fontSize: 20,
    lineHeight: 28,
  };
  document.pages["page:1"]!.childIds = ["text:1"];
  document.tokens["color.primary"] = { type: "color", value: "#6366f1" };
  return document;
}

test("the system prompt spells out the command vocabulary and the JSON contract", () => {
  const { system } = buildPlannerPrompt({ prompt: "改个颜色", document: documentWithText(), selectedNodeIds: [] });
  assert.match(system, /node\.create/);
  assert.match(system, /text\.patch/);
  assert.match(system, /summary/);
  assert.match(system, /commands/);
});

test("命令词汇表说清 node.patch 不收文字字段，改文字必须走 text.patch", () => {
  // 实测的故障：模型往 node.patch 里写 text / fontSize，运行时判未知字段直接拒，
  // 一轮 40 秒白花。词汇表里要把「不收哪些字段」写成否定式清单。
  const { system } = buildPlannerPrompt({ prompt: "改个颜色", document: documentWithText(), selectedNodeIds: [] });
  assert.match(system, /node\.patch 的 patch 里\*\*没有\*\* text \/ fontSize \/ fontFamily/);
  assert.match(system, /改文字内容与文字样式一律用 text\.patch/);
});

test("硬性规则明说不要按命名规律猜节点 id", () => {
  // 实测的故障：模型把 text:xxx-user-id 写成 text:xxx-user-id-label，节点不存在，
  // 连猜三次都错。规则要写成「原样出现」+「不要推测或改写」。
  const { system } = buildPlannerPrompt({ prompt: "改个颜色", document: documentWithText(), selectedNodeIds: [] });
  assert.match(system, /原样出现/);
  assert.match(system, /不要按命名规律推测或改写 id/);
});

test("the user prompt carries the request, the real node ids and the selection", () => {
  const { user } = buildPlannerPrompt({ prompt: "把标题改成红色", document: documentWithText(), selectedNodeIds: ["text:1"] });
  assert.match(user, /把标题改成红色/);
  assert.match(user, /text:1/);
  assert.match(user, /color\.primary/);
  assert.match(user, /当前选中：text:1/);
});

test("the document summary lists pages, nodes, tokens and components", () => {
  const summary = summarizeDocument(documentWithText(), ["text:1"]);
  assert.match(summary, /page:1/);
  assert.match(summary, /text:1 名称="标题"/);
  assert.match(summary, /文本="双击编辑文本"/);
  assert.match(summary, /color\.primary = #6366f1/);
  assert.match(summary, /组件：/);
});

test("单页范围：摘要里不给别的页面的节点 id", () => {
  // 实测的故障：摘要里带着别页的节点 id 时，模型会把它们当成「现成节点」逐个 patch，
  // 整份计划被单页范围审查拦下，连试三次都是同一批节点。
  const document = createDocument("doc:1", "测试文档", "page:1");
  document.pageOrder = ["page:1", "page:2"];
  document.pages["page:2"] = {
    id: "page:2",
    name: "第二页",
    childIds: ["frame:other"],
    width: 960,
    height: 680,
  };
  document.nodes["frame:other"] = {
    id: "frame:other",
    type: "frame",
    name: "别的页的侧栏",
    parentId: "page:2",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 240, height: 900 },
    appearance: { ...defaultAppearance() },
  };
  document.nodes["text:mine"] = {
    id: "text:mine",
    type: "text",
    name: "本页文字",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 100, height: 20 },
    appearance: { ...defaultAppearance() },
    text: "本页",
    fontFamily: "Inter",
    fontSize: 14,
    lineHeight: 21,
  };
  document.pages["page:1"]!.childIds = ["text:mine"];

  const scoped = summarizeDocument(document, [], "page:1");
  assert.match(scoped, /text:mine/);
  assert.doesNotMatch(scoped, /frame:other/);
  assert.match(scoped, /page:2 名称="第二页"（本次不涉及这一页/);

  // 不限定页面时照旧全列。
  const all = summarizeDocument(document, []);
  assert.match(all, /frame:other/);

  // 提示里也要把边界说清楚。
  const { user } = buildPlannerPrompt({ prompt: "画这一页", document, selectedNodeIds: [], scopePageId: "page:1" });
  assert.match(user, /只做页面 page:1/);
  assert.doesNotMatch(user, /frame:other/);
});

test("the summary describes every fill kind without assuming a linear gradient", () => {
  const document = documentWithText();
  const node = document.nodes["text:1"]!;
  const stops = [
    { offset: 0, color: "#f9fafb" },
    { offset: 1, color: "#111827" },
  ];

  node.appearance.fills = [{ type: "solid", color: "#111827" }];
  assert.match(summarizeDocument(document, []), /填充=#111827/);

  node.appearance.fills = [{ type: "linear", angle: 90, stops }];
  assert.match(summarizeDocument(document, []), /填充=线性渐变\(90deg\)/);

  // 回归：这里此前只判断 solid，其余一律按 linear 读 angle，径向渐变会让 dts 构建失败。
  node.appearance.fills = [{ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops }];
  assert.match(summarizeDocument(document, []), /填充=径向渐变\(中心 50%,50%，半径 50%\)/);
});

test("没有截图时提示里不出现截图相关的字样", () => {
  const { user } = buildPlannerPrompt({ prompt: "把标题改成红色", document: documentWithText(), selectedNodeIds: [] });
  assert.doesNotMatch(user, /截图/);
});

test("带截图时提示讲清了图与文字摘要各管什么", () => {
  const { user } = buildPlannerPrompt({
    prompt: "把标题改成红色",
    document: documentWithText(),
    selectedNodeIds: ["text:1"],
    image: { dataUrl: "data:image/png;base64,AAA", mimeType: "image/png", width: 960, height: 640 },
  });
  assert.match(user, /截图/);
  assert.match(user, /960×640/);
  // 分工必须讲清楚：模型分不清「图管观感、摘要管数值」就会拿截图里的模糊印象去改精确数值。
  assert.match(user, /观感/);
  assert.match(user, /精确/);
  // 截图说明排在文档摘要之前：先说「这是图」，再给「这是数值」。
  assert.ok(user.indexOf("截图") < user.indexOf("当前文档："));
});

test("截图范围写进提示：模型得知道这张图是整页、选区还是拼图", () => {
  const { user } = buildPlannerPrompt({
    prompt: "把标题改成红色",
    document: documentWithText(),
    selectedNodeIds: [],
    image: {
      dataUrl: "data:image/png;base64,AAA",
      mimeType: "image/png",
      width: 528,
      height: 142,
      label: "全部 2 个页面（从左到右）",
    },
  });
  // 不说明范围，模型会把拼图当成一张奇怪的页面来读。
  assert.match(user, /全部 2 个页面（从左到右）/);
  assert.match(user, /截图/);
});

test("没有 label 时退回「当前画面」，提示仍然完整", () => {
  const { user } = buildPlannerPrompt({
    prompt: "把标题改成红色",
    document: documentWithText(),
    selectedNodeIds: [],
    image: { dataUrl: "data:image/png;base64,AAA", mimeType: "image/png", width: 960, height: 640 },
  });
  assert.match(user, /附上了当前画面的截图/);
});
