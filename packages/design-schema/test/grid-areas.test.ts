import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  parseGridAreaTemplate,
  resolveGridCellRect,
  validateDocument,
  type DesignDocument,
  type DesignNode,
  type GridCell,
} from "../src/index";

/**
 * 命名网格区域（`grid-template-areas`）的解析与校验。
 *
 * 解析是总成功的：问题写进 `issues`，由 schema 决定拒绝、由面板决定提示。
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

function gridDocument(options: {
  areas?: string[];
  columns?: number;
  rows?: number;
  cells?: Record<string, GridCell>;
  childIds?: string[];
}): DesignDocument {
  const document = createDocument("doc:grid-areas", "Areas");
  const root = node("root", "page:1");
  const columnCount = options.columns ?? 2;
  const rowCount = options.rows ?? 1;
  root.layout = {
    ...defaultLayout(),
    mode: "grid",
    width: 400,
    height: 200,
    grid: {
      columns: Array.from({ length: columnCount }, () => ({ type: "fixed" as const, size: 100 })),
      rows: Array.from({ length: rowCount }, () => ({ type: "fixed" as const, size: 50 })),
      columnGap: 0,
      rowGap: 0,
      areas: options.areas,
      cells: options.cells,
    },
  };
  const childIds = options.childIds ?? [];
  root.childIds = childIds;
  document.pages["page:1"]!.childIds = [root.id];
  document.nodes[root.id] = root;
  for (const id of childIds) document.nodes[id] = node(id, "root");
  return document;
}

test("areas: 解析出矩形，跨列区域带跨度", () => {
  const template = parseGridAreaTemplate(["header header", "sidebar main"]);
  assert.equal(template.columns, 2);
  assert.equal(template.rows, 2);
  assert.deepEqual(template.issues, []);
  assert.deepEqual(template.areas.get("header"), { name: "header", row: 1, column: 1, rowSpan: 1, columnSpan: 2 });
  assert.deepEqual(template.areas.get("sidebar"), { name: "sidebar", row: 2, column: 1, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(template.areas.get("main"), { name: "main", row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
});

test("areas: 点号是空位，不产生区域", () => {
  const template = parseGridAreaTemplate([". main"]);
  assert.deepEqual([...template.areas.keys()], ["main"]);
  assert.deepEqual(template.areas.get("main"), { name: "main", row: 1, column: 2, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(template.issues, []);
});

test("areas: 各行长度不一致会被拒绝", () => {
  const template = parseGridAreaTemplate(["a b", "c"]);
  assert.equal(template.issues[0]?.code, "ragged-rows");
  assert.match(template.issues[0]!.message, /row 2 has 1 columns, expected 2/);
});

test("areas: 同名单元格没有构成矩形会被拒绝", () => {
  const template = parseGridAreaTemplate(["a b a"]);
  assert.equal(template.issues[0]?.code, "non-rectangular");
  assert.match(template.issues[0]!.message, /"a" does not form a rectangle/);
});

test("areas: 空行与空模板都报错", () => {
  assert.equal(parseGridAreaTemplate([]).issues[0]?.code, "empty-template");
  assert.equal(parseGridAreaTemplate(["a b", "  "]).issues[0]?.code, "empty-row");
});

test("areas: 会破坏 CSS 的名字被拒绝，中文名放行", () => {
  for (const bad of ['he"ader', "a;b", "a\\b", "span", "none"]) {
    const template = parseGridAreaTemplate([bad]);
    assert.equal(template.issues[0]?.code, "invalid-name", `${bad} 应被拒绝`);
  }
  const chinese = parseGridAreaTemplate(["页头 页头", "侧栏 正文"]);
  assert.deepEqual(chinese.issues, []);
  assert.deepEqual([...chinese.areas.keys()], ["页头", "侧栏", "正文"]);
});

test("areas: 子节点按区域名解析成行列与跨度", () => {
  const template = parseGridAreaTemplate(["header header", "sidebar main"]);
  assert.deepEqual(resolveGridCellRect({ area: "header" }, template), { row: 1, column: 1, rowSpan: 1, columnSpan: 2 });
  assert.deepEqual(resolveGridCellRect({ area: "main" }, template), { row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
});

test("areas: 未知区域解析成 undefined，不退化成 (1,1)", () => {
  const template = parseGridAreaTemplate(["header header"]);
  assert.equal(resolveGridCellRect({ area: "footer" }, template), undefined);
  assert.equal(resolveGridCellRect({ area: "footer" }, undefined), undefined);
});

test("areas: 直接给行列号时跨度缺省 1", () => {
  assert.deepEqual(resolveGridCellRect({ row: 2, column: 3 }), { row: 2, column: 3, rowSpan: 1, columnSpan: 1 });
  assert.deepEqual(resolveGridCellRect({ row: 2, column: 3, rowSpan: 2 }), { row: 2, column: 3, rowSpan: 2, columnSpan: 1 });
});

test("areas: 合法模板与区域引用能通过文档校验", () => {
  const document = gridDocument({
    areas: ["header header", "sidebar main"],
    rows: 2,
    cells: { header: { area: "header" }, main: { area: "main" } },
    childIds: ["header", "main"],
  });
  assert.deepEqual(validateDocument(document), document);
});

test("areas: 引用不存在的区域会被拒绝并带出节点 id", () => {
  const document = gridDocument({
    areas: ["header header"],
    cells: { header: { area: "footer" } },
    childIds: ["header"],
  });
  assert.throws(() => validateDocument(document), /layout\.grid\.cells\.header\.area: Grid cell references unknown area "footer"/);
});

test("areas: 没有模板却有区域引用会被拒绝", () => {
  const document = gridDocument({
    cells: { header: { area: "header" } },
    childIds: ["header"],
  });
  assert.throws(() => validateDocument(document), /but the grid has no areas template/);
});

test("areas: 模板列数与轨道数不一致会被拒绝", () => {
  const document = gridDocument({
    areas: ["header header header"],
    columns: 2,
    cells: {},
  });
  assert.throws(() => validateDocument(document), /Grid areas has 3 columns but there are 2 column tracks/);
});

test("areas: 区域与行列号同时给出会被拒绝", () => {
  const document = gridDocument({
    areas: ["header ."],
    cells: { header: { area: "header", row: 1, column: 1 } },
    childIds: ["header"],
  });
  assert.throws(() => validateDocument(document), /cannot give both an area name and row\/column/);
});

test("areas: 非矩形模板让整篇文档不通过", () => {
  const document = gridDocument({
    areas: ["a b a"],
    cells: { a: { area: "a" } },
    childIds: ["a"],
  });
  assert.throws(() => validateDocument(document), /does not form a rectangle/);
});
