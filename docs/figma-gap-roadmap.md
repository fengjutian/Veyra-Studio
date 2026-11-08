# Figma 功能差距与补齐路线

> 文档状态：生效中的功能追赶路线
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`、`penpot-porting.md`

## 1. 定位

本项目不是「另一个 Figma」，而是**本地优先、AI 原生、可被 Agent 驱动**的设计环境。
因此追赶有两条线：

- **线 A（必须追）**：设计师日常画稿必需的底层能力。缺了就没法用。
- **线 B（不必追）**：Figma 的云协作、插件市场、团队管理。**不做**，因为那是另一条产品路线，
  且与本项目的「本地优先 + 可编程」定位冲突。

判断标准很简单：**一个设计师打开本项目画一稿真实 UI，会不会因为缺 X 而卡住？**
会 → 线 A；不会 → 不用做。

## 2. 当前差距总览

对照基准是 **Figma**（行业标准），实现参照是 **Penpot**（唯一可自托管的开源同类，
其能力边界已被多方评测认定为「接近 Figma」）。

| # | 能力 | Figma | Penpot | 本项目 | 线 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Grid 布局 | ✅ | ✅ | ✅ 数据模型 + 求解 + 面板 | A | **本轮完成**（缺可视化轨道编辑） |
| 2 | 组件变体（variant） | ✅ | ✅ | ✅ 变体集 + 实例切换（UI 限单属性） | A | **本轮完成** |
| 3 | 原型运行时 | ✅ | ✅ | ✅ 预览/状态机/overlay/动画/按下与悬停（缺滚动保持） | A | **本轮完成** |
| 4 | 富文本（段内混排） | ✅ | ✅ | ✅ 段内字重/字形/字号/颜色（无段落样式） | A | **本轮完成** |
| 5 | 字体管理（上传/缺失字） | ✅ | ✅ | ✅ 上传 + 声明 + 缺失诊断（无子集化） | A | **本轮完成** |
| 6 | 布尔组（保留运算树） | ✅ | ✅ | ❌（烘焙成路径） | A | 待做 |
| 7 | 混合模式 | ✅ | ✅ | ❌ | A | 待做 |
| 8 | 椭圆渐变 | ✅ | ✅ | ❌（有径向但非椭圆） | A | 待做 |
| 9 | 背景模糊 | ✅ | ✅ | ❌ | A | 待做 |
| 10 | 组件属性（component props） | ✅ | ⚠️ | ❌ | A | 待做 |
| 11 | 智能锚点吸附 | ✅ | ✅ | ⚠️ 基础版 | A | 待增强 |
| 12 | 实时协作 | ✅ | ✅ | ❌ | **B** | **不做** |
| 13 | 插件市场 | ✅ | ⚠️ | ❌ | **B** | **不做**（本项目走 MCP/Agent 路线） |
| 14 | 评论 / 分享审阅 | ✅ | ✅ | ❌ | **B** | 可选，最小只读分享 |
| 15 | FigJam 白板 | ✅ | ❌ | ❌ | **B** | **不做** |
| 16 | 团队库 / 组织管理 | ✅ | ✅ | ❌ | **B** | **不做** |

### 线 A 逐项说明

**1. Grid 布局** — Figma 2021 年引入的核心能力：容器可定义行列轨道，
子节点占格子而不是按坐标摆放。Penpot 有完整实现
（`common/src/app/common/geom/shapes/grid_layout/`，含 params / positions / bounds /
areas / layout_data 五个模块，约 1000 行 ClojureScript）。

本项目现有 `absolute` 与 `stack` 两种模式。`stack` 只能单向排列，
做仪表盘、卡片矩阵、图表面格时必须退回手摆坐标——这是日常最常卡住的点。

**2. 组件变体** — 本轮已落地**变体集**：`componentSets` 只声明属性名，组件用
`variantSetId` + `variant` 归属集合；实例可以在同集成员之间切换（删旧物化子树、
重新物化，实例 id/位置不变）。「创建变体」会复制根子树并自动建集合，只剩一个成员时
集合自动解散。规格见 `component-variants.md`。
覆盖现在按结构路径从旧变体迁移到新变体，结构不同时才会丢弃。

**3. 原型运行时** — 本轮已落地：顶栏「预览」进入全屏预览，状态机（`prototype/state.ts`）
支持点击命中向上冒泡、after-delay 计时器、屏幕历史与 prev-screen；overlay 支持中心/四角/
manual 定位、背景遮罩与点外部关闭；动画 dissolve/slide/push 用 DOM 层 CSS keyframes
实现。规格见 `prototype-runtime.md`。按下与悬停/离开事件也已接线（hover 只在进入时触发一次），仍缺 `preserveScroll` 与原型内滚动容器。

**4. 富文本** — 本轮已落地**段内字重/字形/颜色**：`TextNode.runs` 用偏移区间承载样式，
换行统一走 `layoutRichText()`，HTML 出 `<span>`、SVG 出 `<tspan>`，面板选中文字即可
加粗/变色（规格见 `rich-text.md`）。仍缺段落级样式（缩进、列表）。

**5. 字体管理** — 本轮已落地：字体文件按内容哈希进项目（与图片共用资产管线），
`document.fonts` 声明族名/字重/字形的来源，加载失败或系统中也没有的族名会在
「数据 → 字体」里明确列出，不再静默回退；属性面板字体输入带可取建议。
规格见 `font-management.md`。仍缺字体子集化与导出内联、从文件解析真实族名。

**6. 布尔组** — 现在的布尔运算把结果**烘焙成一条路径**，原对象消失。
Figma 保留运算树：改了输入，输出跟着变。对参数化图形（可调滑块、
数据驱动的图表）是刚需。

**7-9. 混合模式 / 椭圆渐变 / 背景模糊** — 表现层能力，
Penpot 的 `render/fills.rs` 与 `render/filters.rs` 有可对标的实现。

**10. 组件属性** — Figma 允许组件暴露可变属性（标题、图标、状态），
实例改属性而不改内容。本项目的 override 只覆盖内容副本，
没有「属性」这层抽象。

### 线 B 为什么不做

- **实时协作**：需要 CRDT/OT + 存在性感知，是架构级决策，
  且与「本地优先、文件即数据」的模型冲突。真要做也是独立产品。
- **插件市场**：生态是十年的积累，做不出差异化。
  本项目的开放性走 **MCP / Agent 可编程**路线——这是 Figma 至今没有的形态。
- **FigJam / 团队库**：纯企业协作场景，与个人与小团队开发者定位不符。

## 3. 本轮：Grid 布局

### 3.1 范围

按 Penpot 的 Grid 语义（`grid_layout/params.cljc` + `positions.cljc`）重写，
落在 `design-layout`：

- **轨道（track）**：容器定义行/列轨道，每条轨道有类型与尺寸。
- **单元格（cell）**：子节点占据某个行列区间（可跨行跨列）。
- **轨道类型**：
  - `fixed` — 固定尺寸（px）；
  - `fraction` — 比例权重（`1fr` / `2fr`），按剩余空间分配；
  - `auto` — 按内容撑开；
  - `min-content` / `max-content` — 按内容最小/最大尺寸。
- **间距**：行列各自的 gap。
- **对齐**：子节点在格子内的对齐（start / center / end / stretch）。

### 3.2 刻意不做的

- **拖拽改轨道**：交互层（Figma 的可视化轨道编辑器）——本轮只做数据模型与求解，
  轨道参数通过属性面板录入。
- **命名的网格区域（grid-template-areas）**：Penpot 有 `areas.cljc`，
  但 Figma 的 areas 语义较弱，且需要整套区域名编辑 UI。
  本轮用「行列区间」表达跨格，够用且可被 Penpot 的 areas 对拍。
- **自动轨道（auto-fill / auto-fit）**：依赖内容测量与反复迭代，
  收益低于成本。

### 3.3 数据模型

在 `LayoutSpec` 上新增可选字段（**向后兼容优先用可选字段**，符合
`editor-tooling-roadmap.md` 的设计原则第 5 条）：

```ts
/** Grid 布局配置；缺省表示不是 grid 容器。 */
grid?: {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap: number;
  rowGap: number;
  /** 子节点 → 占用的单元格区间。 */
  cells: Record<NodeId, { row: number; column: number; rowSpan: number; columnSpan: number }>;
};
```

轨道类型：

```ts
export type GridTrack =
  | { type: "fixed"; size: number }
  | { type: "fraction"; weight: number }
  | { type: "auto" }
  | { type: "min-content" }
  | { type: "max-content" };
