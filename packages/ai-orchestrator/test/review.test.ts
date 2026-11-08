import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import type { DesignCommand } from "@ufira/design-runtime";
import { removedNodeIds, reviewAiPlan } from "../src/index";

function node(id: string, options: { locked?: boolean; fill?: string; bindFill?: boolean } = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: options.locked ?? false,
    layout: defaultLayout(),
    appearance: { ...defaultAppearance(), ...(options.fill ? { fills: [{ type: "solid" as const, color: options.fill }] } : {}) },
    ...(options.bindFill ? { bindings: { fill: "color.primary" } } : {}),
  };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes = Object.fromEntries(nodes.map(item => [item.id, item]));
  document.pages["page:1"]!.childIds = nodes.map(item => item.id);
  document.tokens = { "color.primary": { type: "color", value: "#2563eb" } };
  return document;
}

function without(before: DesignDocument, ...ids: string[]): DesignDocument {
  const after = structuredClone(before);
  for (const id of ids) delete after.nodes[id];
  after.pages["page:1"]!.childIds = after.pages["page:1"]!.childIds.filter(id => !ids.includes(id));
  return after;
}

test("干净的创建计划没有审查结论", () => {
  const before = documentWith([]);
  const after = structuredClone(before);
  after.nodes["frame:new"] = node("frame:new");
  after.pages["page:1"]!.childIds = ["frame:new"];
  const commands: DesignCommand[] = [{ type: "node.create", payload: { node: node("frame:new") } }];

  const review = reviewAiPlan({ before, after, commands });
  assert.deepEqual(review.findings, []);
  assert.equal(review.blocking, false);
});

test("删除锁定节点会被阻断，并列出节点 id", () => {
  const before = documentWith([node("frame:locked", { locked: true })]);
  const review = reviewAiPlan({ before, after: without(before, "frame:locked"), commands: [{ type: "node.delete", payload: { id: "frame:locked" } }] });

  assert.equal(review.blocking, true);
  const finding = review.findings.find(item => item.code === "locked-node-deleted");
  assert.deepEqual(finding?.nodeIds, ["frame:locked"]);
  assert.equal(finding?.severity, "blocking");
});

test("整篇还原与删页面都是阻断项", () => {
  const before = documentWith([]);
  const after = structuredClone(before);
  const restore = reviewAiPlan({ before, after, commands: [{ type: "history.restore", payload: { document: after } }] });
  assert.equal(restore.blocking, true);
  assert.equal(restore.findings[0]?.code, "history-restore");

  const pageDelete = reviewAiPlan({ before, after, commands: [{ type: "page.delete", payload: { id: "page:1" } }] });
  assert.equal(pageDelete.blocking, true);
  assert.equal(pageDelete.findings[0]?.code, "page-delete");
});

test("大批量删除给警告而不是阻断", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => node(`frame:${index}`));
  const before = documentWith(nodes);
  const after = without(before, ...nodes.map(item => item.id));
  const commands: DesignCommand[] = nodes.map(item => ({ type: "node.delete", payload: { id: item.id } }));

  const review = reviewAiPlan({ before, after, commands });
  const finding = review.findings.find(item => item.code === "bulk-delete");
  assert.equal(finding?.severity, "warning");
  assert.equal(finding?.nodeIds?.length, 10);
  assert.equal(review.blocking, false);
});

test("一次性新建超过二十个节点会给范围警告", () => {
  const before = documentWith([]);
  const after = structuredClone(before);
  const created = Array.from({ length: 21 }, (_, index) => node(`frame:${index}`));
  for (const item of created) after.nodes[item.id] = item;
  after.pages["page:1"]!.childIds = created.map(item => item.id);
  const commands: DesignCommand[] = created.map(item => ({ type: "node.create", payload: { node: item } }));

  const review = reviewAiPlan({ before, after, commands });
  assert.equal(review.findings.find(item => item.code === "bulk-create")?.severity, "warning");
});

test("硬编码填充色只在没有 token 绑定时提示", () => {
  const before = documentWith([]);
  const after = structuredClone(before);
  after.nodes["frame:hard"] = node("frame:hard", { fill: "#ff0000" });
  after.nodes["frame:bound"] = node("frame:bound", { fill: "#00ff00", bindFill: true });
  after.pages["page:1"]!.childIds = ["frame:hard", "frame:bound"];
  const commands: DesignCommand[] = [
    { type: "node.create", payload: { node: node("frame:hard", { fill: "#ff0000" }) } },
    { type: "node.create", payload: { node: node("frame:bound", { fill: "#00ff00", bindFill: true }) } },
  ];

  const review = reviewAiPlan({ before, after, commands });
  const finding = review.findings.find(item => item.code === "hardcoded-fill");
  assert.deepEqual(finding?.nodeIds, ["frame:hard"]);
});

test("删除集合是前后文档的节点差集", () => {
  const before = documentWith([node("a"), node("b")]);
  assert.deepEqual(removedNodeIds(before, without(before, "a")), ["a"]);
});
