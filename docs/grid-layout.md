# Grid 布局与可视化轨道编辑

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08（命名区域章节 2026-11-09）
> 关联文档：`figma-gap-roadmap.md`（第 1 项差距）、`current-project-status.md`

## 1. 定位

本项目已经有 Grid 的**数据模型**与**布局求解**（`packages/design-layout/src/grid.ts`），
但属性面板只能一行行地填「类型 + 尺寸」，用户看不到轨道长什么样，也没法用鼠标调宽度。

这一轮补齐的是 **Grid 可视化轨道编辑**（对标 Figma 的 Grid 面板）：

- 一条**与容器等宽的轨道条**，按真实比例画出每条轨道与轨道之间的间隙；
- **拖拽轨道边界**改宽度；
- **+/− 按钮**增删轨道；
- 改的过程中始终满足一组**硬约束**（最小宽度、总宽守恒、间隙不溢出）。

编辑器只是**编辑期**的工具：它不发明新的轨道表示，最终写回文档的仍然是
`GridSpec` 里那套 `GridTrack` 声明。

## 2. 数据模型

### 2.1 文档模型（已存在，本轮不改）

`packages/design-schema/src/types.ts`：

```ts
type GridTrack =
  | { type: "fixed"; size: number }      // 固定像素
  | { type: "fraction"; weight: number }  // 比例权重（1fr / 2fr）
  | { type: "auto" }                      // 按内容撑开
  | { type: "min-content" }
  | { type: "max-content" };

// 2026-11-09 新增（见 §10）：
type RepeatTrack = { type: "repeat"; mode: "auto-fill" | "auto-fit"; min: number; grow?: boolean };

interface GridSpec {
  columns: Array<GridTrack | RepeatTrack>;
  rows: Array<GridTrack | RepeatTrack>;
  columnGap: number;
  rowGap: number;
  areas?: string[];   // 命名区域，2026-11-09 新增（§9）
  cells?: Record<string, GridCell>;
  align?: "start" | "center" | "end" | "stretch";
}
```

轨道声明是**声明式**的：`fixed` 有像素、`fraction` 有权重、其余三种由内容决定。
只有 `fixed` 能直接表达「这条轨道 120px 宽」。

### 2.2 编辑期模型（新增）

`packages/studio-web/src/grid-track-model.ts`：

```ts
interface GridTrackModel {
  tracks: GridTrack[];   // 与文档模型同构，不另造表示
  gutter: number;        // 轨道之间的间隙（对应 GridSpec.columnGap）
  margin: number;        // 网格四周留白（编辑器视图层，不进文档）
  containerWidth: number;// 容器内容区宽度（轨道宽度的换算基准）
  contentWidths?: (number | undefined)[]; // 内容轨道的实测宽度（可选）
}
```

- `margin` 是**视图层**的概念：Figma 的 grid margin 是网格四周的留白，
  本项目 schema 里没有对应字段，因此本轮只作为编辑器的入参存在，不写回文档。
- `containerWidth` 是**内容区**宽度（已扣掉容器自身的 padding）。
- `contentWidths` 是内容轨道的实测宽度；缺项按最小宽度估算。
- 行方向复用同一套函数，把 `containerWidth` 换成容器内容区高度即可。

### 2.3 布局层的新增原语（`packages/design-layout/src/grid.ts`）

| 导出 | 作用 |
| --- | --- |
| `MIN_GRID_TRACK_WIDTH` | 轨道最小宽度常量（24px） |
| `isContentGridTrack(track)` | 判断是否内容轨道（`auto` / `min-content` / `max-content`） |
| `isResizableGridTrack(track)` | 判断轨道能否被直接拖拽调整宽度 |
| `gridTrackBaseWidths(tracks, options)` | 每条轨道的基准宽度（固有尺寸） |
| `resolveGridTrackWidths(tracks, options)` | 轨道声明 → 像素宽度（含分配、夹紧、溢出量） |
| `applyGridTrackWidths(tracks, widths, options)` | 像素宽度写回轨道声明 |

放在布局包而不是 studio-web，是因为「轨道声明怎么变成像素宽度」是**布局语义**，
编辑器与求解器应当共用同一套口径，避免两处实现漂移。

## 3. 宽度解析规则

`resolveGridTrackWidths` 的规则（与 `solveGrid` 的 `solveTracks` 同源，但多了夹紧）：

