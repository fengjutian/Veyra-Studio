import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { capturePageScreenshot, capturePagesScreenshot, captureSelectionScreenshot } from "../src/ai-vision";

/**
 * 视觉上下文截图的**降级分支**。
 *
 * 像素对不对只有真浏览器能回答（见 `visual/vision-probe.ts`）。这里能回答的是另一个
 * 问题：**在没有 DOM 的环境里调用它，会不会把调用方炸掉？**
 *
 * 编排层在 Node 里跑（测试、脚本、MCP 场景），那里没有 canvas。截图函数必须返回
 * undefined 让调用方退回「不带图」的文字模式，而不是抛异常。
 */

function documentWithOneNode(): DesignDocument {
  const document = createDocument("doc:vision", "Vision", "page:1");
  const node: DesignNode = {
    id: "frame:1",
    type: "frame",
    name: "卡片",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
  };
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

/** 仓库桩：截图在没有 DOM 时不会真的去读资源。 */
const repository = {} as never;

test("vision: 没有 DOM 时整页截图返回 undefined，而不是抛异常", async () => {
  const shot = await capturePageScreenshot({
    document: documentWithOneNode(),
    pageId: "page:1",
    repository,
    projectId: "project:1",
  });
  assert.equal(shot, undefined);
});

test("vision: 没有 DOM 时选区截图返回 undefined", async () => {
  const shot = await captureSelectionScreenshot({
    document: documentWithOneNode(),
    pageId: "page:1",
    repository,
    projectId: "project:1",
    nodeIds: ["frame:1"],
  });
  assert.equal(shot, undefined);
});

test("vision: 没有 DOM 时多页拼接返回 undefined", async () => {
  const shot = await capturePagesScreenshot({
    document: documentWithOneNode(),
    pageId: "page:1",
    repository,
    projectId: "project:1",
    pageIds: ["page:1"],
  });
  assert.equal(shot, undefined);
});
