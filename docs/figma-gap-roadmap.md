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
| 6 | 布尔组（保留运算树） | ✅ | ✅ | ✅ 运算树 + 实时重算（结果无曲线） | A | **本轮完成** |
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

**6. 布尔组** — 已改为保留运算树：`boolean` 节点持有操作数，改子层或换运算都会实时重算，
参数化图形（可调滑块、数据驱动图表）因此可做。仍缺曲线级布尔（结果先离散成折线）。

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

## 4. 本轮：表现层能力（混合模式 / 椭圆渐变 / 背景模糊）

前三轮（Grid、组件变体、原型运行时）已经做完，线 A 的缺口收缩到了**表现层**——
「画出来对不对」这一类能力。这三项在 Figma 里都是日常高频操作，
而本项目此前完全空缺（只有 legacy Vibma 代码里有 mix-blend-mode 的痕迹，
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

## 6. 后续排期

| 优先级 | 能力 | 依赖 | 预估 |
| --- | --- | --- | --- |
| P0 | Grid 布局 | 已完成（缺可视化轨道编辑） | — |
| P0 | 组件变体 | 已完成 | — |
| P0 | 原型运行时 | 已完成（缺 hover 与滚动保持） | — |
| ~~P1~~ | ~~富文本~~ | 段内样式已完成，剩段内字号与段落样式 | — |
| P1 | 字体管理 | 已完成（剩子集化与导出内联） | — |
| P1 | 布尔组 | 已完成（剩曲线级布尔） | — |
| P2 | 混合模式 / 椭圆渐变 / 背景模糊 | **已完成**（画布侧见本轮 §5） | — |
| P2 | 组件属性 | 组件变体 | 中 |
| P2 | 智能锚点吸附 | 吸附基础版 | 中 |
| ~~P3~~ | ~~画布侧背景模糊与分组混合~~ | 已完成（§5） | — |

## 7. 参照来源

- Penpot Grid 实现：`common/src/app/common/geom/shapes/grid_layout/`
  （`params.cljc` 轨道与参数计算、`positions.cljc` 单元格定位、`bounds.cljc` 包围盒、
  `areas.cljc` 命名区域、`layout_data.cljc` 中间表示）
- Penpot 背景模糊：`common/src/app/common/types/shape/background_blur.cljc`
- Penpot 混合模式：`common/src/app/common/types/shape/attrs.cljc`（`:blend-mode` 为节点属性）
- CSS `mix-blend-mode`：<https://developer.mozilla.org/docs/Web/CSS/mix-blend-mode>
- CSS `backdrop-filter`：<https://developer.mozilla.org/docs/Web/CSS/backdrop-filter>
- SVG `radialGradient`：<https://developer.mozilla.org/docs/Web/SVG/Reference/Element/radialGradient>
- Figma Grid 布局产品文档：<https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-auto-layout>
- Penpot / Figma 能力对比：见 `penpot-porting.md` §6
