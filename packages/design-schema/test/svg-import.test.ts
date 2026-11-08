import assert from "node:assert/strict";
import test from "node:test";
import { calculateArcBeziers } from "../src/arc-to-bezier";
import { isValidVectorPath } from "../src/geometry";
import { parseSvgPath } from "../src/svg-path";
import {
  canImportSvgPath,
  importSvgPathGeometry,
  importSvgPathVector,
} from "../../studio-web/src/svg-import";

/**
 * 这些用例覆盖按 Penpot 语义重写的 SVG 解析器与导入转换层。
 * 弧线算法本身的保真度对拍在 `arc-parity.test.ts`（与上游逐字节比对）。
 * 上游参考见 `docs/penpot-porting.md`。
 */

test("arc: 起点终点重合时不产生曲线", () => {
  assert.deepEqual(calculateArcBeziers(5, 5, 5, 5, 0, 1, 10, 10, 0), []);
});

test("svg: 解析基本命令", () => {
  const commands = parseSvgPath("M 10 20 L 30 40");
  assert.deepEqual(commands, [
    { command: "M", point: { x: 10, y: 20 } },
    { command: "L", point: { x: 30, y: 40 } },
  ]);
});

test("svg: 相对命令转成绝对坐标", () => {
  const commands = parseSvgPath("M 10 10 l 5 0 l 0 5");
  assert.deepEqual(commands, [
    { command: "M", point: { x: 10, y: 10 } },
    { command: "L", point: { x: 15, y: 10 } },
    { command: "L", point: { x: 15, y: 15 } },
  ]);
});

test("svg: H/V 展开成 L", () => {
  const commands = parseSvgPath("M 0 0 H 10 V 20");
  assert.deepEqual(commands, [
    { command: "M", point: { x: 0, y: 0 } },
    { command: "L", point: { x: 10, y: 0 } },
    { command: "L", point: { x: 10, y: 20 } },
  ]);
});

test("svg: 隐式命令——M 之后的坐标按 L 处理", () => {
  const commands = parseSvgPath("M 0 0 10 10 20 20");
  assert.deepEqual(commands, [
    { command: "M", point: { x: 0, y: 0 } },
    { command: "L", point: { x: 10, y: 10 } },
    { command: "L", point: { x: 20, y: 20 } },
  ]);
});

test("svg: 隐式命令——相对 m 之后按 l 处理", () => {
  const commands = parseSvgPath("m 0 0 10 0 10 10");
  assert.deepEqual(commands, [
    { command: "M", point: { x: 0, y: 0 } },
    { command: "L", point: { x: 10, y: 0 } },
    { command: "L", point: { x: 20, y: 10 } },
  ]);
});

test("svg: S 的控制点按上一个曲线的控制点镜像", () => {
  // M 0 0 C 10 10 20 10 20 0 S 30 -10 40 0
  // S 的第一个控制点应镜像上一个 C 的第二个控制点 (20,10) 关于当前点 (20,0) → (20,-10)。
  const commands = parseSvgPath("M 0 0 C 10 10 20 10 20 0 S 30 -10 40 0");
  assert.ok(commands);
  const last = commands[commands.length - 1]!;
  assert.equal(last.command, "C");
  if (last.command === "C") {
    assert.deepEqual(last.control1, { x: 20, y: -10 });
    assert.deepEqual(last.control2, { x: 30, y: -10 });
    assert.deepEqual(last.point, { x: 40, y: 0 });
  }
});

test("svg: T 的控制点按上一个 Q 的控制点镜像", () => {
  const commands = parseSvgPath("M 0 0 Q 10 10 20 0 T 40 0");
  assert.ok(commands);
  const last = commands[commands.length - 1]!;
  assert.equal(last.command, "Q");
  if (last.command === "Q") {
    assert.deepEqual(last.control, { x: 30, y: -10 });
    assert.deepEqual(last.point, { x: 40, y: 0 });
  }
});