1. **基准宽度**（每条轨道的固有尺寸）
   - `fixed` → `size`
   - `fraction` → `0`（弹性轨道，先不占位）
   - 内容轨道 → 实测宽度；未提供实测值时按 `MIN_GRID_TRACK_WIDTH` 估算
2. **可用空间** = `availableWidth` − `(轨道数 − 1) × gap`
   （`availableWidth` 含间隙占位，与 `solveTracks` 的 `available` 同义）
3. **剩余空间 ≥ 0**
   - 有 `fraction` 轨道 → 按权重瓜分全部剩余空间（最后一条吃掉舍入误差）
   - 无 `fraction` 但有内容轨道 → 内容轨道**平分**剩余空间（CSS `auto` 轨道的拉伸行为）
   - 全是 `fixed` → 剩余空间成为 `slack`（容器留白）
4. **剩余空间 < 0**（放不下）→ 按优先级收缩基准尺寸：
   **内容轨道 → 固定轨道**，每条轨道最多收缩到 `MIN_GRID_TRACK_WIDTH`；
   `fraction` 轨道本来就是 0，没有可收缩的量。
   收缩按当前宽度等比分摊，触底的轨道退出、剩余量由其它轨道继续承担。
5. **溢出量** `overflow` = `max(0, 轨道总宽 − 可用空间)`；`slack` = `max(0, 可用空间 − 轨道总宽)`

> 与求解器的差别见 §6。

## 4. 约束规则

| 约束 | 规则 | 诊断码 |
| --- | --- | --- |
| **轨道最小宽度** | 轨道不小于 `MIN_GRID_TRACK_WIDTH`（24px）。`fixed` 轨道被拖到更窄时夹紧；`fraction` 轨道被拖到更窄时按最小宽度夹紧（其余 `fraction` 轨道至少留住最小宽度） | `min-width-clamped` |
| **容器总宽守恒** | 增删轨道时，容器可用宽被**重新分配**而不是被撑破：加轨道 → 其余轨道收缩；删轨道 → 其余轨道伸展。分配顺序为 `fraction` → 内容轨道 → `fixed` | `container-overflow`（分配不下时） |
| **间隙不溢出** | `(轨道数 − 1) × gutter ≤ 可用宽 − 轨道数 × 最小宽度`。超出时把 `gutter` 夹到上限 | `gutter-clamped` |
| **留白不溢出** | `margin ≤ containerWidth / 2`（两侧留白之和不能超过容器宽） | `margin-clamped` |
| **轨道数量在范围内** | 轨道数下限为 1（没有轨道的 Grid 容器无法排版，与 `removeGridTrack` 一致），上限为 24 | `track-count-clamped` |
| **内容轨道不可直接拖拽** | 内容轨道的宽度由内容决定，没有可写回的像素尺寸；拖拽边界时自动改用相邻的可调整轨道 | `track-not-resizable` |

诊断信息由编辑期模型返回（`GridTrackDiagnostic`），组件负责渲染。

### 4.1 增删轨道的重排规则

设容器内容区宽度为 `W`，间隙为 `g`，轨道数为 `n`：

- **加一条轨道**：新轨道以 `fixed` + `MIN_GRID_TRACK_WIDTH` 起步（可指定类型），
  并被**钉住**——它守住刚给定的宽度，差额由其余轨道按
  `fraction` → 内容轨道 → `fixed` 的顺序**等比收缩**补足。
- **删一条轨道**：被删轨道让出的空间（轨道宽 + 一个间隙）按同样顺序**等比伸展**给其余轨道。
  全是 `fixed` 轨道时，伸展按各自当前宽度等比分摊。

两种情况下，只要各轨道还能守住最小宽度，`轨道总宽 + 间隙总和` 恒等于容器可用宽——
这就是「总宽守恒」。

> 重新分配后的尺寸会**写回轨道声明**：属性面板看到的、文档里存的、画布上画的
> 是同一份数据。代价是「改间隙」也会让固定轨道跟着变——这是守恒规则的直接结果。

### 4.2 调整单条轨道宽度

- `fixed` 轨道 → 直接改 `size`（先按最小宽度夹紧），差额由其余轨道吸收。
- `fraction` 轨道 → 反解权重：设可用给 fraction 的空间为 `F`，其余 fraction 轨道权重和为 `Wₒ`，
  目标宽度 `t`，则新权重 `w = t × Wₒ / (F − t)`。
  这样只有被拖的那条轨道宽度变化，其余 fraction 轨道等比让位（CSS `fr` 的行为）。
