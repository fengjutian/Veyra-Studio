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
| 1 | Grid 布局 | ✅ | ✅ | ❌ | A | **本轮开发** |
| 2 | 组件变体（variant） | ✅ | ✅ | ❌ | A | 下一步 |
| 3 | 原型运行时 | ✅ | ✅ | 仅数据层 | A | 数据层已落地，运行时待做 |
| 4 | 富文本（段内混排） | ✅ | ✅ | 仅节点级样式 | A | 待做 |
| 5 | 字体管理（上传/缺失字） | ✅ | ✅ | 仅按名回退 | A | 待做 |
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

**2. 组件变体** — Figma 的 component set：一组同义组件的互斥状态
（主按钮 / 次按钮 / 危险按钮），实例切换状态而不是复制组件。
本项目有组件与实例（含 slot、override、detach），但没有「变体」这层——
设计师做一个按钮组时只能建 N 个独立组件，共享修改要手工同步 N 次。

**3. 原型运行时** — 数据层已落地（事件 / 动作 / 动画 / overlay 定位 + `interaction.patch`）。
缺的是运行时：预览模式、状态机、跳转执行、overlay 渲染。
没有运行时，交互数据就只是「写在文档里的意图」。

**4. 富文本** — 现在文本样式是**节点级**的（整个文本节点一个字号字重）。
Figma 支持段内混排：一段文字里加粗几个词、给一个词变色。
真实文案稿几乎一定会用到。

**5. 字体管理** — 现在按字体名回退到系统栈，字体缺失就静默降级。
Figma 能上传字体文件并对缺失字体给出明确提示（而不是悄悄换个字体）。

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

## 4. 后续排期

| 优先级 | 能力 | 依赖 | 预估 |
| --- | --- | --- | --- |
| P0 | Grid 布局 | 本轮 | — |
| P0 | 组件变体 | Grid 之后的排版基建 | 中 |
| P0 | 原型运行时 | 交互数据层（已完成） | 大 |
| P1 | 富文本 | 文本测量契约 | 大 |
| P1 | 字体管理 | 资产存储（已有） | 中 |
| P1 | 布尔组 | 布尔运算（已有） | 中 |
| P2 | 混合模式 / 椭圆渐变 / 背景模糊 | 渲染管线 | 中 |
| P2 | 组件属性 | 组件变体 | 中 |

## 5. 参照来源

- Penpot Grid 实现：`common/src/app/common/geom/shapes/grid_layout/`
  （`params.cljc` 轨道与参数计算、`positions.cljc` 单元格定位、`bounds.cljc` 包围盒、
  `areas.cljc` 命名区域、`layout_data.cljc` 中间表示）
- Figma Grid 布局产品文档：<https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-auto-layout>
- Penpot / Figma 能力对比：见 `penpot-porting.md` §6