test("svg: A 命令展开成 C 曲线", () => {
  const commands = parseSvgPath("M 0 0 A 10 10 0 0 1 20 0");
  assert.ok(commands);
  assert.equal(commands[0]!.command, "M");
  assert.ok(commands.length > 1);
  assert.ok(commands.every((command) => command.command !== "A"));
  assert.ok(commands.slice(1).every((command) => command.command === "C"));
});

test("svg: 非法输入让整条路径作废，不做部分解析", () => {
  assert.equal(parseSvgPath("M 0 0 L 10"), undefined);
  assert.equal(parseSvgPath("M 0 0 X 10 10"), undefined);
  assert.equal(parseSvgPath(""), undefined);
  assert.equal(parseSvgPath("L 10 10"), undefined);
});

test("svg: 相对量只缩放一次（不被二次缩放）", () => {
  // 起点 (10,10)，相对移动 (5,5) 后应为 (15,15)，不是 (20,20)。
  const commands = parseSvgPath("M 10 10 l 5 5", { scale: 2 });
  assert.ok(commands);
  const last = commands[commands.length - 1]!;
  assert.deepEqual(last.point, { x: 30, y: 30 });
});

test("svg: 缩放作用于绝对坐标", () => {
  const commands = parseSvgPath("M 10 20 L 30 40", { scale: 2 });
  assert.ok(commands);
  assert.deepEqual(commands[0]!.point, { x: 20, y: 40 });
  assert.deepEqual(commands[1]!.point, { x: 60, y: 80 });
});

test("import: 归一化路径落在 [0,1]，控制点允许越界", () => {
  const result = importSvgPathGeometry("M 0 0 L 100 0 L 100 50 Z");
  assert.ok(result);
  const commands = parseSvgPath(result.d);
  assert.ok(commands);
  for (const command of commands) {
    if (command.command === "Z") continue;
    if (command.command === "L" || command.command === "M") {
      assert.ok(command.point.x >= -1e-6 && command.point.x <= 1 + 1e-6);
      assert.ok(command.point.y >= -1e-6 && command.point.y <= 1 + 1e-6);
    }
  }
  // 包围盒宽高是**源坐标系的像素值**，不是归一化值——
  // 归一化路径恒定占满盒子，原始尺寸只能靠这两个字段还原。
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
});

test("import: 导入产物能通过本项目自己的路径校验", () => {
  const result = importSvgPathGeometry("M 0 0 A 10 10 0 0 1 20 0 Z");
  assert.ok(result);
  // 关键不变式：导入后的路径必须能被 parseVectorPath 读回来——
  // 否则画布会画一半、导出会输出另一半。
  assert.equal(isValidVectorPath(result.d), true, result.d);
});

test("import: 圆弧导入后包围盒覆盖整段弧", () => {
  // 从 (0,0) 到 (20,0) 的上半圆，包围盒高度应接近半径 10。
  const result = importSvgPathGeometry("M 0 0 A 10 10 0 0 1 20 0");
  assert.ok(result);
  assert.ok(result.height > 9.9 && result.height < 10.1, `height ${result.height}`);
  assert.ok(result.width > 19.9 && result.width < 20.1, `width ${result.width}`);
});

test("import: 非法 path 返回 undefined 而不是部分结果", () => {
  assert.equal(importSvgPathGeometry("M 0 0 L 10"), undefined);
  assert.equal(canImportSvgPath("M 0 0 L 10"), false);
  assert.equal(canImportSvgPath("M 0 0 L 10 10"), true);
});

test("import: 矢量节点几何与布局盒尺寸一致", () => {
  const result = importSvgPathVector("M 0 0 L 100 0 L 100 50 Z", { scale: 2 });
  assert.ok(result);
  assert.equal(result.box.width, 200);
  assert.equal(result.box.height, 100);
  assert.equal(result.geometry.kind, "path");
});
