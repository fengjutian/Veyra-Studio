# 布尔运算与蒙版（P4）设计

> 文档状态：生效中的 P4 规格（布尔与蒙版均已实现）
> 最后更新：2026-11-08
> 对标：Figma 的布尔组（Union / Subtract / Intersect / Exclude）与 Mask
> 前置：`editor-tooling-roadmap.md` 的 P2/P3（归一化路径、钢笔、节点编辑已落地）

## 1. 对标：Figma 的布尔组怎么工作

| 维度 | Figma | 本项目 |
| --- | --- | --- |
| 操作 | Union / Subtract / Intersect / Exclude | 四个都做 |
| 基准层 | 选区里**最下面**的那一层是基准（Subtract/Intersect 以它为准） | 采用，按 `childIds` 顺序取最底层 |
| 结果形态 | 保留「布尔组」，可以展开、改子层、换运算 | **同样保留运算树**（2026-11-08 起）：操作数是子节点，几何读取时计算 |
| 结果样式 | 取基准层的填充/描边 | 取基准层的外观 |
| 曲线 | 精确保留 | **曲线级**（paper.js 引擎，结果保留贝塞尔；没装引擎时退回折线近似） |

早期版本把结果烘焙成一条路径，理由是「不必引入 `boolean` 节点类型」。代价是改一个操作数就得
重做整次运算——参数化图形（可调滑块、数据驱动图表）根本做不了。本轮改成**保留运算树**：
文档里只存 children + operation，几何在读取时计算，一份算法供画布、命中、导出共用。

## 2. 技术选型：polygon-clipping

