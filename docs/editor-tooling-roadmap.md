# 编辑器工具系统演进计划

> 文档状态：生效中的工具能力基线
> 最后更新：2026-11-07
> 当前阶段：P1–P6 完成；后续为各相位顺延项
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`、`canvas-renderer-roadmap.md`

## 1. 问题：不是「按钮太少」

讨论「工具是不是太少」时，容易直接落到「再加几个图标」。但按现状清点，顶栏已经有 17 个
控件（面板 ×2、创建 ×5、历史 ×2、项目 ×2、导出 ×5、删除项目 ×1），视觉上并不空。
真正的缺口是**抽象层级**：

- 现有的 5 个「创建」按钮是**瞬时插入**——点一下就在默认坐标生成一个默认尺寸的节点
  （`main.tsx` 的 `addNode` → `makeNode`），没有「先画后建」这个过程；
- 画布上的指针手势只有两种（`renderer/use-canvas-drag.ts`）：移动节点和框选。
  没有「拖拽绘制」这个手势，所以也不可能存在「当前工具」这个概念；
- 于是图元的尺寸只能通过检查器改数值获得，而不是拉出来。

所以真正要补的不是按钮数量，而是**工具（tool）这一层状态机**：当前指针在画布上
「准备做什么」。按钮只是工具的一种入口。

## 2. 起点盘点（P1 之前的代码事实）

> 这一节记录的是动工前的状态，保留下来是为了说明每个相位到底改掉了什么。
> 现在已经关闭的缺口在 §3 的矩阵里标了 ✅。

| 维度 | 现状 | 落点 |
| --- | --- | --- |
| 图元创建 | Frame / 矩形 / 椭圆 / 文本 / 图片，全部瞬时插入默认尺寸 | `main.tsx` `addNode`、`makeNode` |
| 绘制手势 | 只有「拖动已选节点」「拖动手柄缩放」「空白处框选」 | `renderer/use-canvas-drag.ts` |
| 位置与尺寸 | `layout.x/y/width/height` + `widthMode/heightMode` | `design-schema/src/types.ts` |
| 形状语义 | `rectangle` / `ellipse` 二选一，圆角是单值 | `AppearanceSpec.cornerRadius?: number` |
| 矢量 | `NodeType` 里有 `"vector"`，但 schema 只有通用字段，**没有路径几何**；渲染器对非椭圆一律按圆角矩形画 | `types.ts:61`、`schema.ts:56`、`canvas-renderer.ts:96` |
| 外观 | `opacity` / `fill` / `stroke` / `cornerRadius` 四个字段 | `AppearanceSpec` |
| 描边 | 画布统一按 1px 画（模型里没有宽度） | `renderer/scene.ts:87` |
| 变换 | 无旋转、无约束 | — |

`vector` 这个类型目前是**预留的空位**：能被校验、能被图层树识别，但画不出任何东西。
任何「加个钢笔工具」的提案都必须先解决几何表达，否则只是给空位加个按钮。

## 3. 差距矩阵

| 类别 | 现在 | 缺 | 相位 | 是否要改文档格式 |
| --- | --- | --- | --- | --- |
| 形状 | 矩形、椭圆、**直线/多边形/星形** | 自定义边数 | P2 ✅ | 是（矢量几何，已完成） |
| 形状 | **四角独立圆角 + 可变描边宽度** | 圆角半径按百分比 | P2 ✅ | 否（新增可选字段） |
| 矢量 | **归一化 M/L/C/Q 路径 + 钢笔 + 节点编辑 + 插点 + 锚点类型** | 多选锚点、锚点吸附 | P3 ✅ | 是（`vector.geometry`，已完成） |
| 矢量 | **布尔运算 + 蒙版** | 保留布尔组、曲线级布尔、alpha 蒙版 | P4 ✅ | 否（布尔烘焙成路径；蒙版复用 `mask` 属性而不是新节点类型） |
| 模式 | **选择、绘制、抓手** | 缩放工具 | P1 ✅ | 否 |
| 几何 | **旋转（绕自身中心）+ 框外手柄** | 多选整体旋转 | P5.1 ✅ | 否（`layout.rotation` 可选字段） |
| 几何 | **约束（贴边/居中/拉伸/缩放）** | 约束可视化预览、实例级覆盖 | P5.2 ✅ | 否（`constraints` 可选字段） |
| 几何 | **蒙版（兄弟层裁剪）** | alpha 蒙版 / 羽化 | P4 ✅ | 否（`mask?: boolean`） |
| 外观 | **纯色 + 线性/径向渐变 + 多层填充** | 椭圆渐变、混合模式 | P6.2 ✅ | 是（`fills[]` 替换 `fill`，schema v3 迁移已完成） |
| 外观 | **投影 + 图层模糊** | spread、内阴影、子树整体模糊 | P6.1 ✅ | 否（新增可选字段） |
| 排版 | 对齐（右键菜单） | **等距分布 + 多选浮出工具条** | P2 ✅ | 否 |

## 4. 设计原则

1. **工具是模式，不是动作。** 工具选中后进入一个持续状态：指针光标变化、按下开始绘制、
   松开提交、自动切回选择工具。按钮的 `aria-pressed` 表达这个状态。
2. **一次绘制 = 一个事务。** 松手时发一条 `node.create`，因此可撤销、可重放、不破坏
   revision 语义。绘制过程中的预览是纯视图状态，不进文档。
3. **工具状态是视图状态。** `tool` 不进文档、不涨 revision、不写快照，和 `zoom` 同级。
4. **模型只加有渲染语义的字段。** 不给 schema 加「UI 需要但画不出来」的字段——`vector`
   已经是前车之鉴。
5. **向后兼容优先用可选字段，而不是升版本。** 只有无法用默认值兼容时才升
   `CURRENT_SCHEMA_VERSION`，并登记 `MIGRATIONS` 步骤（见
   `design-schema/src/migrate.ts`）。
6. **未完成的工具不出现在工具栏上。** 宁可没有钢笔，也不放一个画不出曲线的钢笔。

## 5. 分阶段计划

### P1：工具模式与拖拽绘制（✅ 已完成）

**目标**：把「插入按钮」升级成「工具」，让图元可以拉出来画出来。

- 新增 `packages/studio-web/src/tools.ts`（纯函数层，不依赖 React）：
  - `ToolId = "select" | "frame" | "rectangle" | "ellipse" | "text" | "hand"`；
  - `TOOLS`：工具元数据（名称、快捷键、图标、光标、创建的节点类型）；
  - `rectFromDrag(start, current, { shift, alt })`：拖拽矩形求解——
    Shift 等比（正方形/正圆）、Alt 从中心展开、两者同时成立时从中心画正方形；
  - `clampRect(rect, bounds)`：绘制范围钳制在画板内；
  - `shortcutTool(key)`、`nextToolAfterDraw(tool)`、`defaultRectFor(type)`。
- `use-canvas-drag` 增加 `draw` 手势：工具是图元工具时，按下即进入绘制（不再框选/移动），
  移动时更新预览矩形，松手回调 `onDraw(rect, { dragged })`。
- `main.tsx`：用 `tool` 状态取代 `panMode` 布尔（抓手 = 工具之一）；绘制提交后创建节点、
  选中它、自动切回选择工具。
- 画布：绘制预览用虚线框绘制（`paintDrawPreview`），与框选取样式区分。
- 顺带修复：`canvas-surface` 的 `onAfterPaint` 在选区为空时提前 return，
  导致「从空白处开始框选」时选框根本不画——绘制预览也依赖同一个位置。
- 快捷键：`V` 选择、`F` Frame、`R` 矩形、`O` 椭圆、`T` 文本、`H` 抓手、`Esc` 回到选择。

**验收**：

- 选中矩形工具后在画布上拖拽，松手得到一个尺寸等于拖拽范围的矩形，并被选中；
- 按住 Shift 得到正方形，按住 Alt 从中心展开；
- 单击（不拖拽）创建默认尺寸节点；
- 绘制不会写入文档的额外字段，撤销一次即回到绘制前；
- 空选区下框选能看到选框（回归修复）；
- `tools.test.ts` 覆盖矩形求解与快捷键。

**不做**：绘制时按住 Alt 复制、绘入 Frame 的内部嵌套、按住空格临时切换抓手。

**验收结果（2026-11-07）**：

- `packages/studio-web/src/tools.ts`：`ToolId`、`TOOLS`、`rectFromDrag`、`clampRect`、
  `defaultRectFor`、`shortcutTool`、`nextToolAfterDraw` 全部为纯函数，不依赖 React/DOM；
- `renderer/use-canvas-drag.ts` 新增 `draw` 手势：图元工具按下即绘制，修饰键逐帧求值，
  松手回调 `onDraw(rect, { dragged })`，`pointercancel` 不留半成品；
- `renderer/selection-overlay.ts` 新增 `paintDrawPreview`（虚线 + 半透明填充，线宽与
  虚线段长按 zoom 换算；椭圆工具画椭圆预览，与最终形状一致）；
- 顺带修复 `canvas-surface` 的绘制顺序缺陷：此前 `onAfterPaint` 在选区为空时提前
  return，导致「从空白处开始框选」时选框根本不画；现在框选与绘制预览在选区判空之前绘制；
- `main.tsx`：`panMode` 布尔收敛为 `tool` 状态（抓手成为工具之一），绘制提交后创建节点、
  选中、自动回到选择工具；`V/F/R/O/T/H/Esc` 快捷键；图元工具下单击不再改变选中态、
  双击不再进入文本编辑；拖出范围钳制在 960×680 画板内；
- 测试：`test/tools.test.ts`（13 条）与 `test/renderer-draw-preview.test.ts`（4 条），
  `npx tsx --test test/*.test.ts` 全量 311 条通过，`tsc -b` 通过。

### P2：形状族与描边宽度（✅ 已完成）

**目标**：让「形状」不再只有矩形和椭圆——补上直线、多边形、星形，并让描边有真实宽度。

**几何契约（本次定稿，取代原 §P3 草案）**：

```ts
export interface VectorGeometry {
  kind: "path";
  /** 归一化路径：坐标落在 [0,1]，相对节点布局盒；只允许 M/L/Z。 */
  d: string;
}
export interface VectorNode extends BaseNode {
  type: "vector";
  /** 缺省时沿用旧的「按圆角矩形画」回退 + 导出诊断，保证旧文档不变。 */
  geometry?: VectorGeometry;
}
```

三个决定，理由写在 `design-schema/src/geometry.ts` 里：

1. **坐标归一化到 [0,1]**，而不是绝对像素。这样改宽高就是缩放图形——和 Figma 里拉
   多边形一样；否则每次 resize 都要重写路径。
2. **只允许 M/L/Z**。贝塞尔（C/Q）与圆弧（A）留给 P3：它们需要手柄编辑和一整套
   拟合/布尔算法，先把多边形做完比半成品曲线更有价值。
3. **不引入 `polygon` / `star` / `line` 节点类型**。三者都是 `vector` + 一段路径，
   否则类型数会随形状数线性增长，导出、命中、复制粘贴每处都要加分支。

**落地范围（本轮）**：

- `design-schema/src/geometry.ts`：路径解析/校验/绝对化/命中（点在多边形内 + 到线段
  距离，直线因此不会「点哪儿都选中」），以及带缓存的解析结果；
- 新工具 `line` / `polygon` / `star`。工具栏平铺而不是长按子菜单：5 个图元仍然一屏
  可辨，子菜单在数量到 8 以后再说；
- 直线用 `M/L` 两段表达，节点盒子取两点包围盒并保证至少 1px 高（水平线否则无法命中）；
- `AppearanceSpec.strokeWidth?: number`：画布、SVG、HTML、属性面板各补一处；
- 导出：SVG 直接输出 `<path d>`，HTML 输出内联 `<svg viewBox>`；`vector` 的支持等级
  从 `unsupported` 升为 `exact`，但**没有 geometry 的旧节点仍发诊断**。

**不做（顺延）**：几何编辑（拖锚点）——那属于 P3 的钢笔/直接选择工具。

**验收**：拖出直线/多边形/星形后画布形状与命中一致；改宽高时图形随之缩放；SVG/HTML
导出含同一条路径；`supportFor("vector", "svg") === "exact"`；旧文档（无 geometry 的
vector）导出产物逐字不变，golden 不破。

**验收结果（2026-11-07）**：

- `design-schema/src/geometry.ts`：严格解析器（M/L/Z、坐标必须落在 [0,1]）、按 `d` 缓存、
  绝对化、序列化、命中（闭合走奇偶规则、开放走线段距离，容差 6px）、正多边形与星形
  生成器；schema 用 zod refinement 在写入时就拒绝 C/Q/A/H/V；
- `studio-web/src/shapes.ts`：把拖拽的 start/end 变成「盒子 + 归一化路径」；直线盒子
  任一边为 0 时撑到 1px 并以线段为中心（否则命中测试直接判空）；
- 工具：`line`（L）/ `polygon`（G）/ `star`（S），平铺在顶栏；绘制结束后仍回到选择工具；
- 画布：`scene.path` → `canvas-renderer` 在**绝对坐标**上 `moveTo/lineTo`，不用
  `ctx.scale()`（缩放上下文会把描边一起拉粗）；`hit-test` 走同一份路径；
- 导出：SVG 输出 `<path d>`，HTML 输出内联 `<svg viewBox>`（外层 div 不再铺背景矩形）；
  `vector` 支持等级升为 `exact`；没有 geometry 的旧 vector 保持原输出与诊断，golden 未变；
- `AppearanceSpec.strokeWidth`：画布、HTML（`border:Npx`）、SVG（`stroke-width`）、
  属性面板各接一处；缺省 1px 时导出字符串与升级前逐字相同；
- 四角独立圆角（P2 收尾）：`AppearanceSpec.cornerRadii?: [number, number, number, number]`
  （顺序同 CSS），`resolveCornerRadii` 是画布/HTML/SVG 的唯一解析入口。画布用每角一次
  `arcTo`（半径为 0 的角自动退化成直线），HTML 直接输出四值 `border-radius`，
  SVG 的 `<rect rx>` 只有单值，所以四角不同时改输出 `<path>` + `A` 圆弧——**圆弧只出现在
  导出产物里，文档格式仍然只有 M/L/Z**。四角相同时继续走单值分支，导出产物不变。
  属性面板在「圆角」与四个角字段之间切换（拆分/合并），不做两套并行输入；
- 等距分布：`arrangeNodes` 里本来就有 `distributeX/Y`（等间隙、首尾不动），但没有任何
  入口——本轮把它接进右键「对齐」子菜单和多选浮出的工具条，属于「有功能但找不到」的修复；
- 多选浮出的对齐工具条：定位在未缩放的 `.canvas-stage` 里，位置按 `bounds × zoom` 换算，
  所以按钮始终是屏幕尺寸；对齐 6 个 + 分布 2 个，少于 3 个对象时分布按钮禁用；
- 测试：`geometry.test.ts`（16 条）、`shapes.test.ts`（6 条），导出/渲染/校验侧新增的
  矢量与四角圆角用例共 9 条；`design-schema` 44 条、`design-export` 51 条、
  `studio-web` 326 条全部通过，`build:studio-core` 与 `vite build` 均成功。

### P3：钢笔与路径编辑（✅ 已完成）

完整规格见 [`pen-and-path-editing.md`](pen-and-path-editing.md)（对标 Figma 的 Pen / Edit Object）。

- **P3.1 曲线数据层（✅）**：`geometry.ts` 支持 `C`/`Q`；在曲线上的点必须落在
  `[0,1]`，**控制点允许越界**；包围盒按离散化后的路径算，所以向外鼓的弧仍在盒内。
  画布 `bezierCurveTo`、命中走 `flattenPath`、导出直接输出曲线（离散化只用于命中与包围盒）。
- **P3.2 钢笔（✅）**：`P` 工具 + 草稿状态机（`src/pen.ts` + `renderer/use-pen-tool.ts`）。
  单击落角点、拖动拉出对称手柄、点回起点闭合、`Enter`/`Esc`/双击结束；`Shift` 把拖拽方向
  吸附到 45°。草稿是视图状态，**一次路径 = 一条 `node.create` = 一次撤销**。
- **P3.3 节点编辑（✅）**：双击或 `Enter` 进入编辑态，命中优先级「手柄 > 锚点 > 图形本体 >
  空白退出」。拖锚点/手柄实时预览，松手提交一条 `vector.patch`（几何与布局同命令）；
  `Alt` 断开对称、`Shift` 约束手柄方向、`Delete` 删除锚点。新增 `vector.patch` 命令，
  沿用 `text.patch` / `image.patch` 的先例。
- **P3.4 线段插点（✅）**：在编辑态点击路径线段即可插入锚点，并顺势进入拖动。曲线用
  de Casteljau 在 t 处切分，**形状一点不变**；直线段不会插出控制点。指针悬停线段时
  光标变 `copy`。
- **P3.5 锚点类型切换（✅）**：双击锚点切角点/平滑点。**没有新增字段**——有没有手柄就是类型；
  平滑化的方向取「前后邻居连线」，长度各取到邻居的 1/3，切换即时提交。
- **顺延**：多选锚点、锚点吸附、带独立手柄的尖角（cusp，需要显式类型字段）。

### P4：布尔运算与蒙版（✅ 已完成）

完整规格见 [`boolean-and-mask.md`](boolean-and-mask.md)。

- **布尔运算（✅ 已完成）**：合并/减去/交集/排除，**不在文档里保留运算树**——应用时把
  操作数烘焙成一条路径，结果是 `vector` 节点，操作数删除，整批在一个事务里完成。
  基准层是 z 序最下面那一层（与 Figma 一致）。算法用 `polygon-clipping`（MIT，
  Martinez–Rueda），只加在 `studio-web`：布尔是编辑操作，文档里只存结果。
  代价是结果不含曲线（输入先离散成折线），写在规格里。
- **命中修复**：多子路径（带洞结果）此前会被 `flattenPath` 首尾相连成一条折线，
  洞里也能点中；现在按环判定并用**非零环绕数**，与 Canvas/SVG 的填充规则一致。
- **蒙版（✅ 已完成）**：`mask?: boolean` 属性（不是新节点类型），裁剪同一父级里排在
  它**上面**的兄弟。画布用 `clip()` 叠加、命中用 `maskedBy` 排除被裁掉的区域；
  SVG 输出 `<clipPath>`，HTML 输出 CSS `clip-path:path()`。页面直属节点与容器子节点
  共用同一套兄弟遍历，避免页面级蒙版静默失效。
  已知限制：蒙版圆角被忽略、自动布局里的 HTML 蒙版位置可能不准、不支持 alpha 蒙版。

### P5：旋转与约束（✅ 已完成）

完整规格见 [`rotation-and-constraints.md`](rotation-and-constraints.md)。

- **旋转（P5.1 ✅ 已完成）**：`layout.rotation`（角度制、顺时针为正、绕节点中心）。
  命中「每层逆变换回本地」、选择框画旋转四边形与旋转手柄、缩放先按本地增量再
  「对角钉住」修正漂移、SVG `transform="rotate(θ cx cy)"`、HTML `transform:rotate(θdeg)`。
  几何全部集中在 `renderer/rotation.ts`，手柄命中复用原有实现，没有第二份判定逻辑。
- **约束（P5.2 ✅ 已完成）**：`constraints`（`start/end/center/stretch/scale` × 两轴），
  在 `node.patch` 里由运行时应用——属性面板、手柄缩放、AI 计划、外部集成自动共享同一套
  行为；父级 patch 与子节点重排落在同一条命令里，撤销一次整体还原。stack 父级与 hug
  父级跳过（前者由布局引擎排，后者尺寸是结果不是输入）。
- **约束预览（✅）**：拖动父级手柄时子节点按约束实时跟随；`constrainLayout()` 由运行时导出，
  画布与提交共用同一套公式（各写一份的话松手会跳）。预览只喂绘制层，提交仍走一条 `node.patch`。
- **顺延**：多选整体旋转、旋转后的自动布局重排。

### P6：外观表达能力（✅ 已完成）

完整规格见 [`appearance-effects.md`](appearance-effects.md)。

- **阴影与模糊（P6.1 ✅ 已完成）**：`appearance.shadow?` 与 `appearance.blur?`，纯新增可选
  字段、无迁移。Canvas 用 `shadowBlur`/`ctx.filter`，SVG 用 `<filter>` +
  `feDropShadow`/`feGaussianBlur`（`stdDeviation = 模糊半径 / 2`），HTML 用
  `box-shadow`/`filter`；支持矩阵新增 `effects` 行。
  不做 `spread`（三套实现的量纲对不齐）、内阴影、子树整体模糊。
- **渐变（P6.2 ✅ 已完成）**：`fill: string` → `fills: Paint[]`，schema 升到 **v3** 并登记
  `MIGRATIONS` 的 v2 → v3 步骤；`resolveFills()` 成为唯一读取入口（token 绑定会压成实色），
  `gradientLine()` 让画布/HTML/SVG 共用同一套渐变几何。
- **多填充层（✅ 已完成）**：画布逐层填充、HTML 用 `background-color` + 倒序的
  `background-image`、SVG 逐层输出图元；阴影只投一次、描边只画一次；面板可增删并切换层。
- **径向渐变（✅ 已完成）**：`{ type: "radial", cx, cy, r, stops }`，`radialGeometry()` 统一
  三处几何；半径取长边比例，`r = 0.5` 在正方形上刚好盖满。

## 6. 快捷键与光标约定

| 键 | 工具 | 光标 |
| --- | --- | --- |
| `V` | 选择 | 默认 |
| `F` | Frame | 十字 |
| `R` | 矩形 | 十字 |
| `O` | 椭圆 | 十字 |
| `L` | 直线 | 十字 |
| `G` | 多边形 | 十字 |
| `S` | 星形 | 十字 |
| `P` | 钢笔 | 十字 |
| `T` | 文本 | 文本 |
| `H` | 抓手（或按住中键） | 抓手 |
| `Esc` | 回到选择（再按一次清空选区） | — |

约定补充：

- 绘制结束后自动回到选择工具，并且新建节点处于选中态——和 Figma 的手感一致；
- 修饰键在拖拽过程中实时生效（不是按下时锁定），因此可以边拖边按 Shift；
- 工具状态下单击节点不改变选中态（避免「想画却点选」的误操作），只有选择工具才选中。

## 7. 测试与验收策略

- **纯函数单测**：工具表、矩形求解、钳制、快捷键映射（`test/tools.test.ts`）。
- **画布像素回归**：绘制预览是一次性的临时绘制，不进基线；但新增的 `paintDrawPreview`
  要和框选一样保持屏幕像素线宽，补一条渲染器单测（假上下文断言 `setLineDash` 与
  `strokeRect` 参数）。
- **手工验收**：拖拽绘制、Shift/Alt、单击创建、Esc、撤销。
- **构建门禁**：`npm run build:studio-web`（`tsc -b` 会覆盖新增的 pure 模块）。

## 8. 非目标

- 不做 Figma 的完整工具体系（矢量网络、组件变体、自动布局交互手柄）；
- 不引入第三方画布引擎（Fabric/Konva/tldraw）；
- 不在本计划里改变文档的持久化与协作模型——工具只影响「如何产生命令」。

## 9. 与版本路线图的关系

P1 属于 `0.3.0`（人工编辑基础闭环）范围内的增量，不新增版本号，也不改变
`project-progress-and-version-roadmap.md` 的发布门槛。P2 及之后涉及文档格式变更的相位，
落地前必须先更新版本路线图与 `current-project-status.md`，再改 schema。

## 10. 画布跨容器拖拽（2026-11-09）

图层面板的跨容器拖拽早就有（`layer-reorder.ts` 的 `planReparent`），画布上是另一回事：
画布拖动只改坐标，节点永远留在原来的父级里。`0.3.0` 剩下的「嵌套编组移动与
跨容器拖拽约束」指的就是这条路径。

### 10.1 判定

落点容器用**几何包含**判定，不用命中测试：被拖节点跟着指针走，指针永远在它
上面，命中测试只会命中自己。判定用被拖集合的**预览包围盒中心**——中心进入
另一个容器，才是「放进去了」的直观含义。

规则集中在 `studio-web/src/canvas-reparent.ts`：

- 不能拖进自己的子树（会成环）；
- 不能拖进不能容纳子节点的节点（文本、图片这类叶子）；
- 不能拖进隐藏或锁定的容器；
- **不能拖进自动布局容器**（stack / grid）——那里子节点的位置由布局引擎决定，
  拖进去的坐标会被忽略，看起来就是「跳回去了」。这类操作请到图层面板改顺序；
- 多选时整组一起搬；父子同时被选中时只搬顶层那个。

拒绝时给出人话原因（`不能把节点放进它自己的子级里` /
`自动布局容器由布局决定位置，请在图层面板里调整顺序`），而不是默默挪回去。

### 10.2 命令与坐标

落点与当前父级不同时，提交 `node.reparent` + `node.patch`（坐标）。**坐标一律
换算成相对父级内容盒的局部坐标**：布局里的 `x` / `y` 本来就是局部坐标
（布局引擎算的是 `contentX + child.layout.x`），画布给的是页面坐标，此前直接
写回会让嵌套节点位置偏移。页面直接子节点的原点是 (0,0)，因此老行为逐字不变。

### 10.3 编组内部的整组搬移

选中一个编组里的若干子节点一起拖走时：

- 每个节点各换一次父级，**彼此的相对位置保持不变**（每个节点按自己的新绝对位置
  换算成新父级的局部坐标）；
- **搬空之后的原编组会被删掉**——编组的存在意义就是把那几个节点聚在一起，留个
  空壳是毛刺。判据是「**这次拖放搬走了它的最后一个子节点**」，不是「它现在没有
  子节点」：后者会把用户自己建的空 frame 也删掉。用户要留空 frame，就不会有
  子节点被搬走；
- 部分搬移（只搬走一部分）时编组保留；
- 整组被搬走后，命令序列是「N × (reparent + patch) + 1 × delete」，一次事务，
  可一次撤销。

### 10.4 已知边界

- 拖放到**页面空白处不会改变父级**：节点留在原容器里，只改坐标。这与 Figma 一致
  （指针不在任何 frame 上就不进 frame），要挪到页面层请用图层面板。
- 编组本身仍只支持**同级**节点，跨父级选区不能编组。

### 10.5 验收

- 纯逻辑（`test/canvas-reparent.test.ts`）：换父级 + 坐标换算、拖到页面层、
  已在容器内只改坐标、四类拒绝、多选去重、落点容器查找、整组搬出与相对位置、
  掏空删除与部分搬移保留。
- **运行时落地**：把整组搬出的命令序列交给 `DesignRuntime` 执行，检查文档里
  子节点的新父级、局部坐标与「编组已消失」——纯逻辑对而运行时炸是最常见的坑，
  所以这一条必须真跑运行时。
- 画布：拖动时预览正常，松手后节点进入目标容器且位置不跳；拖进自动布局容器
  被拒绝并提示；页面直接子节点拖动行为与改前一致。
