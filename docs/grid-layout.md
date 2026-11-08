# Grid 布局与可视化轨道编辑

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
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

interface GridSpec {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap: number;
  rowGap: number;
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
