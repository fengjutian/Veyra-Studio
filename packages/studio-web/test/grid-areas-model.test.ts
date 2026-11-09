import assert from "node:assert/strict";
import test from "node:test";
import type { GridSpec } from "@ufira/design-schema";
import {
  applyGridAreaText,
  checkGridAreaText,
  defaultGridCellForIndex,
  formatGridAreaText,
  gridAreaTemplateNames,
  reconcileGridAreasWithTracks,
  setGridChildArea,
  splitGridAreaText,
} from "../src/grid-areas-model";

/** 两列两行的 100px 轨道，方便断言。 */
function grid(overrides: Partial<GridSpec> = {}): GridSpec {
  return {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }, { type: "fixed", size: 50 }],
    columnGap: 0,
    rowGap: 0,
    ...overrides,
  };
}

test("areas-model: 尾部空行不算错，行内空白归一化", () => {
  assert.deepEqual(splitGridAreaText("a b\n\n"), ["a b"]);
  assert.deepEqual(splitGridAreaText("a b\r\nc d"), ["a b", "c d"]);
  assert.equal(formatGridAreaText(["a b", "c d"]), "a b\nc d");
});

test("areas-model: 模板名按首次出现顺序给出", () => {
  assert.deepEqual(gridAreaTemplateNames(["header header", "sidebar main"]), ["header", "sidebar", "main"]);
  assert.deepEqual(gridAreaTemplateNames(undefined), []);
});

test("areas-model: 行列数与轨道不一致时给出明确诊断", () => {
  const issues = checkGridAreaText("a b c", grid());
  assert.equal(issues[0]?.code, "column-mismatch");
  assert.match(issues[0]!.message, /模板有 3 列，但列轨道有 2 条/);

  const rows = checkGridAreaText("a b\na b\na b", grid());
  assert.equal(rows[0]?.code, "row-mismatch");
});

test("areas-model: 合规模板没有诊断", () => {
  assert.deepEqual(checkGridAreaText("header header\nsidebar main", grid()), []);
  assert.deepEqual(checkGridAreaText("", grid()), []);
});

test("areas-model: 合规模板写回文档并保留区域引用", () => {
  const result = applyGridAreaText(
    "header header\nsidebar main",
    grid(),
    { header: { area: "header" }, main: { area: "main" } },
    ["header", "main"],
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.areas, ["header header", "sidebar main"]);
  assert.deepEqual(result.cells.header, { area: "header" });
  assert.deepEqual(result.cells.main, { area: "main" });
  assert.deepEqual(result.reassigned, []);
});

test("areas-model: 引用被删除区域的子节点退回顺序填充，而不是消失", () => {
  const result = applyGridAreaText(
    "header header\nsidebar main",
    grid(),
    { old: { area: "footer" } },
    ["old", "other"],
  );
  assert.equal(result.ok, true);
  // old 是第一个子节点 → 第 1 行第 1 列。
  assert.deepEqual(result.cells.old, { row: 1, column: 1 });
  // other 原本没有条目，模板生效后也要有位置，否则显式 cells 模式下不排版。
  assert.deepEqual(result.cells.other, { row: 1, column: 2 });
  assert.deepEqual(result.reassigned, ["old", "other"]);
});

test("areas-model: 非矩形模板不提交，cells 原样返回", () => {
  const cells = { first: { row: 1, column: 1 } };
  const result = applyGridAreaText("a b a", grid(), cells, ["first"]);
  assert.equal(result.ok, false);
  assert.equal(result.areas, undefined);
  assert.deepEqual(result.cells, cells);
  assert.equal(result.issues[0]?.code, "non-rectangular");
});

test("areas-model: 清空模板时区域引用退回顺序填充", () => {
  const result = applyGridAreaText("", grid(), { first: { area: "header" } }, ["first"]);
  assert.equal(result.ok, true);
  assert.equal(result.areas, undefined);
  assert.deepEqual(result.cells.first, { row: 1, column: 1 });
});

test("areas-model: 轨道数变化后模板失配时固化为行列号", () => {
  const same = reconcileGridAreasWithTracks(grid({ areas: ["a b", "c d"] }));
  assert.equal(same.dropped, false);
  assert.deepEqual(same.areas, ["a b", "c d"]);

  const shrunk = reconcileGridAreasWithTracks(grid({
    columns: [{ type: "fixed", size: 100 }],
    areas: ["a b", "c d"],
    cells: { b: { area: "b" } },
  }));
  assert.equal(shrunk.dropped, true);
  assert.equal(shrunk.areas, undefined);
  // b 在模板里是第 1 行第 2 列——位置被固化下来，不会因为丢模板而跳走。
  assert.deepEqual(shrunk.cells.b, { row: 1, column: 2, rowSpan: 1, columnSpan: 1 });
});

test("areas-model: 顺序填充的默认格子按列数换行", () => {
  assert.deepEqual(defaultGridCellForIndex(0, 2), { row: 1, column: 1 });
  assert.deepEqual(defaultGridCellForIndex(2, 2), { row: 2, column: 1 });
  assert.deepEqual(defaultGridCellForIndex(3, 1), { row: 4, column: 1 });
});

test("areas-model: 给子节点换区域或退回顺序填充", () => {
  const assigned = setGridChildArea({ other: { area: "x" } }, "first", "main", 1, 2);
  assert.deepEqual(assigned.first, { area: "main" });
  assert.deepEqual(assigned.other, { area: "x" });

  const cleared = setGridChildArea(assigned, "first", undefined, 0, 2);
  assert.deepEqual(cleared.first, { row: 1, column: 1 });
});
