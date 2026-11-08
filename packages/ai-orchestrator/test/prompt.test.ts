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
