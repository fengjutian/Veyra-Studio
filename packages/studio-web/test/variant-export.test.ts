import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "@ufira/design-runtime";
import { exportPageToHtml } from "@ufira/design-export";

function frame(id: string, parentId = "page:1"): DesignNode {
  return {
    id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false,
    layout: { ...defaultLayout(), width: 240, height: 120 }, appearance: defaultAppearance(),
  };
}

function text(id: string, parentId: string, value: string): DesignNode {
  return { ...frame(id, parentId), type: "text", text: value, fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
}

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:export",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

/**
 * 变体切换必须真的改变导出产物。
 *
 * 导出走的是实例物化出来的子树，所以这条测试实际上在验证「切换 → 重新物化 →
 * 导出器读到新内容」整条链路，而不仅仅是命令层的状态。
 */
test("switching an instance's variant changes the exported HTML", () => {
  const document = createDocument("doc:export", "Export", "page:1");
  const runtime = new DesignRuntime(document);
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("root") } },
    { type: "node.create", payload: { node: text("label", "root", "Default") } },
  ]));
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "label", parentId: "root", index: 0 } }]));
  runtime.execute(envelope(2, [
    { type: "component.create", payload: { id: "component:btn", nodeId: "root", name: "Button" } },
    { type: "component.setCreate", payload: { set: { id: "set:btn", name: "Button", properties: ["state"] } } },
    { type: "component.setVariant", payload: { id: "component:btn", variantSetId: "set:btn", variant: { state: "default" } } },
    { type: "component.createVariant", payload: { sourceComponentId: "component:btn", componentId: "component:btn-hover", name: "Button / hover", values: { state: "hover" } } },
  ]));
  // 变体是复制出来的：改它自己的文字副本，代表设计师给 hover 态换了文案。
  runtime.execute(envelope(3, [{ type: "text.patch", payload: { id: "component:btn-hover--label", patch: { text: "Hover" } } }]));
  runtime.execute(envelope(4, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:btn", overrides: {} } },
  }]));

  const viewport = { width: 960, height: 680 };
  const instanceHtml = (html: string) => html.slice(html.indexOf('data-node-id="instance:1"'));
  const before = exportPageToHtml(runtime.snapshot(), { pageId: "page:1", viewport });
  assert.match(instanceHtml(before.html), /Default/);

  runtime.execute(envelope(5, [{ type: "component.switchVariant", payload: { id: "instance:1", componentId: "component:btn-hover" } }]));
  const after = exportPageToHtml(runtime.snapshot() as DesignDocument, { pageId: "page:1", viewport });
  // 只看实例那一段：组件定义本身仍在页面上（它也是可导出的节点），不影响这条断言。
  assert.match(instanceHtml(after.html), /Hover/);
  assert.doesNotMatch(instanceHtml(after.html), /Default/);
  assert.match(after.html, /data-node-id="instance:1--component:btn-hover--label"/);
});
