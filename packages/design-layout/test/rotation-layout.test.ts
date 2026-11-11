import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode, type GridTrack } from "@ufira/design-schema";
import { computePageLayout } from "../src/index";

/**
 * 旋转参与自动布局重排。
 *
 * 语义：旋转是绘制时的变换，**盒子尺寸不变**；变的是**占位**——自动布局按旋转后的
 * 视觉包围盒留位，兄弟节点因此让开，转出去的内容不会压在下一个节点身上。
 *
 * 这与 Figma 不同（Figma 的旋转不影响布局，转出去的内容会盖住邻居），是本项目
 * 主动选的语义：宁可让位，也不要压住。
 */

function node(id: string, parentId: string, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

function documentWith(root: DesignNode, children: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Rotation");
  root.childIds = children.map(child => child.id);
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  for (const child of children) document.nodes[child.id] = child;
  return document;
}

/** 100×100 的盒子转 45° 之后的包围盒边长。 */
const DIAGONAL = 100 * Math.SQRT2;

const close = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 0.01, `期望 ${expected}，实际 ${actual}`);
};

test("竖向 stack：旋转的子节点占位变大，后面的兄弟节点往下让", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", width: 300, height: 400 };
  const turned = node("turned", "root");
  turned.layout = { ...defaultLayout(), width: 100, height: 100, rotation: 45 };
  const next = node("next", "root");
  next.layout = { ...defaultLayout(), width: 100, height: 100 };

  const result = computePageLayout(documentWith(root, [turned, next]), "page:1", { viewport: { width: 800, height: 600 } });
  // 盒子尺寸不变：旋转是绘制时的变换。
  assert.equal(result.boxes.turned?.width, 100);
  assert.equal(result.boxes.turned?.height, 100);
  // 盒子在槽位里居中，转出去的部分刚好落在槽位内。
  // 主轴（纵向）上居中 → 盒子往下挪半个差值；交叉轴（横向）上也居中 → 往右挪同样多。
  close(result.boxes.turned?.y ?? 0, (DIAGONAL - 100) / 2);
  close(result.boxes.turned?.x ?? 0, (DIAGONAL - 100) / 2);
  // 兄弟节点从旋转后的包围盒之后开始。
  close(result.boxes.next?.y ?? 0, DIAGONAL);
});

test("横向 stack：同样的规则作用在主轴的另一侧", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "horizontal", width: 400, height: 200 };
  const turned = node("turned", "root");
  turned.layout = { ...defaultLayout(), width: 100, height: 100, rotation: 45 };
  const next = node("next", "root");
  next.layout = { ...defaultLayout(), width: 100, height: 100 };

  const result = computePageLayout(documentWith(root, [turned, next]), "page:1", { viewport: { width: 800, height: 600 } });
  close(result.boxes.turned?.x ?? 0, (DIAGONAL - 100) / 2);
  close(result.boxes.next?.x ?? 0, DIAGONAL);
});

test("hug 容器按旋转后的包围盒算尺寸", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", widthMode: "hug", heightMode: "hug" };
  const turned = node("turned", "root");
  turned.layout = { ...defaultLayout(), width: 100, height: 100, rotation: 45 };

  const result = computePageLayout(documentWith(root, [turned]), "page:1", { viewport: { width: 800, height: 600 } });
  close(result.boxes.root?.width ?? 0, DIAGONAL);
  close(result.boxes.root?.height ?? 0, DIAGONAL);
});

test("绝对定位的父级不受影响：旋转不挪动兄弟节点", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "absolute", width: 300, height: 400 };
  const turned = node("turned", "root");
  turned.layout = { ...defaultLayout(), width: 100, height: 100, rotation: 45 };
  const next = node("next", "root");
  next.layout = { ...defaultLayout(), x: 200, y: 200, width: 100, height: 100 };

  const result = computePageLayout(documentWith(root, [turned, next]), "page:1", { viewport: { width: 800, height: 600 } });
  // 绝对定位按坐标摆，旋转不改坐标。
  assert.deepEqual(result.boxes.next, { x: 200, y: 200, width: 100, height: 100 });
  assert.equal(result.boxes.turned?.width, 100);
});

test("grid：自动轨道按旋转后的包围盒变宽，盒子在格子里居中", () => {
  const root = node("root", "page:1");
  root.layout = {
    ...defaultLayout(),
    mode: "grid",
    width: 400,
    height: 300,
    grid: { columns: [{ type: "auto" }] as GridTrack[], rows: [{ type: "auto" }] as GridTrack[], columnGap: 0, rowGap: 0 },
  };
  const turned = node("turned", "root");
  turned.layout = { ...defaultLayout(), width: 100, height: 100, rotation: 45 };

  const result = computePageLayout(documentWith(root, [turned]), "page:1", { viewport: { width: 800, height: 600 } });
  // 盒子保持逻辑尺寸，位置在格子里居中。
  assert.equal(result.boxes.turned?.width, 100);
  assert.equal(result.boxes.turned?.height, 100);
  close(result.boxes.turned?.x ?? 0, (DIAGONAL - 100) / 2);
  close(result.boxes.turned?.y ?? 0, (DIAGONAL - 100) / 2);
});

test("没有旋转时排版结果逐字不变", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", width: 200, height: 160, gap: 10, padding: { top: 10, right: 20, bottom: 10, left: 20 } };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 50, height: 30 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 60, height: 40, rotation: 0 };
  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.deepEqual(result.boxes.first, { x: 20, y: 10, width: 50, height: 30 });
  assert.deepEqual(result.boxes.second, { x: 20, y: 50, width: 60, height: 40 });
});