- 内容轨道 → **不可直接调整**（宽度由内容决定），返回 `track-not-resizable` 诊断。
  边界拖拽时会自动改用相邻的可调整轨道。

## 5. 交互说明

组件：`packages/studio-web/src/grid-track-editor.tsx`（`GridTrackEditor`）。

- **轨道条**：按容器真实宽度比例绘制。每条轨道是一个色块，色块之间是**间隙的视觉留白**
  （真实 gutter 宽度，不是固定的几像素）。
- **拖拽手柄**：相邻轨道之间的竖线。手柄可拖 → 按真实像素换算成模型宽度 →
  调用 `resizeGridTrackBoundary` → 通过 `onChange` 回写。
- **+/− 按钮**：加一条 / 删最后一条轨道。
- **诊断**：约束被触发时（间隙夹紧、容器放不下……）在轨道条下方以警示样式列出。

组件是**完全受控**的：拖拽过程中每次移动都回调 `onChange`，
父组件更新 `tracks` 后轨道条立即跟着变。组件内部不持有轨道状态，避免与父组件不同步。

轨道条的视图宽度默认 240px（属性面板右栏宽度），容器更宽时按比例缩放显示；
拖拽位移会除以缩放比，还原成模型里的真实像素。

## 6. 与既有布局求解的关系

| | 求解器（`solveGrid`） | 编辑器（`resolveGridTrackWidths`） |
| --- | --- | --- |
| 空间不够时 | **不夹紧**，如实上报 `overflowWidth` / `overflowHeight` | **夹紧**到最小宽度并上报诊断 |
| 内容轨道宽度 | 来自 `contentSizes` 实测 | 优先用实测值，未提供时按最小宽度估算 |
| 目的 | 画布/导出要**如实**反映内容溢出 | 编辑器要**始终放得下**，让用户看见结果 |

两者共用同一套轨道语义（`GridTrack` 五种类型、`fixed`/`fraction` 的分配口径），
差别只在「放不下时怎么办」——这是刻意的：画布上看到溢出是**事实**，
编辑器里看到溢出是**待解决的问题**，两者不能混。

由此带来两条边界：

- **只读布局不会改文档**：编辑器计算显示宽度时会把放不下的轨道夹到能放下的值，
  并给出 `container-overflow` 诊断；轨道声明一个字都不动。
  因此一个**已经溢出**的文档（手工改出来的）在编辑器里看到的宽度会比画布窄。
- **编辑之后两者收敛**：任何几何编辑都会把重新分配后的尺寸写回文档，
  于是文档不再溢出，编辑器与画布显示一致。

编辑期模型与求解器的其它边界：

- 编辑器**不写回** `cells`（子节点占哪一格）——轨道增删后子节点落格由
  `assignCellsByOrder` / `ensureTracks` 负责，编辑器不越权改。
- 编辑器只处理**宽度轴**。行方向复用同一套纯函数，把容器宽换成容器内容区高度。
- 求解器里 `GridTrackInput.contentSizes` 是求解专用输入；
  编辑期模型直接用文档模型 `GridTrack`，两者通过 `GridTrack` ↔ `GridTrackInput` 的
  类型对应关系衔接，不新增第三套轨道表示。

## 7. 接线方式

属性面板文件 `packages/studio-web/src/property-panel.tsx` 由本轮之外的改动方持有，
因此本轮**不改**它，只给出可直接粘贴的片段。

```tsx
// 1) 文件顶部加导入（注意改名：property-panel 内部已有一个同名局部函数 GridTrackEditor）
import { GridTrackEditor as GridTrackVisualEditor } from "./grid-track-editor";

// 2) 在 Grid 区块里，紧跟现有的列表式轨道编辑器之后插入（可视化条只做宽度轴，即「列」）：
<GridTrackVisualEditor
  tracks={grid.columns}
  gutter={grid.columnGap}
  margin={0}
  containerWidth={Math.max(0, (layout.width ?? 0) - padding.left - padding.right)}
  disabled={disabled}
  onChange={next => patchGrid({ columns: next.tracks, columnGap: next.gutter })}
/>
```

`containerWidth` 取容器内容区宽度：固定宽时是 `layout.width - padding.left - padding.right`；
`widthMode` 为 `fill` 时应换成父容器的内容区宽度。

行（「行」轨道）暂时继续用现有的列表式编辑器——可视化条目前只画宽度轴。

## 8. 已知限制

