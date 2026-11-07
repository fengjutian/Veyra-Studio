# 编辑器工具系统演进计划

> 文档状态：生效中的工具能力基线
> 最后更新：2026-11-07
> 当前阶段：P1（工具模式与拖拽绘制）
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

## 2. 现状盘点（代码事实）

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
| 形状 | 矩形、椭圆 | 直线、多边形、星形 | P2 | 是（矢量几何） |
| 形状 | 单值圆角 | 四角独立圆角、描边宽度 | P2 | 否（新增可选字段） |
| 矢量 | 无 | 钢笔、铅笔、路径编辑 | P3 | 是（`vector.geometry`） |
| 矢量 | 无 | 布尔运算 | P4 | 否（应用时烘焙成路径） |
| 模式 | 无 | 选择、绘制、抓手、缩放工具 | **P1** | 否 |
| 几何 | x/y/w/h | 旋转 | P5 | 是（`layout.rotation`） |
| 几何 | 无 | 约束（左/右/上/下/居中） | P5 | 否（新增可选字段） |
| 几何 | 无 | 蒙版 | P4 | 是（新节点类型） |
| 外观 | 纯色填充 | 渐变、多填充层 | P6 | 是（`fills[]` 替换 `fill`） |
| 外观 | 无 | 阴影、模糊 | P6 | 否（新增可选字段） |
| 排版 | 对齐（右键菜单） | 等距分布、选中态工具条 | P2 | 否 |

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

### P1：工具模式与拖拽绘制（本次实现）

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

### P2：形状族与选中态工具条

- 长按「矩形」展开形状子菜单：矩形、椭圆、直线、多边形、星形。
- 直线/多边形/星形需要几何表达，见 §6 的 `vector.geometry` 草案；直线可以先落到
  `vector` + 两段 `M/L`。
- `AppearanceSpec` 增加 `cornerRadii?: [number, number, number, number]` 与
  `strokeWidth?: number`（都可选，旧文档不受影响；画布、HTML/SVG 导出各补一处）。
- 对齐/分布：右键菜单已有对齐，补等距分布，并在多选时浮出选中态工具条——这是
  「有功能但找不到」的修复，比继续往顶栏堆图标更有效。

### P3：矢量与路径编辑

文档格式升到 v3（`migrate.ts` 登记 v2 → v3）：

```ts
// 草案
export interface VectorGeometry {
  kind: "path";
  /** SVG path data；只接受 M/L/C/Q/Z，不解析 A（各实现椭圆弧差异太大）。 */
  d: string;
}
export interface VectorNode extends BaseNode {
  type: "vector";
  geometry?: VectorGeometry; // 缺省时沿用现有圆角矩形回退
}
```

需要同时改：`scene.ts`（构造 `Path2D`）、`canvas-renderer.ts`（`fill(path)`）、
`hit-test.ts`（`isPointInPath`，并做包围盒快路径）、`design-export`（SVG 直接输出 `d`，
HTML 输出内联 `<svg>`）、选择框（按包围盒，暂不做顶点级编辑）。
钢笔（多次点击、贝塞尔手柄）与直接选择工具（拖锚点）是这一阶段最贵也最有价值的交互，
建议单独一轮迭代。

### P4：布尔运算与蒙版

- 布尔运算（合并/减去/交集/排除）**不在文档里保留运算树**：应用时把操作数烘焙成一条
  路径，结果是 P3 的 `vector` 节点，操作数删除，整批在一个事务里完成，可撤销。
  这样避免引入 `boolean` 节点类型以及「子节点被移动后结果失效」的一整类问题。
- 真正的取交集/差集需要可靠的路径布尔算法（`polygon-clipping` 一类），先评估依赖体积
  与许可证，再决定自研还是引入。
- 蒙版需要新的节点类型或 `mask` 字段 + 渲染器的 `clip()` 分支，排在布尔之后。

### P5：旋转与约束

- `layout.rotation?: number`（角度制，可选）。改动面比想象的大：命中测试要逆变换、
  选择框要按旋转后的包围盒、八向手柄的缩放方向要跟随旋转、HTML 导出用
  `transform: rotate()`、SVG 用 `transform`、PNG 走同一个 SVG 链路。
- 约束（`constraints?: { horizontal: "start" | "end" | "center" | "stretch" | "scale";
  vertical: ... }`）只在父容器尺寸变化时生效，是 P5 里性价比最高的一项，可以先做。

### P6：外观表达能力

- 填充从单值升级为 `Paint[]`（纯色/线性渐变/径向渐变/图片），旧字段 `fill` 需要迁移到
  `fills: [{ type: "solid", color }]`，属于**破坏性变更**，必须升 schema 版本并在
  `MIGRATIONS` 里登记；HTML 输出 `linear-gradient()`，SVG 输出 `<defs><linearGradient>`。
- 阴影与模糊是纯新增可选字段（`shadow?: { x, y, blur, spread, color }`），无迁移；
  Canvas 用 `shadowBlur`/`filter`，SVG 用 `feDropShadow`/`feGaussianBlur`，
  两者都要进 `EXPORT_SUPPORT_MATRIX` 并输出降级诊断。

## 6. 快捷键与光标约定

| 键 | 工具 | 光标 |
| --- | --- | --- |
| `V` | 选择 | 默认 |
| `F` | Frame | 十字 |
| `R` | 矩形 | 十字 |
| `O` | 椭圆 | 十字 |
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
