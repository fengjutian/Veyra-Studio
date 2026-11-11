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
| 1 | Grid 布局 | ✅ | ✅ | ✅ 数据模型 + 求解 + 面板 + **可视化轨道编辑** + **命名区域** + **自动重复轨道** | A | **已完成** |
| 2 | 组件变体（variant） | ✅ | ✅ | ✅ 变体集 + 实例切换（UI 限单属性） | A | **本轮完成** |
| 3 | 原型运行时 | ✅ | ✅ | ✅ 预览/状态机/overlay/动画/按下与悬停/**滚动保持**/**滚动容器** | A | **本轮完成**（滚动保持与滚动容器见 §10） |
| 4 | 富文本（段内混排） | ✅ | ✅ | ✅ 段内字重/字形/字号/颜色/**行高** + 段落样式（列表/缩进/段落缩进/悬挂/间距）+ **编辑器内直接改样式** | A | **已完成**（见 §7 / §12） |
| 5 | 字体管理（上传/缺失字） | ✅ | ✅ | ✅ 上传 + 声明 + 缺失诊断 + 导出内联（HTML **与 SVG**）+ **子集化** | A | **已完成**（见 §9） |
| 6 | 布尔组（保留运算树） | ✅ | ✅ | ✅ 运算树 + 实时重算 + **曲线级结果** + **操作数支持旋转** | A | **已完成**（见 §10 / §11） |
| 7 | 混合模式 | ✅ | ✅ | ✅ 16 种全覆盖 + 图层组离屏合成 | A | **已完成**（§4 / §5） |
| 8 | 椭圆渐变 | ✅ | ✅ | ✅ 椭圆 + 旋转角 | A | **已完成**（§4 / §5） |
| 9 | 背景模糊 | ✅ | ✅ | ✅ 画布快照 + HTML/SVG 导出 | A | **已完成**（§4 / §5） |
| 10 | 组件属性（component props） | ✅ | ⚠️ | ✅ 五种属性类型 + 五种绑定字段 + 实例取值 + **变体集共享声明** + **默认值同步到已有变体** | A | **本轮完成**（见 §6 / §10 / §12） |
| 11 | 智能锚点吸附 | ✅ | ✅ | ✅ 锚点语义 + 等间距提示 | A | **已完成**（见 §10） |
| 12 | 多选整体旋转 | ✅ | ✅ | ✅ 绕选区旋转后包围盒中心刚性旋转 + 角度读数 | A | **已完成**（2026-11-11，见 §12） |
| 13 | 蒙版 alpha / 羽化 | ✅ | ⚠️ | ✅ `maskFeather` + 蒙版不透明度 + 三端软蒙版 | A | **已完成**（2026-11-11，见 §12） |
| 14 | 阴影 spread / 内阴影 | ✅ | ✅ | ✅ `spread` + `type: drop\|inner`，Canvas 走离屏合成 | A | **已完成**（2026-11-11，见 §12） |
| 15 | 实时协作 | ✅ | ✅ | ❌ | **B** | **不做** |
| 16 | 插件市场 | ✅ | ⚠️ | ❌ | **B** | **不做**（本项目走 MCP/Agent 路线） |
| 17 | 评论 / 分享审阅 | ✅ | ✅ | ❌ | **B** | 可选，最小只读分享 |
| 18 | FigJam 白板 | ✅ | ❌ | ❌ | **B** | **不做** |
| 19 | 团队库 / 组织管理 | ✅ | ✅ | ❌ | **B** | **不做** |

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
实现。规格见 `prototype-runtime.md`。按下与悬停/离开事件也已接线（hover 只在进入时触发一次）；
滚动保持（`preserveScroll`）与原型内滚动容器（`overflow` 字段 + 滚轮）见 §10。

**4. 富文本** — 已落地**段内字重/字形/颜色**：`TextNode.runs` 用偏移区间承载样式，
换行统一走 `layoutRichText()`，HTML 出 `<span>`、SVG 出 `<tspan>`，面板选中文字即可
加粗/变色（规格见 `rich-text.md`）。**段落级样式（列表、列表缩进）也已补齐**：
`TextNode.paragraphStyles` 用对齐段落边界的区间承载，命令 `text.paragraph.set`，
画布出标记与缩进、HTML 出 `<ul>/<ol>`、SVG 出标记文本（规格见 `paragraph-styles.md`，
见本轮 §7）。**画布内联编辑也已能显示样式**：编辑层是结构化 `contenteditable`
（段落块 + 段内 run + 列表标记），不再是一个看不出样式的纯文本框
（规格见 `inline-text-editing.md`）。**段落缩进（px）、悬挂列表与列表间距也已补齐**：
`ParagraphStyle` 增加 `paragraphIndent` / `hanging` / `listSpacing`，画布能画框外的悬挂标记，
HTML 用 `padding-left` 与 `margin-bottom` 表达（规格见 `paragraph-styles.md`）。

**5. 字体管理** — 已落地：字体文件按内容哈希进项目（与图片共用资产管线），
`document.fonts` 声明族名/字重/字形的来源，加载失败或系统中也没有的族名会在
「数据 → 字体」里明确列出，不再静默回退；属性面板字体输入带可取建议。
规格见 `font-management.md`。**导出物内联与真实族名解析也已补齐**：
HTML 交付物会把文档声明过的字体内联成 `@font-face`（对方机器没装也不回退），
上传时读出字体文件里的真实族名与字重（见本轮 §9，规格见 `font-inline.md`）。
仍缺字体子集化。

**6. 布尔组** — 已改为保留运算树：`boolean` 节点持有操作数，改子层或换运算都会实时重算，
参数化图形（可调滑块、数据驱动图表）因此可做。**曲线级布尔已实现**（paper.js 引擎，见 §10），
**操作数也支持旋转了**（2026-11-11，见 §11）。

**7-9. 混合模式 / 椭圆渐变 / 背景模糊** — 表现层能力，
Penpot 的 `render/fills.rs` 与 `render/filters.rs` 有可对标的实现。
**本项目已完成**（§4 数据模型与导出、§5 画布侧离屏合成）：
混合模式 16 种全覆盖并按图层组语义生效；椭圆渐变支持中心/半径/旋转角；
背景模糊在画布上按节点形状裁剪、在 HTML/SVG 导出里生效。

**10. 组件属性** — Figma 允许组件暴露可变属性（标题、图标、状态），
实例改属性而不改内容。本项目的 override 只覆盖内容副本，
没有「属性」这层抽象。
**本轮已落地**（§6）：组件可以声明 `text` / `boolean` 两种属性，
属性绑定到组件内部节点的 `text` / `visible` 字段，实例在面板里按属性改值。
规格见 `component-properties.md`。

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

> 2026-11-09 更新：拖拽调整轨道、**命名区域**与**自动重复轨道**
> （`repeat(auto-fill|auto-fit, …)`）均已落地（规格见 `grid-layout.md` §9 / §10），
> 线 A 的 Grid 差距清零。

## 4. 本轮：表现层能力（混合模式 / 椭圆渐变 / 背景模糊）

前三轮（Grid、组件变体、原型运行时）已经做完，线 A 的缺口收缩到了**表现层**——
「画出来对不对」这一类能力。这三项在 Figma 里都是日常高频操作，
而本项目此前完全空缺（只有 legacy bridge 代码里有 mix-blend-mode 的痕迹，
独立 Studio 的 schema / 渲染 / 导出三层都没有）。

### 4.1 混合模式

Figma 的混合模式是**图层级**属性（与 opacity、阴影、模糊平级），
Penpot 也是这样（`:blend-mode` 与 `:opacity` / `:shadow` / `:blur` 同级）。

本项目的实现：

- **数据模型**：`AppearanceSpec.blendMode?: BlendMode`，可选字段，旧文档无需迁移。
- **取值**：与 CSS `mix-blend-mode` 对齐——
  `normal` / `multiply` / `screen` / `overlay` / `darken` / `lighten` /
  `color-dodge` / `color-burn` / `hard-light` / `soft-light` /
  `difference` / `exclusion` / `hue` / `saturation` / `color` / `luminosity`。
- **三处渲染**：
  - 画布：Canvas 2D 的 `globalCompositeOperation`（其中 12 种能对上，
    `normal` 是缺省行为）；
  - HTML：`mix-blend-mode`；
  - SVG：`mix-blend-mode`（写在节点样式上）。

**Canvas 的合成操作与 CSS 的混合模式**（初版写错过，见 §5.1）：
Canvas 2D 的 `globalCompositeOperation` 里也有 `multiply` / `screen` / `hue` 等
与 CSS 同名的混合模式，而且本机浏览器实测**与 CSS 逐像素一致**（§5.1 的探针）。
所以画布侧 16 种模式都能画，不需要退回 normal。

真正的差别只有一处：**Canvas 的合成操作是「就地」的**——
它作用于当前正在画的内容与画布上已有内容的混合，没有「把一个图层组整体混合」
的概念。父层的混合模式要作用于整个图层组，必须靠离屏合成（§5.2）。

### 4.2 椭圆渐变

现在有 `radial`（径向/圆形）渐变，缺 Figma 的**椭圆**渐变。

CSS 没有原生椭圆渐变，但 SVG 有 `<radialGradient gradientTransform="matrix(...)">`。
本项目走 SVG 路径：
- **数据模型**：`Paint` 新增 `{ type: "elliptical"; cx, cy, rx, ry, stops }`，
  `rx`/`ry` 是椭圆的两个半轴（相对盒子的比例）。
- **几何**：在 `paint.ts` 里把椭圆渐变映射成 SVG 的
  `gradientTransform`（缩放 + 平移），画布侧用 Canvas 的
  `createRadialGradient` + 变换近似。
- **HTML 导出**：CSS 的 `radial-gradient(ellipse <size> at <position>, ...)`。

### 4.3 背景模糊

Figma 的「背景模糊」= 节点后面的内容被模糊，节点自身不模糊。
CSS 的对应物是 `backdrop-filter: blur(Npx)`。

- **数据模型**：`AppearanceSpec.backgroundBlur?: number`（px）。
- **三处渲染**：
  - 画布：Canvas 2D **没有** backdrop-filter 的等价物。
    做法是把背景快照按节点盒子裁剪后画上去再模糊——需要离屏合成，
    成本高。**本轮画布侧先不给效果并给出警告**，
    HTML/SVG 侧用 `backdrop-filter` / `<filter>` 准确表达。
  - HTML：`backdrop-filter: blur(Npx)`；
  - SVG：`<filter><feGaussianBlur>` + 背景副本。

### 4.4 验收

- 混合模式在画布上生效，`normal` 与缺省行为一致；
- 混合模式在 HTML 导出里输出 `mix-blend-mode`，SVG 导出里同样；
- Canvas 不支持的混合模式（`hue` 等）**给出警告而不是画错**；
- 椭圆渐变在 SVG 导出里输出带 `gradientTransform` 的 `<radialGradient>`；
- 椭圆渐变在 HTML 导出里输出 `radial-gradient(ellipse ...)`；
- 背景模糊在 HTML/SVG 导出里生效；
- **旧文档（无新字段）导出产物逐字不变**——golden 基线不破；
- 导出支持矩阵新增对应行，能力等级与实际实现一致（不夸大）。

### 4.5 落地结果（2026-11-08）

三项能力全部落地。**schema 版本不变**（`blendMode` / `backgroundBlur` /
`elliptical` 都是可选字段，旧文档用默认值即可兼容，不需要迁移）。

#### 混合模式

- **数据模型**：`AppearanceSpec.blendMode?: BlendMode`，16 个取值与 CSS
  `mix-blend-mode` 完全一致。
- **映射表**：`packages/design-schema/src/blend.ts`——
  `BLEND_MODES` / `canvasCompositeFor` / `isBlendModeSupportedOnCanvas` /
  `cssBlendMode`。Canvas 与 CSS 的名字完全一致，映射表只做类型上的对应。
- **画布**：16 种全部可画。其中 4 种颜色类混合（`hue` / `saturation` / `color` /
  `luminosity`）当时被误判成「Canvas 没有等价物」而退回 normal 并警告，
  §5.1 用实测推翻了这条前提，已改正。
- **HTML / SVG**：名字与 CSS 相同，原样输出即可，不需要翻译。
- **隔离**：页面（HTML）与 SVG 根元素在**确实存在混合模式时**加
  `isolation:isolate`，让混合只发生在设计内部，而不是跟浏览器窗口底色混在一起。
  没有混合模式的旧文档导出产物**逐字不变**（这条是条件写入，不是无条件加）。

#### 椭圆渐变

- **数据模型**：`Paint` 新增 `{ type: "elliptical"; cx; cy; rx; ry; stops }`。
  `rx` / `ry` 分别是半轴占盒子**宽 / 高**的比例——与径向渐变的「半径占长边」
  基准不同（径向只有一个半径，只能挑一个基准；椭圆有两个轴，各自对各自的边
  才说得清）。
- **几何**：`paint.ts` 的 `ellipticalGeometry()`，画布 / SVG / HTML 三处共用，
  导出与画布不会各算一套。
- **画布**：Canvas 的 `createRadialGradient` 只能画正圆。做法是**离屏合成**：
  在离屏画布上画一个正圆渐变，再按椭圆的外接矩形贴回主画布并按形状裁剪——
  圆形被非等比缩放后正是椭圆，而被填充的形状一点没变形。离屏画布按色标缓存，
  同一渐变不重复绘制。
  *没有离屏画布时*（老浏览器 / 测试环境）退化成圆形渐变并给出警告。
- **SVG**：`<radialGradient r="1" gradientTransform="matrix(rx 0 0 ry cx cy)">`
  ——单位圆 + 缩放矩阵，SVG 没有原生的椭圆径向渐变。
- **HTML**：`radial-gradient(ellipse <rx>px <ry>px at <cx>% <cy>%, ...)`。

#### 背景模糊

- **数据模型**：`AppearanceSpec.backgroundBlur?: number`（px）。
- **HTML**：`backdrop-filter:blur(Npx)`，语义与 Figma 一致（节点自身不模糊）。
- **SVG**：SVG 没有 `backdrop-filter`。做法是把**同层里排在它前面的兄弟**
  复制一份，按节点形状裁剪后用 `<feGaussianBlur stdDeviation="N/2">` 模糊，
  压在节点下面。
  *已知近似*：副本里不含祖先节点自己的背景，所以支持矩阵里 SVG 一栏记为
  `approximated` 而不是 `exact`。
- **画布**：Canvas 2D 没有等价物，要做需要离屏合成，**本轮不实现**——
  只给出警告。属性面板里也写明了「导出到 HTML/SVG 才生效」，
  免得用户在画布上看不出效果以为功能坏了。

#### 其他

- **属性面板**：新增「混合模式」下拉（16 项）、「背景模糊」数值框、
  椭圆渐变的四个参数（中心 X/Y、横半轴、纵半轴），以及实色层的
  「改为椭圆渐变」入口。
- **支持矩阵**：新增 `blend-mode` / `gradient-elliptical` / `background-blur`
  三行，等级据实标注（不夸大）。
- **测试**：`design-schema/test/blend.test.ts`（10 条）、
  `design-schema/test/schema.test.ts`（+2）、
  `design-export/test/appearance.test.ts`（10 条）、
  `studio-web/test/canvas-renderer.test.ts`（+5）、
  `studio-web/test/renderer-scene.test.ts`（+1）。

#### 实现中避开的四个坑

1. **画布椭圆渐变不能靠 `ctx.scale` 实现**：变换矩阵会同时作用到路径，
   圆角矩形的圆角会被拉成椭圆弧——形状本身变形了。离屏贴图绕开了这一点。
2. **SVG 椭圆渐变不能沿用径向渐变的写法**：直接写 `cx/cy/r` 画出来的还是正圆，
   必须用「单位圆 + `gradientTransform`」。
3. **SVG 背景模糊不能直接给节点加 `<feGaussianBlur>`**：那样模糊的是节点自己，
   不是它后面的内容——语义正好相反。
4. **`design-schema` 不引 DOM lib**：Canvas 的 `GlobalCompositeOperation`
   类型在包里不可用，于是包内自己声明了一份同名子集
   （`CanvasCompositeOperation`），赋值给 `context.globalCompositeOperation`
   时类型依然兼容。
5. **「Canvas 不支持颜色类混合」是个错误前提**：初版把
   `hue` / `saturation` / `color` / `luminosity` 当成 Canvas 没有的，
   退回 normal 并给警告。§5.1 的探针证明本机浏览器 16/16 与 CSS 逐像素一致，
   这条限制已撤销。

#### 尚未实现

- 椭圆渐变的旋转角（Figma 支持旋转渐变，本项目只支持居中不旋转）→ §5.4 补上。


## 5. 本轮：画布侧离屏合成（分组混合 / 背景模糊 / 渐变旋转）

上一轮把混合模式、椭圆渐变、背景模糊三件事在**数据模型与导出侧**做完了，
画布侧只做了「Canvas 能直接表达」的部分。本轮把剩下的补齐。

### 5.1 先验证一个前提：Canvas 到底支持哪些混合模式

初版结论是：「Canvas 2D 只有 Porter-Duff 与分离式混合的前 12 种，
`hue` / `saturation` / `color` / `luminosity` 没有等价物」——
**这个结论是错的**，而且它已经写进了代码、测试和文档。

证据不是查文档，而是**让浏览器自己当裁判**：
`packages/studio-web/visual/blend-probe.ts` 在同一张图里画两遍——
左边用 CSS `mix-blend-mode`，右边用 Canvas `globalCompositeOperation`——
截屏后逐像素比对重叠区域。本机 Chrome 结果：

```
一致    hue           CSS=rgba(139,139,255,255)  Canvas=rgba(139,139,255,255)
一致    saturation    CSS=rgba(203,140,76,255)   Canvas=rgba(203,140,76,255)
一致    color         CSS=rgba(139,139,255,255)  Canvas=rgba(139,139,255,255)
一致    luminosity    CSS=rgba(238,120,0,255)    Canvas=rgba(238,120,0,255)
...
16/16 种模式在画布上与 CSS 一致。
```

结论：Canvas 与 CSS 的混合模式**名字相同、语义相同**，翻译表只做类型对应。
§4.5 里「12 种能对上、4 种退回 normal 并警告」的结论与相关代码一并撤销。
探针留在仓库里：以后再有「Canvas 能不能做 X」的疑问，先跑探针，别靠记忆。

### 5.2 混合模式的分组语义（离屏合成）

Canvas 的合成操作是**就地**的：它把「当前正在画的内容」与「画布上已有内容」
混合，没有「把一个图层组整体混合」这个概念。
Figma 的语义（图层混合模式作用于整个图层组）因此必须靠离屏合成：

1. 把节点**和它的整棵子树**画进一张离屏画布（坐标系平移到离屏原点）；
2. 用 `globalCompositeOperation = <混合模式>` 把这张离屏整体贴回主画布。

嵌套自然成立：子节点有混合模式时，会在父节点的离屏层里再开一层离屏。
离屏层的尺寸只取「节点 + 子树」的包围盒（含阴影与模糊的溢出余量），
不是整张画布。

没有离屏画布时（老浏览器 / 测试环境）退回「直接设合成操作」的近似，
并明确给出警告——近似不能悄悄发生。

### 5.3 背景模糊（离屏快照）

Canvas 没有 `backdrop-filter` 的等价物，但「背景模糊」本质上是
**对已经画好的内容做一次局部模糊**，可以这样实现：

1. 把主画布上「节点后面已经画好的内容」按节点区域（外扩模糊半径的余量）
   快照到离屏画布；
2. 在离屏画布上用 `filter: blur()` 模糊（半径换算成**设备像素**，
   免得缩放时模糊大小跟着变——离屏画布的坐标空间就是设备像素，没有额外缩放）；
3. 贴回主画布，并**按节点自身形状裁剪**：形状之外保持清晰，与 Figma 一致。

裁剪区域在 `clip()` 调用时就固化成设备空间，所以后续的变换不影响它。

已知限制：跨域图片会污染画布，快照会抛 `SecurityError`——
捕获后给出警告并跳过模糊，而不是让整帧渲染崩掉。

### 5.4 椭圆渐变的旋转角

`Paint.elliptical` 增加可选 `angle`（度，顺时针，缺省 0 = 不旋转）。

- **画布**：离屏圆形渐变 → 先按形状裁剪 → 再 `translate / rotate / scale` 后贴回；
- **SVG**：`gradientTransform` 用完整的 2×3 矩阵（平移 × 旋转 × 缩放）；
- **HTML**：CSS 的 `radial-gradient` **没有旋转**，只能丢掉旋转 →
  导出时给出诊断，支持矩阵里注明这条限制。

### 5.5 验收

- 探针脚本 `visual:blend-probe` 报告 16/16 与 CSS 一致；
- 混合模式在画布上按**图层组**生效：父层有混合模式时，它的子树整体参与混合；
- 背景模糊在画布上只模糊节点形状之内、节点后面的内容，形状之外保持清晰；
- 椭圆渐变的旋转角在画布与 SVG 里精确，在 HTML 里降级并给出诊断；
- 旧文档（无新字段）画布与导出产物**逐字不变**——visual 回归仍是 0 像素差异；
- 探针本身可复跑（不是一次性脚本）。

### 5.6 落地结果（2026-11-08）

#### 混合模式：撤销「Canvas 不支持」的误判

- `design-schema/src/blend.ts` 重写：16 种模式**全部**映射到
  `globalCompositeOperation`，名字逐字相同，不再有「翻译表」与「退化分支」。
  `isBlendModeSupportedOnCanvas` 保留为显式判据，但对所有取值都返回 true。
- 探针 `packages/studio-web/visual/blend-probe.ts`（`npm run visual:blend-probe`）
  留在仓库里：它让浏览器用 CSS 和 Canvas 各画一遍同一张图并逐像素比对，
  本机结果 16/16 一致。以后再有「Canvas 能不能做 X」的疑问，先跑探针。
- 上一轮写进代码、测试与文档的错误结论一并撤销（§4.1 / §4.5 已更正）。

#### 混合模式：图层组语义

- 渲染器新增 `Surface` / `SurfaceFactory`：一张可复用的离屏画布
  （`OffscreenCanvas`，没有则退回 `document.createElement("canvas")`）。
- 有混合模式的节点会**连同整棵子树**画进离屏层，再用
  `globalCompositeOperation` 整体贴回主画布 —— 这才是 Figma 的图层语义。
  嵌套天然成立：子节点有混合模式时，会在父节点的离屏层里再开一层离屏。
- 离屏层的尺寸取「节点 + 子树」的轴对齐包围盒（旋转过的节点用旋转后的包围盒），
  再加上阴影与图层模糊的溢出余量 —— 不是整张画布。
- 没有离屏画布时退回「就地混合」，**并明确给出警告**：图层组不再整体参与，
  这种降级不能悄悄发生。

#### 背景模糊：画布侧实现了

- 从主画布按节点区域（外扩模糊半径的余量）快照 → 在离屏画布上用
  `filter: blur()` 模糊 → 贴回主画布并**按节点自身形状裁剪**（旋转过的节点，
  裁剪形状也跟着旋转）。
- 模糊半径换算成**设备像素**后再交给离屏画布：离屏的坐标空间就是设备像素，
  这样缩放时模糊大小不会跟着漂移。
- 跨域图片会污染画布，快照会抛 `SecurityError`：捕获后给出警告并跳过模糊，
  不让整帧渲染崩掉。
- 画布降级提示现在会**显示在状态栏**上（`CanvasSurface` → `onWarning` → 状态栏），
  不再只躺在控制台里。

#### 椭圆渐变的旋转角

- `Paint.elliptical` 增加可选 `angle`（度，顺时针，缺省 0）。
- 画布：离屏圆形渐变 → 先按形状裁剪（裁剪区域此时固化）→ 再
  `translate / rotate / scale` 贴回。
- SVG：`gradientTransform` 用完整的 2×3 矩阵（平移 × 旋转 × 缩放）；
  不旋转时与上一轮的写法逐字一致。
- HTML：CSS 的 `radial-gradient` 没有旋转 → 丢掉旋转，并给出
  `gradient-rotation` 的 `approximated` 诊断；支持矩阵新增该行。

#### 验证

- `visual:blend-probe`：16/16 与 CSS 一致。
- 核心 7 个包与 studio-web 452 条测试全绿；新增用例覆盖
  图层组合成、无离屏退化、背景模糊快照与裁剪、渐变旋转、SVG 矩阵、
  HTML 旋转降级诊断。
- **visual 回归仍是 0 像素差异**（HTML 导出基线 + 画布基线）——
  旧文档既没有混合模式也没有背景模糊，渲染路径一字未变。

#### 仍然存在的近似

- 背景模糊的快照来自**主画布当前内容**：祖先节点自己的背景已经画在上面，
  所以在它上面是对的；但被别的图层组离屏合成过的内容不在快照里（离屏层
  已经合成进主画布了，所以其实在）—— 真正的边界情况是「先混合再模糊」与
  「先模糊再混合」的顺序差异，本项目固定为先模糊后混合。
- 椭圆渐变的旋转在 HTML 里丢失（CSS 没有这个能力）。


## 6. 本轮：组件属性（component props）

差距表里最后一个完全没做的线 A 项。变体（§2 第 2 项）解决的是
「同一个组件的几种固定形态」，取值是**封闭**的；
组件属性补的是「组件对外暴露一组有类型、有默认值的参数」。

对 Figma 来说这是锦上添花，对本项目是刚需：
定位是「本地优先 + 可被 Agent 驱动」，而 override 只能按
「源节点 id + 字段」表达——对模型是无结构的黑话，对人类也不是设计意图。
属性是**有名字、有类型、有默认值**的契约。

完整规格见 `docs/component-properties.md`，这里只记范围与验收。

### 6.1 范围

- **数据类型**：`text` 与 `boolean` 两种，用判别联合保证类型与默认值配对。
- **绑定字段**：`text`（文本节点内容）与 `visible`（节点可见性）两个。
  绑定写在**被绑定的节点**上（方向是「字段 → 属性 id」），
  节点删除时绑定随之消失。
- **实例取值**：实例只存**显式改过**的值（`propValues`），
  没改过的跟随组件默认值——与 Figma 一致。
- **物化顺序**：复制子树 → 应用 override → **应用属性值**。
  属性是更高层的契约，优先于字段级覆盖；
  与之配套，`component.override` **拒绝**写入被属性绑定的字段，
  不让人以为改成功了。
- **命令**：`component.property.set / remove / bind / unbind`、
  `instance.property.set / reset`。
- **UI**：实例面板新增「组件属性」区（文本框 / 勾选框 + 恢复默认）；
  选中组件内部节点时，属性面板新增「组件属性」区（暴露 / 解绑 / 删除）。
- **不升 schema 版本**：三个新字段全可选，旧文档无需迁移。

### 6.2 验收

- 属性声明、绑定、解绑、删除的命令行为有测试覆盖（runtime 18 条）；
- 文档校验能发现悬空绑定、类型不匹配的默认值、未知属性 id、
  实例值类型错误（schema 12 条）；
- 展示层数据有测试覆盖（studio-web 6 条）；
- 变体继承属性声明，切换变体时实例的显式值按属性 id 保留；
- 旧文档（无新字段）画布与导出产物逐字不变——visual 回归 0 像素差异。

### 6.3 已知限制

- 属性只支持两种类型，不支持实例交换、颜色、字号等。
- **属性声明按组件各存一份**，不是变体集共享；源组件改默认值
  不会同步到已经存在的变体（变体是复制出来的独立组件）。
- 文本属性写纯文本，会清掉被绑定文本节点的段内样式。
- 属性不能跨组件嵌套引用：组件 A 的属性不会自动传给 A 内部 B 的实例。

## 7. 本轮：富文本段落样式（列表 + 缩进）

§2 第 4 项里剩下的那一半。段内样式（`runs`）解决的是「一段话里把几个词加粗」，
段落样式解决的是「这一段是列表项 / 这一段缩进一级」——
**列表是信息结构，不是装饰**：功能清单、导航目录、变更日志都要列表。

对 Figma 来说是标配，对本项目更刚需：定位是「本地优先 + 可被 Agent 驱动」，
而「画布只能画一堆等宽的段落」意味着 Agent 生成的文案稿没法直接用。

完整规格见 `docs/paragraph-styles.md`，这里只记范围与验收。

### 7.1 范围

- **存储**：`TextNode.paragraphStyles?: ParagraphStyleRun[]`，用**对齐段落边界**的
  UTF-16 区间承载（与 `runs` 同构，但区间语义刻意不同：段落样式必须整段覆盖）。
- **样式**：`listType`（`bullet` / `ordered`）+ `indent`（0–4 级，对齐 Figma 的 5 级上限）。
- **编号不存进文档**：渲染期按段落顺序现算（编号 → 字母 → 罗马，随级别循环），
  插行删行不需要迁移数据。
- **命令**：`text.paragraph.set`（区间吸附到段落边界、样式增量、
  `listType: "none"` 取消列表、`indentDelta` 相对缩进）。
- **文本改写**：改字时用 `remapParagraphStyles()` 按「字符是否还在」重新对齐；
  段落被换行劈开时两段都继承样式，整段被删时样式一起消失。
- **UI**：属性面板「文字」区新增「段落」小节（列表类型分段控件 + 缩进步进器）。
- **不升 schema 版本**：新字段全可选，旧文档无需迁移。
- **不做**：段落缩进（px）、悬挂列表、列表间距、列表类型混排。

### 7.2 验收

- 段落边界、校验、区间对齐与合并、remap、编号格式有测试覆盖（schema 25 条）；
- 行偏移、标记区、编号递增与重置、hug 宽度含缩进有测试覆盖（layout 7 条）；
- 命令层：区间吸附、增量语义、取消列表、文本改写 remap、撤销（runtime 12 条）；
- 导出层：HTML 的 `<ul>/<ol>` 分组、编号显式给值、缩进 padding；
  SVG 的标记文本（export 10 条）；
- 画布层：标记右对齐、正文右移、折行后不再画标记（studio-web 5 条）；
- 旧文档（无段落样式）画布与导出产物逐字不变——visual 回归 0 像素差异。

### 7.3 已知限制

- 段落缩进（px，Figma 的 Paragraph indent）本轮不做：与列表缩进在几何上重叠，
  两套缩进并存会让「缩进了多少」说不清。
- 一个文本节点不能混排多种列表类型（有序里嵌无序）。
- 组件实例的文本覆盖只同步 `text`，不同步段落样式。
- SVG 不换行，段落样式只解决缩进与标记。

## 8. 本轮：画布内联编辑（样式可视化）

§2 第 4 项的最后一个缺口：**已实现的能力在编辑时像没实现**。

双击文本进入编辑时，编辑层原本是一个纯 `<textarea>`，只应用节点级样式——
段内加粗、斜体、颜色、字号全看不见，列表段落也只是一堆平铺的行。
用户会以为功能坏了。

本轮把编辑层换成**结构化 `contenteditable`**：段落是 DOM 里的块，段内 run 按样式
渲染成 `<span>`，列表段落带标记与缩进。完整规格见 `docs/inline-text-editing.md`。

### 8.1 为什么不是「高亮层 + 透明 textarea」

常见做法是两层叠放（底层渲染样式、顶层透明 textarea 承接输入）。
本轮没采用：那个方案里有**两个排版系统**，段内字号变化与列表缩进都会让
两层的换行位置与缩进错位，光标随之漂移。要同时支持这两者，
就必须只有一个排版系统——于是编辑层直接是 `contenteditable`。

### 8.2 验收

- 段落描述、DOM 构建、文本还原、键盘规则有测试覆盖（studio-web 12 条）；
- **真实浏览器探针**（`npm run visual:inline-editor-probe`）：
  浏览器认得段内加粗（计算 `font-weight` 是 700）与段内颜色、
  列表标记可见且右对齐、**正文起点与画布的 `left` 完全一致**、
  插入字符后能从 DOM 还原文本；
- 探针已并入 `npm run check:visual`。

### 8.3 已知限制

- 编辑器里不能直接改样式（加粗/变色/列表/缩进仍走属性面板）；
- 编辑期间属性面板改样式不实时反映到编辑器（下一次进入编辑才生效）；
- 编辑态不显示混合模式、阴影、模糊等节点级效果。

## 9. 本轮：导出物内联字体

§2 第 5 项（字体管理）的最后一环：**交付物**。

导出的 HTML 里只有 `font-family:"…"`、没有字体文件时，对方机器上没装这个字体
就会走回退字形——「画完了、交出去、字变了」。PNG 不受影响（文字已光栅化），
HTML 受影响最重。

本轮把**文档声明过**的字体内联进 HTML 交付物（`@font-face` + data URI），
并在上传时读出字体文件里的真实族名与字重。规格见 `docs/font-inline.md`。

### 9.1 子集化：为什么当时说「实测不可靠」，现在又做了

当时的结论写在 `font-inline.md` §2：`subset-font` 是 Node-only，
`fonteditor-core` 的 `write({ subset })` 不裁字形（Arial 1 MB → 只留 8 个字符
仍是 365 KB）。把「实测不可靠」的能力写进交付链路比不做更糟。

**后来找到了可靠路线**：`harfbuzzjs` 这个 npm 包带了一份**独立的
`harfbuzz-subset.wasm`**（683 KB），直接导出 `hb_subset` 的 C API。
把它接进浏览器端之后，子集化变成可靠能力：

- 浏览器用 Vite 的 `?url` 拿资源、**导出时才 fetch**（懒加载）；
- Node 与浏览器跑的是同一份 `subsetFontBytes`（wasm 字节由调用方注入）；
- 实测：`PressStart2P-Regular.ttf`（118,204 B）只留 `abc` → **5,464 B**。

超限字体现在先子集化再内联；子集化不可用（没装能力 / 格式不支持 / 失败）时
退回「不内联 + 记诊断」。规格见 `font-management.md` §7。

### 9.2 验收

- 字体收集、声明匹配、`@font-face` 生成、体积阈值、字重回退诊断有测试覆盖
  （design-export 16 条、studio-application 9 条、studio-web 4 条）；
- 子集化：cmap 只剩用到的字符、体积显著变小、压缩格式与空字符集被拒
  （design-export 5 条）；超限字体走子集化路径并内联子集（studio-application 2 条）；
- **真实浏览器探针**（`npm run visual:font-inline-probe`）：
  导出物里的字体**真的被加载并应用**（同一页面里先量回退字体宽度、
  再装上 `@font-face` 量第二次：304px → 608px，宽度不同即证明字体生效）；
- **SVG 侧也有探针**（`npm run visual:svg-font-probe`）：走真实导出路径，
  顶层 `.svg` 文档、HTML 内联 `<svg>`、`<img src="…svg">` 三种加载场景，
  文字宽度都从 483.6px 变成 912px（Press Start 2P 的等宽步进），
  `<img>` 场景的截图肉眼可见像素字体；
- 两个探针都已并入 `npm run check:visual`。

> 顺带修掉一个**老 bug**：SVG 导出写 `font-family` 时不加引号，
> 于是 `Press Start 2P` 这类含数字的族名会让整条声明作废（`2P` 不是合法
> CSS 标识符）——导出的 SVG 根本用不上声明的字体。现在只在必要时加引号，
> 裸写时旧产物逐字不变。

### 9.3 已知限制

- **子集化只支持 sfnt**（TrueType / OpenType）：woff / woff2 要先解压；
- 裁掉的字形就没了：交付物里的字体只有导出时用到的那些字形；
- 内联让 HTML 体积增加约 33%（base64 的代价）；
- **SVG 里的 `@font-face` 只有浏览器认**：Illustrator / Inkscape / Figma
  导入 SVG 时不执行 CSS，落到那些工具里仍是回退字形（工具行为，不是导出物的问题）。

## 10. 本轮：剩余八项

线 A 里剩下的八项差距，这一轮全部补齐。每一项都先写规格文档、再写代码，
能力断言一律实测。

| # | 能力 | 结果 | 规格 |
| --- | --- | --- | --- |
| 1 | 段落样式剩余（段落缩进 / 悬挂列表 / 列表间距） | ✅ | `paragraph-styles.md` |
| 2 | 智能锚点吸附增强 | ✅ | `snapping.md` |
| 3 | 布尔组：曲线级布尔 | ✅ | `boolean-and-mask.md` §10 |
| 4 | 字体子集化（harfbuzz wasm） | ✅ | `font-management.md` §7 |
| 5 | Grid 可视化轨道编辑 | ✅ | `grid-layout.md` |
| 6 | SVG 导出的字体内联 | ✅ | `font-inline.md` §8 |
| 7 | 组件属性类型扩展 + 变体集共享声明 | ✅ | `component-properties.md` |
| 8 | 原型运行时：滚动保持 + 滚动容器 | ✅ | `prototype-runtime.md` §7 / §8 |

### 10.1 段落样式剩余

段落缩进（px，只对左对齐生效）、悬挂列表（标记画在文本框外，裁剪区往左让位）、
列表间距（加在段末行高上）。三项都进了 schema / 布局 / 运行时 / 导出 / 属性面板，
共 5 个测试文件、33 条用例。

### 10.2 智能锚点吸附

从「盒子对盒子」升级到**锚点语义**：9 个锚点（角 / 边中点 / 中心），
加上**等间距检测**（夹在一串等距目标中间，或接在一串之后）。
按住 **Alt** 临时关闭吸附。吸附提示会画出等间距短线并标注数值。

### 10.3 曲线级布尔

运算树的结果从「多边形近似」升级为**保留曲线**：
用 paper.js（MIT，`paper-core` 无 DOM 依赖）做曲线级布尔，
路径转换用 `cubicCurveTo`（paper 的 `curveTo` 是「过点」二次曲线，用错直接抛错）。

实测：两圆（r=40，相距 40）union → 8 段三次贝塞尔，
面积 8089.71 vs 解析解 8087.70（误差 0.02%）。

代价：浏览器主包 +335 KB。设计成**引擎注入**（`design-schema` 零几何依赖），
没装引擎时退回多边形近似。

### 10.4 字体子集化

放弃 Node-only 的 `subset-font` 与不裁字形的 `fonteditor-core`，
改用 `harfbuzzjs` 包内**独立的** `harfbuzz-subset.wasm`（683 KB）：
wasm 字节由调用方注入（`design-export` 不碰 fs / Buffer），
浏览器用 Vite 的 `?url` 懒加载，Node 与浏览器跑同一份核心逻辑。

实测：`PressStart2P-Regular.ttf`（118,204 B）只留 `abc` → **5,464 B**。
超限字体先子集化再内联；不可用时退回「不内联 + 记诊断」。

### 10.5 Grid 可视化轨道编辑

Grid 面板里可以直接**拖拽改轨道宽度**、增删轨道；
内容轨道（`auto` / `min-content` / `max-content`）不可拖拽——
它们没有固定宽度可言。轨道宽度的代数放在 layout 包，
编辑状态机放在 studio-web，既有求解器一行未改。

### 10.6 SVG 导出的字体内联

SVG 交付物此前和 HTML 一样只带 `font-family`、不带字形。
现在与 HTML **共用同一套**字体准备逻辑（收集 / 匹配 / 1 MB 阈值 / 子集化 / 诊断），
差别只有落点：规则写进根 `<svg>` 下的一个 `<style>` 元素。

**先实测再实现**：新探针走真实导出路径，覆盖顶层 `.svg` 文档、
HTML 内联 `<svg>`、`<img src="…svg">` 三种加载场景，文字宽度都从
483.6px 变成 912px（Press Start 2P 的等宽步进）。

顺带修掉一个**老 bug**：SVG 导出写 `font-family` 时不加引号，
`Press Start 2P` 这类含数字的族名会让整条声明作废（`2P` 不是合法 CSS 标识符），
导出的 SVG 根本用不上声明的字体。现在只在必要时加引号，裸写时旧产物逐字不变。

### 10.7 组件属性类型扩展 + 变体集共享声明

属性类型从 `text` / `boolean` 扩到五种：新增 `instance-swap`（实例交换）、
`color`（颜色）、`number`（字号），**并且能真的绑到节点字段上**：

| 字段 | 属性类型 | 节点要求 |
| --- | --- | --- |
| `text` | `text` | 文本节点 |
| `visible` | `boolean` | 任意 |
| `fill` | `color` | 任意 |
| `fontSize` | `number` | 文本节点 |
| `instance` | `instance-swap` | 实例节点 |

字段与属性类型的对应由 `BINDING_REQUIREMENTS` **一张表**决定，
命令层与文档校验层读同一张表。

**变体集共享声明**：同一个变体集里的每个变体不必重复声明同一组属性——
在集合上声明一次，集内所有变体都拿到。合并规则：同名 id 组件自己的优先
（但**不得改类型**，那是破坏共享契约，命令层与文档校验都会拦）。

实例交换是真交换：旧子树删掉、新组件的根子树重新物化到副本下，
副本 id 规则与实例物化一致（物化逻辑抽成了 `materializeNode` 共用）。

### 10.8 原型运行时：滚动保持 + 滚动容器

- **`preserveScroll`**：`navigate` 动作上的正向开关。
  离开一屏时记住各滚动宿主的偏移，`preserveScroll: true` 到达时读回，
  否则重置为 0。`back` / `prev-screen` 一律保持（「返回」就是回到刚才待过的地方）。
- **滚动容器**：节点上的可选字段 `overflow`（`hidden` 缺省 / `scroll` / `visible`），
  只有容器型节点能带。滚轮落在哪个宿主上就滚哪个——
  从命中路径最深往上找第一个「能滚」的宿主，滚不动的跳过继续往外找。
  滚轮用**非被动**监听器接：React 的 `onWheel` 是被动监听，
  `preventDefault()` 不生效，浏览器会把外层预览区一起滚走。

字段全可选，**不升 schema 版本**，旧文档行为逐字不变。

## 11. 后续排期

| 优先级 | 能力 | 依赖 | 预估 |
| --- | --- | --- | --- |
| P0 | Grid 布局 | **已完成**（可视化轨道编辑、命名区域、自动重复轨道，见 §10 / `grid-layout.md` §9 / §10） | — |
| P0 | 组件变体 | 已完成 | — |
| P0 | 原型运行时 | 已完成（滚动保持与滚动容器见 §10） | — |
| ~~P1~~ | ~~富文本~~ | 段内样式 + 段落样式 + 内联编辑可视化已完成 | — |
| P1 | 字体管理 | **已完成**（导出内联 + 子集化，见 §9 / §10） | — |
| P1 | 布尔组 | **已完成**（曲线级布尔，见 §10） | — |
| P2 | 混合模式 / 椭圆渐变 / 背景模糊 | **已完成**（画布侧见本轮 §5） | — |
| ~~P2~~ | ~~组件属性~~ | **已完成**（见本轮 §6 / §10） | — |
| ~~P2~~ | ~~段落样式~~ | **已完成**（见本轮 §7 / §10） | — |
| ~~P2~~ | ~~内联编辑样式可视化~~ | **已完成**（见本轮 §8） | — |
| ~~P2~~ | ~~导出物内联字体~~ | **已完成**（见本轮 §9 / §10） | — |
| ~~P2~~ | ~~智能锚点吸附~~ | **已完成**（锚点语义 + 等间距，见 §10） | — |
| ~~P3~~ | ~~画布侧背景模糊与分组混合~~ | 已完成（§5） | — |

## 12. 编辑器交互与表现层补齐（2026-11-11）

这一轮把线 A 里剩下的编辑器交互缺口与几项表现层能力补上。

### 12.1 编辑器交互

| 能力 | 做法 | 已知限制 |
| --- | --- | --- |
| 多选整体旋转 | 绕**选区旋转后包围盒的中心**刚性旋转整组（`studio-web/src/renderer/multi-rotate.ts`）；单选按绝对角度吸附、多选按**增量**吸附以保刚性；手柄旁显示角度 | 旋转**不参与布局**——stack 父级里旋转节点仍占原格子（与 Figma 一致），已加**如实提示**；真正支持需改 `design-layout` |
| 缩放工具 | `ToolId` 新增 `zoom`（快捷键 `Z`）：单击放大 / Alt+单击缩小 / 拖动连续缩放，**以鼠标所在点为锚点** | — |
| 跨父级编组 | frame 落在**最近共同祖先**，坐标按绝对盒换算，`documentOrder()` 保住叠放次序 | 取消编组把子节点放回 frame 的父级，**不回到各自原父级**（schema 无「原父级」字段） |
| 子节点级视口裁剪 | 递归裁剪子节点（默认激进）；安全边界把描边、模糊、羽化、阴影外扩算进来；旋转节点按旋转后 AABB 裁剪 | 父级不在视口但有可见后代时保留该父级 |
| 实例约束覆盖 | studio-web 侧隔离接口 + 属性面板分段 | **底层未放行**（需 `OverrideField` / `component.override` payload / 运行时白名单配合），未放行时只说清原因 |

顺带修掉一个既有缺陷：旋转提交原来传相对坐标又减一次父级原点，**嵌套节点 x/y 被减两次**
（顶层节点看不出来，所以一直藏着）。现在旋转与移动/缩放统一用绝对坐标。

### 12.2 表现层

| 能力 | 做法 | 已知限制 |
| --- | --- | --- |
| 阴影 `spread` | Canvas 走离屏合成（描边膨胀 + 模糊 + 偏移，`shadow*` 没有扩散半径）；HTML 第 4 值；SVG `feMorphology` | 普通投影仍走快速路径，旧渲染不变 |
| 内阴影 | `ShadowSpec.type: "drop" \| "inner"`；Canvas 离屏求差、HTML `inset`、SVG `feComposite` | — |
| 子树整体模糊 | 统一为「模糊整棵子树」（原先画布只模糊自身、SVG/HTML 模糊子树） | 阴影与模糊的层序仍有细微差异（SVG 先模糊再投影，HTML/画布一起模糊） |
| 文本多层填充上色 | 规则集中在 `textFillColor()`，三端共用；修掉 SVG 文字 `fill:none` **不可见**与 HTML **无 `color:`** 两个缺陷 | 多层与渐变标 `approximated` 并出诊断 |
| 布尔操作数旋转 | 操作数路径绕自身中心旋转；布尔组盒子改用旋转后并集框 | 圆角仍不参与运算 |
| 蒙版 alpha / 羽化 | 新增 `maskFeather`；软蒙版画布离屏合成、SVG `<mask>`、HTML `mask-image` | alpha 只取第一层实色填充；椭圆在 HTML 仍用折线近似 |

### 12.3 文本与组件

| 能力 | 做法 | 已知限制 |
| --- | --- | --- |
| 段内行高覆盖 | `TextRunStyle.lineHeight`；行盒高度 = max(节点行高, 该行 run 覆盖, 该行最大字号) | **行高不参与换行**；SVG 不换行，只体现为段间推进距离 |
| 编辑器内直接改样式 | 浮动工具条 + `Ctrl/Cmd+B`；Range → UTF-16 偏移；提交时从 DOM 回读 `runs` | 应用样式会丢失浏览器原生撤销栈（选区由代码恢复） |
| 属性面板实时反映 | 编辑层区分结构变化（重建 DOM）与样式变化（只更新 span 样式，保留光标） | 编辑态不显示节点级效果（混合模式等） |
| 单节点混排列表类型 | 编号语义对齐 Figma：**不同类型的列表是独立序列** | 对已有混排文档是行为变更（编号从延续变成重新从 1 开始） |
| 变体默认值同步 | 区分「继承拷贝」与「显式特化」，改集合默认值时删继承拷贝改为真继承 | 启发式判定（值全同即视为继承） |
| 文本属性保留段内样式 | 改用 `remapTextRuns` / `remapParagraphStyles` 对齐区间 | 完全不同的文本时样式自然消失（不报错） |

### 12.4 仍未做

- **变体间的结构共享**：当前数据模型不能表达（每个变体是独立深拷贝的树，变体集没有结构字段）。
  推荐方案是加可选 `role?: string`，覆盖迁移改为「角色键优先、路径兜底」。
- 旋转真正参与自动布局重排（需改 `design-layout`）。
- 实例级约束覆盖的底层放行（需改 design-schema / design-runtime）。
- 渐变文字在 HTML/画布的精确实现（CSS `background-clip:text` 会破坏选中与可访问性）。

## 13. 参照来源

- Penpot Grid 实现：`common/src/app/common/geom/shapes/grid_layout/`
  （`params.cljc` 轨道与参数计算、`positions.cljc` 单元格定位、`bounds.cljc` 包围盒、
  `areas.cljc` 命名区域、`layout_data.cljc` 中间表示）
- Penpot 背景模糊：`common/src/app/common/types/shape/background_blur.cljc`
- Penpot 混合模式：`common/src/app/common/types/shape/attrs.cljc`（`:blend-mode` 为节点属性）
- CSS `mix-blend-mode`：<https://developer.mozilla.org/docs/Web/CSS/mix-blend-mode>
- CSS `backdrop-filter`：<https://developer.mozilla.org/docs/Web/CSS/backdrop-filter>
- SVG `radialGradient`：<https://developer.mozilla.org/docs/Web/SVG/Reference/Element/radialGradient>
- Figma 列表与段落缩进：<https://help.figma.com/hc/en-us/articles/360039827134-Bulleted-and-numbered-lists>
- Figma 插件 API `TextNode`（`paragraphIndent` / `hangingList`）：<https://www.figma.com/plugin-docs/api/TextNode/>
- Figma Grid 布局产品文档：<https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-auto-layout>
- Penpot / Figma 能力对比：见 `penpot-porting.md` §6
- 曲线级布尔：paper.js（MIT）：<https://paperjs.org/>
- 字体子集化：harfbuzzjs（`harfbuzz-subset.wasm`）：<https://github.com/harfbuzz/harfbuzzjs>
- Figma 组件属性（component props）：<https://help.figma.com/hc/en-us/articles/15339657135383>
- Figma 原型的滚动保持（默认保留，「Reset scroll position」是反向开关）：
  <https://help.figma.com/hc/en-us/articles/360040531773-Prototype-scroll-position>