- **margin 不进文档**：schema 里没有 grid margin 字段，本轮它只活在编辑期模型里。
- **内容轨道的宽度是估算值**：编辑器默认拿不到子节点的实测尺寸，
  内容轨道按最小宽度估算、在有剩余空间时平分。接上实测值后（`contentWidths` 入参）
  显示会与画布一致。
- **内容轨道不能拖拽**：`auto` / `min-content` / `max-content` 的宽度由内容决定，
  没有可写回的像素尺寸；拖边界时自动改用相邻的可调整轨道，
  两侧都是内容轨道时手柄直接禁用。
- **行方向没有可视化条**：模型层已经支持（把宽度换成高度），组件目前只画宽度轴。
- **改间隙会连带改轨道宽度**：总宽守恒的直接结果（见 §4.1）。
- **不做自动轨道**（`auto-fill` / `auto-fit`）：与求解器保持一致，属于有意的简化。
  > 2026-11-09 更新：自动重复轨道已落地，见 §10；本节描述的是当时的限制。

## 9. 命名区域（`grid-template-areas`）

> 2026-11-09 落地。本节描述**当前**已实现的行为，不是计划。

### 9.1 数据模型

```ts
interface GridSpec {
  // ...
  /** 每个字符串是一行，空白分列，`.` 是空位。 */
  areas?: string[];
  cells?: Record<NodeId, GridCell>;
}

type GridCell =
  | { row: number; column: number; rowSpan?: number; columnSpan?: number }
  | { area: string };
```

两种定位方式**二选一**：同时给出行列号与区域名时「以谁为准」没有确定答案，
schema 层直接拒绝；带区域名时也不能再写跨度——区域的矩形已经决定了跨度。

`areas` 与 `cells` 都是可选字段，不升文档格式版本，旧文档行为逐字不变。

### 9.2 模板规则

`packages/design-schema/src/grid-areas.ts` 是唯一解析入口：
`parseGridAreaTemplate(rows)` 是**总成功**的（问题写进 `issues`），
由 schema 决定拒绝、由属性面板决定提示——面板才能在用户打字打到一半时实时校验。

- 各行必须以空白分列，且**列数一致**（ragged 模板没有确定语义）；
- `.` 是空位，不产生区域；
- 同名单元格必须构成**矩形**。CSS 遇到非矩形区域会把整条声明作废，
  这里改成明确报错，免得用户以为「画出来了」；
- 区域名必须能安全地写进 CSS（`grid-area: 名字` 与带引号模板两种写法），
  因此拒绝引号、反斜杠、分号、点与保留字（`none` / `span` / `auto` 等）；
  中文名放行；
- 模板的**行列数必须等于轨道数**。区域画在轨道之外时「多出来的那一列」
  存不存在只能靠猜，与其静默错位，不如让用户把模板改到与轨道对齐。

### 9.3 求解与导出

- 布局层在 `gridCells()` 里把区域解析成行列区间，再交给原来的 `solveGrid()`——
  求解器只认行列号，不认识区域名，`solveGrid()` 一行未改。
- 区域名在模板里查不到时**跳过该子节点**，不退化成 `(1,1)`：
  猜出来的位置会和导出对不上。
- HTML 导出在容器上输出 `grid-template-areas`，子节点输出 `grid-area:<名字>`；
  用区域定位时不再写死 `grid-column` / `grid-row`，否则改模板在导出物里不会生效。
- SVG / PNG 走布局引擎解出的绝对盒子，与行列号定位结果完全一致。

### 9.4 编辑器行为

`packages/studio-web/src/grid-areas-model.ts`（纯函数）+ `grid-area-editor.tsx`：

- 模板文本域按行编辑，实时显示行列数不一致、非矩形、非法名字等诊断；
  「应用模板」只在没有诊断时可点。
- 子节点下拉框可以在区域之间切换，也可以退回「按顺序」（写回显式行列号，
  而不是删掉 cells 条目——删掉会让子节点在显式 cells 模式下直接不排版）。
- 模板生效时，**没有 cells 条目的子节点会自动按顺序补位**，避免它们凭空消失。
- 引用了已删除区域的子节点退回顺序填充，并在结果里列出（`reassigned`）。
- **轨道数变化时模板失配**：先把区域固化成当时的行列号，再丢掉模板，
  并在面板上说明发生过什么。位置不跳，文档仍然合法。

### 9.5 已知限制