```

`cells` 用节点 id 做键——子节点占哪一格是**子节点自己的属性**，
放在容器的 `cells` 里是为了让布局求解一次读全（避免每个子节点去查父级）。

### 3.4 求解算法

1. **测轨道固有尺寸**：`fixed` 直接取；`auto`/`min-content`/`max-content` 取子节点内容尺寸；
   `fraction` 暂不占固定空间。
2. **分配剩余空间**：`fraction` 按权重分掉「容器可用宽/高 - 固定轨道总和 - gap 总和」。
   权重为 0 或总和为 0 时退回均分。
3. **定位子节点**：按 `cells` 找到起点轨道与跨度轨道，累加得到原点与尺寸。
4. **对齐**：格子内按 `align` 调整（`stretch` 时子节点填满格子）。
5. **hug 容器**：容器自身 hug 时，尺寸 = 轨道总尺寸 + gap + padding。

### 3.5 验收

- 固定轨道 + fraction 轨道混合时，fraction 按权重拿到剩余空间（误差 < 0.5px）；
- 跨行跨列的子节点占据的盒子 = 对应轨道的合并范围；
- `auto` 轨道按内容撑开，内容变化时轨道宽度跟着变；
- gap 只在轨道**之间**生效，不加在容器边缘；
- hug 容器尺寸 = 轨道 + gap + padding；
- 旧文档（无 `grid` 字段）布局结果**逐字不变**——布局引擎的 golden 基线不破；
- 轨道总和超出容器时产生 `overflow` 警告，而不是静默溢出。

### 3.6 落地结果（2026-11-08）

已实现：

- **数据模型**：`LayoutSpec.mode` 新增 `grid`；轨道配置在可选的 `layout.grid` 上；
  `GridTrack` 五种类型；`GridCell` 声明子节点占的行列区间。
- **求解**：`design-layout/src/grid.ts`（`solveGrid` / `ensureTracks` / `assignCellsByOrder`）。
- **接入**：布局引擎（画布、SVG/PNG 导出共用同一份解）、属性面板轨道编辑器、
  HTML 导出输出 CSS Grid、导出支持矩阵新增 `layout-grid` 行。
- **迁移**：文档格式 v3 → v4（只补版本号与缺省轨道配置，旧文档内容不变）。
- **测试**：`design-layout/test/grid.test.ts`（16 条）、
  `design-export/test/grid.test.ts`（6 条）、
  `studio-web/test/layout-edit.test.ts`（+7 条）。

实现中改掉的两个真实缺陷：

1. **子节点超出轨道数时被钳到末位** → 两个子节点重叠。
   改成 CSS Grid 的隐式轨道语义：超出就补 `auto` 轨道。
2. **fraction 权重全为 0 时轨道永远分不到空间** → 改成均分。

未实现（下一轮）：拖拽调整轨道、命名网格区域、自动轨道（`auto-fill` / `auto-fit`）。

## 4. 后续排期

| 优先级 | 能力 | 依赖 | 预估 |
| --- | --- | --- | --- |
| P0 | Grid 布局 | 本轮 | — |
| P0 | 组件变体 | 已完成 | — |
| P0 | 原型运行时 | 已完成（缺 hover 与滚动保持） | — |
| ~~P1~~ | ~~富文本~~ | 段内样式已完成，剩段内字号与段落样式 | — |
| P1 | 字体管理 | 已完成（剩子集化与导出内联） | — |
| P1 | 布尔组 | 布尔运算（已有） | 中 |
| P2 | 混合模式 / 椭圆渐变 / 背景模糊 | 渲染管线 | 中 |
| P2 | 组件属性 | 组件变体 | 中 |

## 5. 参照来源

- Penpot Grid 实现：`common/src/app/common/geom/shapes/grid_layout/`
  （`params.cljc` 轨道与参数计算、`positions.cljc` 单元格定位、`bounds.cljc` 包围盒、
  `areas.cljc` 命名区域、`layout_data.cljc` 中间表示）
- Figma Grid 布局产品文档：<https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-auto-layout>
- Penpot / Figma 能力对比：见 `penpot-porting.md` §6