自己实现 Greiner–Hormann 一类的多边形裁剪，在 UI 设计里会死在最常见的退化情形上——
**共线/对齐的边缘**（两个矩形并排、一个矩形正好嵌在另一个里）。这些恰恰是设计稿的常态，
不是边角案例。所以引入 [`polygon-clipping`](https://github.com/mfogel/polygon-clipping)
（MIT，Martinez–Rueda 算法）：纯 JS、浏览器安全、无原生依赖，能正确处理共线与重合边界。

代价与边界，写清楚而不是藏起来：

1. **结果不含曲线**（**旧路径，已被 §10 的曲线级引擎取代**）：输入先按 `flattenPath`
   （每段 16 份）离散成折线，输出也是折线。放大到 400% 时圆角会看到折线。
   这条路径现在只作为「没装引擎」时的兜底。
2. **依赖进 `design-schema`**：几何是文档语义的一部分（同一份运算树在编辑器、导出、AI 里必须
   算出同一个结果），因此 `polygon-clipping` 只加一次、放在核心包里；`design-runtime` 不直接
   依赖它，只依赖 schema 导出的纯函数。这打破了「核心包不引入几何依赖」的旧约束，是经过
   权衡的决定：多一个依赖，换来运算树在每条链路上一致。
3. **圆角/描边被忽略**：矩形转路径时只取四个角（`cornerRadius` 不参与布尔），描边宽度
   也不影响结果轮廓。Figma 同样只对几何轮廓做运算。

## 3. 数据与不变式

### 3.1 多子路径（带洞的结果）

差集和异或会产生**带洞**的形状。我们的路径模型天然支持：重复 `M` 就是新的子路径，
每个子路径以 `Z` 闭合。渲染（`beginPath` + 多次 `moveTo`）与 SVG 导出都已经正确。

**但命中测试此前是错的**：`flattenPath` 把多个子路径首尾相连成一条折线，带洞形状的命中
会落进洞里也算命中。所以本相位先把命中改成按**环**判定：每个子路径一个环，闭合环用
奇偶规则（洞里的点被穿过两次 → 判定为外部）。包围盒仍用 `flattenPath`，不受影响。

### 3.2 参与运算的形状

| 节点类型 | 处理 |
| --- | --- |
| `vector` | 直接用它的路径（多子路径全部参与） |
| `rectangle` | 取四个角（忽略 `cornerRadius`） |
| `ellipse` | 32 段折线近似 |
| 其他（文本/图片/Frame/组件/实例） | 拒绝，并提示「只支持形状与路径」 |

操作数必须**同一个父级**（跨 Frame 的布尔没有意义），且都可见、未锁定。

## 4. 操作语义

设选区按 `childIds` 从下到上为 `[A, B, C]`：

| 操作 | 计算 | 结果命名 |
| --- | --- | --- |
| 合并 | `union(A, B, C)` | 合并 |
| 减去 | `difference(A, B, C)`（A 是基准） | 减去 |
| 交集 | `intersection(A, B, C)` | 交集 |
| 排除 | `xor(A, B, C)` | 排除 |

生成的布尔组节点：

- `layout` = 操作数包围盒的并集，`parentId` = 操作数的父级；操作数坐标换算成相对布尔组；
- 插入位置 = 最高层操作数的原下标（视觉上「原地替换」）；
- 外观取基准层（填充/描边/描边宽度/透明度）；
- 提交为**一个事务**（`boolean.create`），一次撤销即可还原；
- `boolean.setOperation` 换运算会立刻重算；`boolean.release` 把操作数放回原父级（坐标不变）。

结果为空（例如完全不相交的交集）时不绘制，导出会给出 `boolean` 诊断。

## 5. 非目标

- 布尔结果与操作数的约束/自动布局联动；
- **蒙版**：Figma 的 mask 需要渲染器的「兄弟节点裁剪」与导出的 `<clipPath>`，
  和布尔是两套机制，放在 P4.2 单独做。

## 6. 验收

- 两个重叠矩形的并集/交集/差集/异或结果与 Figma 的轮廓一致（人工比对）；
- 差集产生洞时，点击洞内部**不该**选中该节点（环命中）；
- 曲线形状参与布尔后结果保留贝塞尔曲线，导出 SVG 的 `d` 与画布一致；
- 一次布尔 = 一个事务 = 一次撤销；
- `boolean.test.ts` 覆盖四种运算、带洞结果、对齐边缘（共线）这几种退化情形。

## 7. 实现结果（2026-11-08）

- `studio-web/src/boolean-clip.ts`：`polygon-clipping` 的模块形状适配层（它的类型声明
  写具名导出，实际产物只导出默认对象，直接 `import { union }` 会拿到 undefined）；
- `studio-web/src/boolean.ts`：操作定义、选区校验（同级 / 可见 / 未锁定 / 形状或路径）、
  z 序排序、形状→多边形（矩形四角、椭圆 32 段、矢量路径多环）、执行四种运算、
  多环结果→路径命令、包围盒与归一化；
- 入口：画布右键菜单的「布尔运算」子菜单（选中 ≥2 个对象时出现），逻辑在
  `main.tsx` 的 `applyBooleanToSelection`，提交 `node.create` + 若干 `node.delete` 的
  **单事务**，结果插在基准层原下标；
- 命中：`design-schema` 新增 `flattenRings`，`hitTestVectorPath` 改为按环判定并使用
  **非零环绕数**（与 Canvas/SVG 的默认填充规则一致）。此前多子路径会被首尾相连成
  一条折线，带洞形状的洞里也会命中；
- 测试：`boolean.test.ts` 9 条（含共线边缘、带洞差集、空结果、椭圆近似、跨父级拒绝、
  z 序基准）、`geometry.test.ts` 新增 2 条环命中；
- 依赖：`polygon-clipping@0.15.7`（MIT）只加在 `studio-web`，核心包不引入几何依赖。

未做：见 §10（曲线级布尔已于 2026-11-08 补齐）。

## 8. 蒙版（P4.2）

### 8.1 对标 Figma

| 维度 | Figma | 本项目 |
| --- | --- | --- |
| 定义 | 图层属性「用作蒙版」（`Ctrl/Cmd+Alt+M`），任何形状都能当蒙版 | `mask: boolean`，只允许 `vector` / `rectangle` / `ellipse` |
| 作用范围 | 同一父级里**在它上面**的兄弟层 | 相同：`childIds` 顺序里排在它后面的兄弟 |
| 蒙版自身 | 不再作为可见图形绘制，只保留裁剪作用 | 相同 |
| 嵌套 | 一个蒙版可以遮住多个兄弟 | 相同；多层蒙版按顺序叠加裁剪 |

一个决定：**蒙版不是新节点类型，而是一个布尔属性**。新建节点类型要动判别联合、导出、
组件、AI 计划解析的每一处；而「这块形状只用来裁剪」本来就是属性语义。

### 8.2 渲染与命中

- **画布**：遍历兄弟时维护「当前生效的蒙版」列表；遇到 `mask: true` 的兄弟就 push，
  后续每个兄弟在 `save()` 之后依次 `clip()`，画完 `restore()`。多层蒙版自然叠加。
  蒙版自身不绘制。
- **命中**：`SceneNode` 带上 `maskedBy`（指向它上面那些蒙版节点），`containsPoint()`
  先检查「点是否落在所有蒙版内」，不在就判不中——否则图片被裁掉的区域仍然可以点中，
  选中框也会出现在看不见的地方。
- **结构**：`buildScene` 分两遍——先建子树，再按兄弟顺序给被遮罩的节点挂 `maskedBy`。
  蒙版节点自己不被遮罩。

### 8.3 导出

- **SVG**：每个被遮罩的兄弟包一层 `<g clip-path="url(#mask-N)">`，蒙版几何进
  `<clipPath>`；`<defs>` 收集完再拼到文档里（SVG 允许 defs 出现在任意位置）。
- **HTML**：没有 `<clipPath>`，用 CSS `clip-path: path('…')`。要注意坐标系：
  `path()` 以**元素自己的 border box** 为原点，所以路径要先换算到父级坐标系、
  再减去该元素自身的 `left/top`。这是整块最容易写错的地方，单独抽 `maskClipPath()`。

### 8.4 非目标

- 蒙版羽化 / 透明度蒙版（Figma 的 alpha mask）：需要离屏合成，和现在的直绘管线不是一回事；
- 蒙版与自动布局的交互（蒙版不参与布局，和 Figma 一致）；
- 组件里把 mask 做成可覆盖字段。

### 8.5 验收

- 图片上面盖一个圆形蒙版 → 只有圆内可见，圆外点不中；
- 蒙版节点自己在画布上不可见，但能在图层树里选中、能改属性；
- SVG 导出带 `<clipPath>` 且预览与被裁结果一致；HTML 导出 `clip-path` 位置正确；
- 取消蒙版后一切恢复；整件事是一个 `node.patch`，可撤销。
## 9. 蒙版实现结果（2026-11-08）

- **模型**：`BaseNode.mask?: boolean`（可选，旧文档不受影响）；`node.patch` 接受它。
  运行时拒绝把文本/图片/容器设成蒙版——它们的「轮廓」没有明确语义，放进去只会让裁剪
  结果不可解释。
- **画布**：`buildScene` 分两遍，抽了 `applySiblingMasks()` 给页面直属节点和容器子节点
  共用（否则页面级蒙版会静默失效）；渲染器跳过蒙版自身，给后续兄弟 `save()` →
  逐个 `clip()` → `restore()`；多层蒙版天然叠加。
- **命中**：`SceneNode.maskedBy` + `containsPoint()` 先检查所有蒙版，被裁掉的区域点不中；
  蒙版自身也从命中里跳过（仍可在图层树里选中）。
- **导出**：SVG 生成 `<clipPath clipPathUnits="userSpaceOnUse">` 并把被遮罩兄弟包进
  `<g clip-path="url(#…)">`；HTML 用 CSS `clip-path:path('…')`，套一层
  `position:absolute; inset:0` 的容器让路径直接使用父级坐标。
- **入口**：右键菜单「用作蒙版 / 取消蒙版」，属性面板「外观」区同款按钮；都是一条
  `node.patch`，可撤销。
- **测试**：`renderer-mask.test.ts` 5 条（兄弟顺序、下层不受影响、多层叠加、裁掉的区域
  不可点、蒙版自身不可点）、导出侧 2 条、运行时 1 条；`studio-web` 362 条、
  `design-export` 53 条、`design-runtime` 51 条通过。

已知限制（都写在 §8.4 / §8.3）：

1. **蒙版圆角被忽略**：`cornerRadius` 不参与裁剪轮廓（HTML 的 CSS path 与画布的
   `roundRectPath` 各有一套圆角逻辑，先把直线版做稳）。椭圆用 32 段折线近似。
2. **自动布局里的蒙版**：HTML 导出用 flex 布局，蒙版路径按声明坐标算，和 flex 排出来的
   实际位置可能不一致；画布与 SVG 不受影响。
3. **蒙版不支持透明度羽化**（alpha mask），也还不能在组件里作为可覆盖字段。

## 9. 保留运算树（2026-11-08 更新）

改动的唯一理由：烘焙方案下「改一个操作数 → 结果失效」，参数化图形（滑块、数据驱动图表）
做不了。现在文档里只存运算树，几何在读取时计算。

### 9.1 数据模型

```ts
interface BooleanNode extends BaseNode {
  type: "boolean";
  operation: "union" | "subtract" | "intersect" | "exclude";
  childIds: NodeId[];   // 操作数，按 z 序；第一个是基准层
}
```

可选字段之外没有新增版本号：旧文档不含 `boolean` 节点，行为不变。

### 9.2 计算位置

`design-schema/src/boolean.ts`：

- `computeBooleanPath(document, node, boxes)` → 绝对坐标路径（`undefined` = 结果为空）；
- `computeBooleanGeometry(document, node, boxes, targetBox)` → 归一化到目标盒子的路径。

画布（`renderer/scene.ts`）与导出（`design-export` 的 HTML/SVG）都调用后者，命中测试复用
`hitTestVectorPath`——一条运算树在「画」「点」「导出」三条链路上只有一份几何。

### 9.3 命令

| 命令 | 语义 |
| --- | --- |
| `boolean.create` | 同级、≥2 个、形状、未锁定未旋转；操作数坐标换算为相对布尔组；布尔组插在最高层操作数的位置 |
| `boolean.setOperation` | 换运算类型，几何随即重算，不需要重新烘焙 |
| `boolean.release` | 操作数回到原父级并恢复绝对坐标，布尔节点删除、操作数 id 不变 |

`node.delete` 会把布尔组删到只剩一个操作数时拒绝：几何会消失，应先解除布尔组。

### 9.4 已知限制

- **曲线保留依赖引擎**：没装引擎时退回折线近似（见 §10）；
- 操作数不支持旋转（旋转后包围盒语义不清，命令层直接拒绝）；
- 圆角不参与运算（矩形按四个角算）；
- 布尔组按操作数包围盒**自动 hug**：操作数移动/缩放后重算原点与宽高，内容世界坐标不变；
  手动改布尔组自己的尺寸不会立即被覆盖，但下一次操作数变化会被重算回去。

## 10. 曲线级布尔（paper.js 引擎）

### 10.1 为什么单独一层

曲线级布尔需要真正的几何库，而 `design-schema` 是核心包：给它加一个重量级依赖，
会让所有消费者（浏览器、MCP 服务器、AI 编排）都背上这份体积。

所以做成**引擎注入**：

```ts
// design-schema/src/boolean.ts
export interface BooleanEngine {
  combine(operands: readonly PathCommand[][], operation: BooleanOperation): PathCommand[] | undefined;
}
export function setBooleanEngine(next: BooleanEngine | undefined): void;
```

- `computeBooleanPath` 先问引擎：装了就用曲线级结果；
- 没装（或引擎算不出来）→ 退回 §2 的多边形近似，行为与上一轮逐字一致。

引擎住在应用层（`studio-application/src/boolean-engine.ts`），由应用启动时安装：

- 浏览器：`studio-web/src/main.tsx` 在第一次绘制**之前**调用 `installPaperBooleanEngine()`
  （晚装会让首帧用近似结果，之后突然变曲线）；
- MCP：`bin/studio-mcp.ts` 与 `bin/studio-mcp-http.ts` 在启动时安装。

### 10.2 开源对标

| 方案 | 许可 | 曲线 | 浏览器 / Node | 取舍 |
| --- | --- | --- | --- | --- |
| [paper.js](https://github.com/paperjs/paper.js) | MIT | ✅ 保留贝塞尔 | ✅ / ✅（`paper-core` 无 DOM 依赖） | **选用** |
| [clipper2](https://github.com/Angus-Hu/clipper2) | BSL-1.0 | ❌ 只处理折线 | ✅ / ✅ | 许可证不是 MIT，且没有曲线语义 |
| [svg-path-boolean](https://github.com/svg-path-bounding-box/svg-path-boolean) | MIT | ✅ | ✅ / ✅（wasm） | wasm 体积大、**异步初始化** → 布尔计算会变成异步，渲染链路要跟着改 |
| 自研曲线布尔 | — | ✅ | ✅ | 曲线-曲线求交 + 环分类 + 分段重建，是另一个量级的工程，短期内做不稳 |

paper.js 的取舍：
- `paper-core`（688 KB 源码 / 311 KB 压缩）去掉 DOM 与 canvas 依赖，Node 里用
  `paper.setup(new paper.Size(1, 1))` 建一个无画布作用域即可做几何运算；
- 它的布尔运算直接在贝塞尔段上做：实测**两个半径 40、圆心距 40 的圆合并** →
  8 段三次贝塞尔，面积 8089.71（解析解 8087.70，误差 0.02%）；
- 代价：浏览器主包增加约 311 KB（未压缩）。若要瘦身，可改成动态 `import()`
  懒加载，但那样首帧会有一瞬间的近似结果——**取舍写在明面上，不假装没有**。

### 10.3 转换规则

我们的路径模型（`M` / `L` / `C` / `Q` / `Z`）与 paper 的段模型不是一一对应：

- **我们的 `C` → paper 的 `cubicCurveTo`**：注意 paper 的 `curveTo` 是「穿过某点」的
  二次曲线，三次贝塞尔必须用 `cubicCurveTo`（用错会直接抛错）。
- **paper 的段是同一个类**：所有段都带 `point` 与**相对的** `handleIn` / `handleOut`，
  一段曲线由「前一段的 handleOut」+「后一段的 handleIn」共同定义，两个把手都是零就是直线。
- **闭合路径按环形遍历**：最后一段要绕回第一段，转换时不能漏。

### 10.4 输入侧

引擎吃的是**绝对坐标的路径命令**，不是多边形：

- 矩形 → 四条直线；
- 椭圆 → **四段三次贝塞尔**（不再用 32 段折线近似）；
- 矢量 → 它的路径（保留曲线）；
- 嵌套布尔组 → 递归算出来的结果路径。

### 10.5 测试

`studio-application/test/boolean-engine.test.ts`（4 条）：

- 引擎可安装 / 可卸载；
- 两圆合并：结果含贝塞尔段，采样面积与解析解误差 < 1%；
- 没装引擎时结果退回折线（回归保护）；
- 圆减矩形：结果保留圆弧，挖掉的面积确实不在里面。