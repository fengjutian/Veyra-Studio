import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  type DesignDocument,
  type DesignNode,
  type GridCell,
  type GridTrack,
} from "@ufira/design-schema";
import { computePageLayout, expandRepeatTracks, solveGrid } from "../src/index";

/**
 * Grid 布局的用例。
 *
 * 语义对齐 Penpot 的 `geom/shapes/grid_layout/`，见 `docs/figma-gap-roadmap.md`。
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
  const document = createDocument("doc:1", "Grid");
  root.childIds = children.map(child => child.id);
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  for (const child of children) document.nodes[child.id] = child;
  return document;
}

function gridRoot(children: DesignNode[], grid: {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap?: number;
  rowGap?: number;
  areas?: string[];
  cells?: Record<string, GridCell>;
  align?: "start" | "center" | "end" | "stretch";
  width?: number;
  height?: number;
  widthMode?: "fixed" | "fill" | "hug";
  heightMode?: "fixed" | "fill" | "hug";
}): DesignNode {
  const root = node("root", "page:1");
  root.layout = {
    ...defaultLayout(),
    mode: "grid",
    width: grid.width ?? 400,
    height: grid.height ?? 300,
    widthMode: grid.widthMode ?? "fixed",
    heightMode: grid.heightMode ?? "fixed",
    grid: {
      columns: grid.columns,
      rows: grid.rows,
      columnGap: grid.columnGap ?? 0,
      rowGap: grid.rowGap ?? 0,
      areas: grid.areas,
      cells: grid.cells,
      align: grid.align,
    },
  };
  return root;
}

test("grid: 固定轨道按声明尺寸排布", () => {
  const root = gridRoot([], { columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 200 }], rows: [{ type: "fixed", size: 50 }] });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 30, height: 20 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 30, height: 20 };

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  // 第一列起点 x=0，第二列起点 x=100（无 gap）。
  assert.deepEqual(result.boxes.first, { x: 0, y: 0, width: 30, height: 20 });
  assert.deepEqual(result.boxes.second, { x: 100, y: 0, width: 30, height: 20 });
});

test("grid: gap 只在轨道之间生效", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 20,
  });
  const first = node("first", "root");
  const second = node("second", "root");

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.first?.x, 0);
  // 第二列起点 = 第一列宽 100 + gap 20 = 120。
  assert.equal(result.boxes.second?.x, 120);
});

test("grid: fraction 轨道按权重分掉剩余空间", () => {
  const root = gridRoot([], {
    columns: [{ type: "fraction", weight: 1 }, { type: "fraction", weight: 2 }],
    rows: [{ type: "fixed", size: 50 }],
    width: 300,
  });
  const first = node("first", "root");
  const second = node("second", "root");

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  // 300 = 1 份 + 2 份 → 每份 100。
  assert.equal(result.boxes.second?.x, 100);
});

test("grid: fraction 与 fixed 混合时 fraction 只拿剩余空间", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fraction", weight: 1 }],
    rows: [{ type: "fixed", size: 50 }],
    width: 400,
  });
  const first = node("first", "root");
  const second = node("second", "root");

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  // 剩余 = 400 - 100 = 300，fraction 轨道拿到 300。
  assert.equal(result.boxes.second?.x, 100);
});

test("grid: 显式 cells 决定子节点占哪一格", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }, { type: "fixed", size: 50 }],
    cells: {
      first: { row: 2, column: 1 },
      second: { row: 1, column: 2 },
    },
  });
  const first = node("first", "root");
  const second = node("second", "root");

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  // first 在第 2 行第 1 列 → y = 50, x = 0。
  assert.equal(result.boxes.first?.x, 0);
  assert.equal(result.boxes.first?.y, 50);
  // second 在第 1 行第 2 列 → x = 100, y = 0。
  assert.equal(result.boxes.second?.x, 100);
  assert.equal(result.boxes.second?.y, 0);
});

test("grid: 跨行跨列的子节点占据合并后的格子", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }, { type: "fixed", size: 50 }],
    cells: { first: { row: 1, column: 1, rowSpan: 2, columnSpan: 2 } },
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 30, height: 20 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  // 跨 2×2 的格子起点是 (0,0)，但格子本身是 200×100。
  // align 缺省 start 时子节点保持自己的尺寸，只是不在格子左上角之外。
  assert.equal(result.boxes.first?.x, 0);
  assert.equal(result.boxes.first?.y, 0);
});

test("grid: align=stretch 时子节点填满格子", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 120 }, { type: "fixed", size: 80 }],
    rows: [{ type: "fixed", size: 60 }],
    align: "stretch",
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 30, height: 20 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.first?.width, 120);
  assert.equal(result.boxes.first?.height, 60);
});

test("grid: align=center 时子节点在格子内居中", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 120 }],
    rows: [{ type: "fixed", size: 60 }],
    align: "center",
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 40, height: 20 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  // x = (120 - 40) / 2 = 40，y = (60 - 20) / 2 = 20。
  assert.equal(result.boxes.first?.x, 40);
  assert.equal(result.boxes.first?.y, 20);
});

test("grid: 没有显式 cells 时按顺序填格子，超出的补出隐式轨道", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }],
  });
  const first = node("first", "root");
  const second = node("second", "root");
  const third = node("third", "root");

  const result = computePageLayout(documentWith(root, [first, second, third]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.first?.x, 0);
  assert.equal(result.boxes.second?.x, 100);
  // 第三个没有第二行轨道 → 补一条隐式 auto 轨道，落在下一行。
  // 关键是**不与第一个重叠**（钳位会造成重叠）。
  assert.equal(result.boxes.third?.x, 0);
  assert.notEqual(result.boxes.third?.y, result.boxes.first?.y);
  assert.ok((result.boxes.third?.y ?? 0) > 0);
});

test("grid: padding 让内容区从内缩处开始", () => {
  const root = gridRoot([], { columns: [{ type: "fixed", size: 100 }], rows: [{ type: "fixed", size: 50 }] });
  root.layout = { ...root.layout, padding: { top: 10, right: 20, bottom: 10, left: 30 } };
  const first = node("first", "root");

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.first?.x, 30);
  assert.equal(result.boxes.first?.y, 10);
});

test("grid: 轨道放不下时给出 overflow 警告", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 500 }],
    rows: [{ type: "fixed", size: 50 }],
    width: 200,
  });
  const first = node("first", "root");

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.ok(result.warnings.some(warning => warning.code === "overflow" && warning.nodeId === "root"));
});

test("grid: hug 容器的尺寸 = 轨道 + gap", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 150 }],
    rows: [{ type: "fixed", size: 40 }],
    columnGap: 10,
  });
  root.layout = { ...root.layout, widthMode: "hug", heightMode: "hug" };
  const first = node("first", "root");

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  // 100 + 150 + gap 10 = 260。
  assert.equal(result.boxes.root?.width, 260);
  assert.equal(result.boxes.root?.height, 40);
});

test("grid: auto 轨道按内容撑开", () => {
  const root = gridRoot([], {
    columns: [{ type: "auto" }],
    rows: [{ type: "auto" }],
    widthMode: "hug",
    heightMode: "hug",
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 80, height: 30 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.root?.width, 80);
  assert.equal(result.boxes.root?.height, 30);
});

test("grid: 旧文档（没有 grid 字段）布局结果不变", () => {
  // 回归护栏：新增 grid 模式不能改动既有 absolute/stack 的求解结果。
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", width: 200, height: 160, gap: 10 };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 50, height: 30 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.deepEqual(result.boxes.first, { x: 0, y: 0, width: 50, height: 30 });
});

test("solveGrid: 权重全为 0 时均分剩余空间", () => {
  const result = solveGrid({
    columns: [{ type: "fraction", weight: 0 }, { type: "fraction", weight: 0 }],
    rows: [{ type: "fixed", size: 10 }],
    columnGap: 0,
    rowGap: 0,
    availableWidth: 100,
    availableHeight: 10,
    cells: [{ nodeId: "a", row: 1, column: 2, rowSpan: 1, columnSpan: 1, width: 10, height: 10 }],
    align: "start",
  });
  // 每条轨道 50 → 第二条轨道起点 50。
  assert.equal(result.children[0]?.x, 50);
  assert.equal(result.totalWidth, 100);
});

test("solveGrid: fraction 轨道之间保留 gap", () => {
  const result = solveGrid({
    columns: [{ type: "fraction", weight: 1 }, { type: "fraction", weight: 1 }],
    rows: [{ type: "fixed", size: 10 }],
    columnGap: 10,
    rowGap: 0,
    availableWidth: 210,
    availableHeight: 10,
    cells: [{ nodeId: "a", row: 1, column: 2, rowSpan: 1, columnSpan: 1, width: 10, height: 10 }],
    align: "start",
  });
  // 可用 210 = 两条轨道 + 一个 gap 10 → 每条轨道 100。
  // 第二条轨道起点 = 100 + 10 = 110。
  assert.equal(result.children[0]?.x, 110);
  assert.equal(result.totalWidth, 210);
});

test("grid: 命名区域决定子节点的行列与跨度", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 60 }],
    rows: [{ type: "fixed", size: 40 }, { type: "fixed", size: 30 }],
    areas: [
      "header header",
      "sidebar main",
    ],
    cells: {
      first: { area: "header" },
      second: { area: "sidebar" },
      third: { area: "main" },
    },
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 20, height: 10 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 20, height: 10 };
  const third = node("third", "root");
  third.layout = { ...defaultLayout(), width: 20, height: 10 };

  const result = computePageLayout(documentWith(root, [first, second, third]), "page:1", { viewport: { width: 800, height: 600 } });
  // header 横跨两列，起点 (0,0)；缺省 align=start 时子节点保持自己的尺寸。
  assert.deepEqual(result.boxes.first, { x: 0, y: 0, width: 20, height: 10 });
  // sidebar 在第 2 行第 1 列 → y = 40。
  assert.equal(result.boxes.second?.x, 0);
  assert.equal(result.boxes.second?.y, 40);
  // main 在第 2 行第 2 列 → x = 100。
  assert.equal(result.boxes.third?.x, 100);
  assert.equal(result.boxes.third?.y, 40);
});

test("grid: align=stretch 时命名区域把子节点撑满整个外接矩形", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 60 }],
    rows: [{ type: "fixed", size: 40 }],
    areas: ["header header"],
    align: "stretch",
    cells: { first: { area: "header" } },
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 20, height: 10 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  // 区域横跨 100 + 60 = 160px。
  assert.equal(result.boxes.first?.width, 160);
  assert.equal(result.boxes.first?.height, 40);
});

test("grid: 命名区域容器 hug 时按轨道与区域跨度定尺寸", () => {
  const root = gridRoot([], {
    columns: [{ type: "auto" }, { type: "auto" }],
    rows: [{ type: "auto" }],
    areas: ["left right"],
    cells: { first: { area: "left" } },
    widthMode: "hug",
    heightMode: "hug",
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 70, height: 25 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.root?.width, 70);
  assert.equal(result.boxes.root?.height, 25);
});

/* ------------------------- 自动重复轨道（repeat） ------------------------- */