- 不支持 `grid-template-areas` 的自动轨道组合（与 §8 的 `auto-fill` / `auto-fit` 同一限制）；
- 区域名只在**同一个 Grid 容器内**唯一，没有跨容器引用；
- 编辑器只处理列轴的轨道条，行轨道仍用列表式编辑器，但命名区域对行列同时生效。

> 2026-11-09 更新：自动重复轨道已落地（§10），9.5 的第一条限制不再成立。

## 10. 自动重复轨道（`repeat(auto-fill|auto-fit, …)`）

> 2026-11-09 落地。CSS 的 `repeat()` 天然依赖容器尺寸，这一节说明它在本项目里
> 什么时候能展开、什么时候只能退化。

### 10.1 数据模型

```ts
type GridTrack =
  | { type: "fixed"; size: number }
  | { type: "fraction"; weight: number }
  | { type: "auto" }
  | { type: "min-content" }
  | { type: "max-content" }
  | { type: "repeat"; mode: "auto-fill" | "auto-fit"; min: number; grow?: boolean };
```

- `min` 必须为正（0 会让条数发散，schema 直接拒绝）；
- `grow: true` 相当于 `minmax(min, 1fr)`，轨道在最小宽度之上均分剩余空间；
  缺省是 `repeat(…, min)`，右侧留白；
- 可选字段，**不升文档格式版本**，旧文档行为逐字不变。

### 10.2 条数公式

展开在求解**之前**完成（`expandRepeatTracks`，`design-layout/src/grid.ts`）：

```
n = ⌊(可用尺寸 − 其它轨道基准尺寸 − 其它轨道占的间隙 + gap) ÷ (min + gap)⌋，至少 1 条
```

- 「其它轨道」先扣掉，与 CSS 一致：`[fixed 200, repeat(min 100)]` 在 400px 里只放 2 条，
  而不是 4 条把容器撑爆；
- 其它轨道里只有 `fixed` 有确定基准尺寸，`fraction` / 内容轨道按 0 计；
- 条数上限 24（与属性面板的轨道数上限一致）：1px 的容器抖动不该让轨道数在临界点反复跳变；
- 展开后的轨道只剩 `fixed` 与 `fraction`，`solveGrid()` 一行未改。

### 10.3 `auto-fill` 与 `auto-fit` 的差别

- `auto-fill`：条数只由容器决定，放不满时右边留空轨道；
- `auto-fit`：条数再被「这一轴上的子节点数」夹住，空轨道被收起，
  于是剩余空间全部给到已有轨道（Figma 里「自动铺满」的效果）。

`auto-fit` 的收起规则是**近似**：按子节点总数夹条数，而不是逐条判断哪一列真的空着。
自动排布时两者等价（子节点总是从第一列开始填），显式 `cells` 把子节点摆得稀疏时，
被收起的数量可能与浏览器略有出入。

### 10.4 hug 容器：退化成一条并警告

`hug` 容器的尺寸是**结果**（由内容决定），而内容的位置又依赖轨道条数——这个循环没有不动点。
此时每条 `repeat` 只展开**一条固定轨道**（即使是 `grow`，因为未知空间里没有东西可分），
并产生 `grid-auto-repeat` 布局警告。空容器 hug 时因此是 `min` 宽，而不是 0 宽。

### 10.5 导出

HTML 导出直接把声明交给浏览器：

| 声明 | CSS |
| --- | --- |
| `{ mode: "auto-fill", min: 120, grow: true }` | `repeat(auto-fill, minmax(120px, 1fr))` |
| `{ mode: "auto-fit", min: 80 }` | `repeat(auto-fit, 80px)` |

画布与本机浏览器用同一套条数公式解算，导出物因此与画布一致；子节点没有显式 `cells` 时，
浏览器按行优先自动排布，与 `assignCellsByOrder` 的顺序相同。

### 10.6 编辑器

- 轨道类型下拉框新增「自动重复」，可调 `min`、`auto-fill` / `auto-fit` 与「均分」；
- 轨道条上只画一个 `min` 宽的占位（真实条数由容器宽度在布局时决定），
  拖拽手柄禁用并给出 `track-not-resizable` 诊断——不假装能拖。

## 11. 当前差距

Grid 线 A 的能力已全部落地。仍未实现的是**命名网格区域与自动轨道的组合**
（`grid.areas` 要求模板行列数等于轨道数，而自动轨道的条数要到布局时才确定），
以及 §8 列出的编辑期限制（margin 不进文档、行方向没有可视化条）。