test("repeat: auto-fill 按可用宽度展开条数（grow 时均分剩余空间）", () => {
  const root = gridRoot([], {
    columns: [{ type: "repeat", mode: "auto-fill", min: 100, grow: true }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 10,
    width: 400,
  });
  const children = ["a", "b", "c"].map(id => {
    const child = node(id, "root");
    child.layout = { ...defaultLayout(), width: 20, height: 10 };
    return child;
  });

  const result = computePageLayout(documentWith(root, children), "page:1", { viewport: { width: 800, height: 600 } });
  // ⌊(400 + 10) ÷ (100 + 10)⌋ = 3 条 → 每条约 (400 - 2×10) ÷ 3 = 126.67。
  assert.equal(Math.round(result.boxes.a?.x ?? -1), 0);
  assert.equal(Math.round(result.boxes.b?.x ?? -1), 137);
  assert.equal(Math.round(result.boxes.c?.x ?? -1), 273);
  assert.equal(result.warnings.length, 0);
});

test("repeat: 不 grow 时每条轨道等于最小宽度，右侧留白", () => {
  const root = gridRoot([], {
    columns: [{ type: "repeat", mode: "auto-fill", min: 100 }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 10,
    width: 400,
  });
  const children = ["a", "b", "c"].map(id => {
    const child = node(id, "root");
    child.layout = { ...defaultLayout(), width: 20, height: 10 };
    return child;
  });

  const result = computePageLayout(documentWith(root, children), "page:1", { viewport: { width: 800, height: 600 } });
  // 3 条 100px + 2 个 10px 间隙 = 320 < 400，右侧留白 80。
  assert.equal(result.boxes.a?.x, 0);
  assert.equal(result.boxes.b?.x, 110);
  assert.equal(result.boxes.c?.x, 220);
});

test("repeat: auto-fit 用子节点数收起空轨道，剩余空间给现有轨道", () => {
  const root = gridRoot([], {
    columns: [{ type: "repeat", mode: "auto-fit", min: 100, grow: true }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 10,
    width: 400,
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 20, height: 10 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 20, height: 10 };

  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  // auto-fill 能放 3 条，但只有 2 个子节点 → auto-fit 收成 2 条，每条约 (400-10)/2 = 195。
  assert.equal(result.boxes.second?.x, 205);
});

test("repeat: hug 容器拿不到确定宽度，退化成一条并警告", () => {
  const root = gridRoot([], {
    columns: [{ type: "repeat", mode: "auto-fill", min: 120, grow: true }],
    rows: [{ type: "fixed", size: 50 }],
    widthMode: "hug",
    heightMode: "hug",
  });
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 20, height: 10 };

  const result = computePageLayout(documentWith(root, [first]), "page:1", { viewport: { width: 800, height: 600 } });
  // 一条 120px 的轨道：hug 宽度就是 120。
  assert.equal(result.boxes.root?.width, 120);
  assert.ok(result.warnings.some(warning => warning.code === "grid-auto-repeat"));
  assert.equal(result.warnings.filter(warning => warning.code === "grid-auto-repeat").length, 1);
});

test("repeat: 顺序填充使用展开后的列数，不会把子节点全堆在第一列", () => {
  const root = gridRoot([], {
    columns: [{ type: "repeat", mode: "auto-fill", min: 80 }],
    rows: [{ type: "fixed", size: 40 }],
    columnGap: 0,
    width: 320,
  });
  // 320 ÷ 80 = 4 条；第 5 个子节点落到第二行（隐式轨道）。
  const children = ["a", "b", "c", "d", "e"].map(id => {
    const child = node(id, "root");
    child.layout = { ...defaultLayout(), width: 10, height: 10 };
    return child;
  });

  const result = computePageLayout(documentWith(root, children), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.d?.x, 240);
  assert.equal(result.boxes.e?.x, 0);
  assert.equal(result.boxes.e?.y, 40);
});

test("repeat: 与固定轨道混排时，只有 repeat 段被展开", () => {
  const root = gridRoot([], {
    columns: [{ type: "fixed", size: 50 }, { type: "repeat", mode: "auto-fill", min: 100 }],
    rows: [{ type: "fixed", size: 40 }],
    columnGap: 0,
    width: 350,
  });
  // 剩余 300 → 3 条 100px；列起点分别是 0 / 50 / 150 / 250。
  const children = ["a", "b", "c"].map(id => {
    const child = node(id, "root");
    child.layout = { ...defaultLayout(), width: 10, height: 10 };
    return child;
  });

  const result = computePageLayout(documentWith(root, children), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.a?.x, 0);
  assert.equal(result.boxes.b?.x, 50);
  assert.equal(result.boxes.c?.x, 150);
});

test("expandRepeatTracks: 条数先扣掉同轴其它显式轨道", () => {
  const result = expandRepeatTracks(
    [{ type: "fixed", size: 200 }, { type: "repeat", mode: "auto-fill", min: 100 }],
    { available: 400, gap: 0, itemCount: 4 },
  );
  // 400 - 200 = 200 → 只放得下 2 条（CSS 同样按「剩余空间」算条数）。
  assert.equal(result.tracks.length, 3);
  assert.deepEqual(result.tracks[0], { type: "fixed", size: 200 });
});

test("expandRepeatTracks: 尺寸未知时退化成一条固定轨道（即使 grow）", () => {
  const result = expandRepeatTracks(
    [{ type: "repeat", mode: "auto-fit", min: 140, grow: true }],
    { available: undefined, gap: 10, itemCount: 5 },
  );
  assert.equal(result.degraded, true);
  // 退化成 fixed 而不是 fraction：hug 容器下 fraction 分不到空间会塌成 0 宽。
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 140 }]);
});

test("expandRepeatTracks: 条数有上限，避免极窄最小宽度产生上千条轨道", () => {
  const result = expandRepeatTracks([{ type: "repeat", mode: "auto-fill", min: 1 }], {
    available: 10_000,
    gap: 0,
    itemCount: 1,
  });
  assert.equal(result.tracks.length, 24);
});
