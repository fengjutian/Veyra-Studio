# 旋转与约束（P5）设计

> 文档状态：生效中的 P5 规格（旋转与约束均已实现）
> 最后更新：2026-11-08
> 对标：Figma 的旋转（Rotate）与约束（Constraints）
> 前置：`editor-tooling-roadmap.md` 的 P2–P4

## 1. 为什么旋转比看上去贵

旋转不是「给节点加一个 `transform`」这么简单。它是**坐标系的变化**，而编辑器里几乎所有
几何计算都假定坐标轴是正交的：

| 受影响的地方 | 现在的假设 | 旋转后 |
| --- | --- | --- |
| 命中测试 | 点直接和轴对齐盒子比较 | 要先把点逆变换回节点本地坐标 |
| 选择框 | 轴对齐矩形 + 8 个手柄 | 手柄要跟着转，`nw` 手柄不再在左上角 |
| 缩放手柄 | `resizeRect` 只处理水平/垂直增量 | 增量要按旋转角分解到本地轴 |
| 导出 | `left/top/width/height` | 要加 `transform: rotate()` / `transform="rotate()"` |
| 包围盒 | 盒子本身就是包围盒 | 旋转后的 AABB 比盒子大（多选时要用） |

所以这一相位先只做**单节点的旋转**：不旋转多选整体、不旋转 Frame 的布局轴，
把「一个形状绕自己中心转」这条链路做对。

## 2. 数据模型

```ts
export interface LayoutSpec {
  // …原有字段…
  /** 旋转角（角度制，顺时针为正，绕节点自身中心）。可选，缺省 0。 */
  rotation?: number;
}
```

三个决定：

1. **角度制、顺时针为正**：和 CSS `rotate()`、SVG `rotate()` 一致，导出时不需要换算；
   内部计算统一 `-Math.PI / 180 * deg`（画布 y 轴向下，顺时针即正向）。
2. **只存角度，不存矩阵**：存矩阵要么每次分解回角度（精度漂移），要么禁用非等比缩放；
   角度 + 布局盒已经能完整表达我们的变换。
3. **旋转不参与布局**：布局引擎仍然按轴对齐盒子排版，旋转只影响**绘制与命中**。
   这样它和自动布局、约束、导出的几何计算都解耦——代价是旋转后的节点在自动布局里
   仍然占原来的格子（Figma 也是这样）。

## 3. 几何

全部集中在 `studio-web/src/renderer/rotation.ts`，纯函数、可单测：

- `rotatePoint(point, origin, radians)`；
- `rotatedCorners(box, radians)`：四个角，用于选择框轮廓与 AABB；
- `hitTestHandleRotated(box, radians, point, tolerance)`：先把点逆变换到本地，再复用
  现有的 `hitTestHandle`——手柄的命中判定和缩放算法都不需要重写；
- `resizeRotatedBox(previous, next, handle, radians)`：**保持对角不动**。做法是先把
  resize 的结果按新盒子中心旋转，算出对角现在的世界坐标，再整体平移回原来那个点。
  没有这一步，旋转过的节点一拉手柄就会「漂移」；
- `rotatedBounds(box, radians)`：旋转角的 AABB，多选包围盒与「适应内容」用它。

## 4. 各链路怎么接

| 链路 | 做法 |
| --- | --- |
| 画布 | `translate(center) → rotate(θ) → translate(-center)`，子树继承父变换（画在同一个上下文里） |
| 命中 | 每层把点逆变换到该节点本地坐标，再递归子节点——子节点本来就活在父的本地空间 |
| 选择框 | 单选中且 `rotation ≠ 0` 时画旋转后的轮廓，手柄画在旋转后的位置 |
| 缩放 | 点逆变换到本地 → 复用 `resizeRect` → `resizeRotatedBox` 保持对角不动 |
| HTML | `transform: rotate(θdeg)`，`transform-origin: center` |
| SVG | `transform="rotate(θ cx cy)"` |
| 属性面板 | 布局区加「旋转」输入，`-180…180`，0 表示不写字段 |

## 5. 非目标（P5.1）

- ~~多选整体旋转（组变换需要新的「组坐标系」概念）~~ —— **已实现**（2026-11-11，见 §13）；
- 旋转后的**自动布局**重排（旋转不参与布局，这一点与 Figma 一致）—— 旋转**不参与**布局这一点
  仍然成立，但已加**如实提示**（见 §13.3）；
- 约束（P5.2）：父容器尺寸变化时子节点如何贴边，和旋转是两套机制。

## 6. 验收

- 一个矩形旋转 30° 后：画面、命中、SVG/HTML 导出三者一致；
- 点击旋转后露出来的「角外区域」不会命中该节点；点击被转走的原角落也不会命中；
- 拉 `se` 手柄时对角保持不动（视觉上不漂移）；
- 多选包围盒包含旋转后的外接矩形；
- 属性面板改角度立即生效，一条 `node.patch`，可撤销。

## 7. P5.2 约束（待启动，概要）

- `constraints?: { horizontal: "start" | "end" | "center" | "stretch" | "scale"; vertical: … }`
  只在**父容器尺寸变化**时生效；
- 触发点：父 Frame 的宽高被改动（属性面板/手柄），子节点按约束重新定位；
- 难点不在模型而在「一次 resize = 一条事务」：父与子的变更必须落在同一个事务里，
  否则撤销会把父子拆开。

## 8. P5.1 实现结果（2026-11-08）

- **模型**：`LayoutSpec.rotation?: number`（角度制、顺时针为正、绕节点中心），可选字段，
  旧文档不受影响；`node.patch` 直接改 `layout`，一条命令、可撤销。
- **几何**：`renderer/rotation.ts` 纯函数——`rotatePoint` / `toLocalPoint` / `rotatedCorners` /
  `rotatedBounds` / `rotatedHandleCenters` / `hitTestHandleRotated` / `resizeRotatedBox`。
  手柄命中先把点逆变换回本地，再复用原有的 `hitTestHandle`，判定逻辑没有第二份实现。
- **画布**：`drawNode` 在 `save()` 之后 `translate(center) → rotate → translate(-center)`，
  子树在同一个上下文里绘制，所以自动继承父级旋转。
- **命中**：`pathInNode` 每层把点逆变换到该节点本地坐标再递归；蒙版判定必须放在逆变换
  **之前**（蒙版是兄弟节点，活在上层坐标系里）——这一点写在了注释里。
- **选择框**：单选且旋转时画旋转后的四边形与旋转后的手柄位置；多选用各节点的旋转 AABB
  合并（否则转出去的部分会露出包围盒）。
- **缩放**：起点与当前点都逆变换到本地，按本地增量 `resizeRect`，最后用
  `resizeRotatedBox` 把对角钉回原世界坐标——不修正的话，一拉手柄整个图形会漂移。
- **导出**：SVG 在每个元素的公共属性上加 `transform="rotate(θ cx cy)"`（中心用平移后的
  盒子坐标）；HTML 加 `transform:rotate(θdeg)`，`transform-origin` 用初值（元素中心）。
- **属性面板**：尺寸区加「旋转」输入，0 表示不写字段。
- **测试**：`rotation.test.ts` 7 条、`renderer-rotation.test.ts` 3 条、导出 3 条；
  `studio-web` 372 条、`design-export` 56 条通过。

仍属非目标：多选整体旋转、框外旋转手柄、旋转后的自动布局重排、约束（P5.2）。
## 9. P5.2 约束设计

### 9.1 模型

```ts
export type ConstraintAxis = "start" | "end" | "center" | "stretch" | "scale";
export interface Constraints {
  /** 水平方向：左 / 右 / 居中 / 拉伸 / 缩放。 */
  horizontal: ConstraintAxis;
  /** 垂直方向：上 / 下 / 居中 / 拉伸 / 缩放。 */
  vertical: ConstraintAxis;
}
// BaseNode 上可选：
constraints?: Constraints;
```

缺省不写 = `start`（左/上），与 Figma 的默认一致：**没有约束的节点在父级变大时不动**。

### 9.2 语义（父级尺寸 W0→W1，子节点 x/宽度 w）

| 约束 | 位置 | 尺寸 |
| --- | --- | --- |
| `start` | 不变（贴左/上） | 不变 |
| `end` | `x += Δ`（贴右/下） | 不变 |
| `center` | `x += Δ/2`（相对父级中心不动） | 不变 |
| `stretch` | 不变（左右边距都不变） | `w += Δ` |
| `scale` | `x *= W1/W0` | `w *= W1/W0` |

两个轴独立计算；`Δ = W1 - W0` 为 0 的轴直接跳过。

### 9.3 放在哪一层：运行时，而不是 UI

约束必须在 `node.patch` 里应用，理由是**一致性**：改父级尺寸的入口不止一个——属性面板、
画布手柄缩放、AI 计划、外部 MCP 集成。如果只在 UI 里补子节点，AI 或 MCP 改一次父级尺寸
就会留下「子节点没跟着动」的文档，而且这种不一致会随调用方不同而变化。

放到运行时还有一个好处：父与子的变更天然在**同一条命令**里，撤销一次就整体还原。
所以模型只加字段，命令层只加一段「尺寸变了就重排子节点」的逻辑，不需要新的命令。

约束数学不依赖布局引擎：它只在**存储值**上做算术（父级声明宽高 vs 新宽高），
所以运行时不需要引入 `design-layout`。

### 9.4 生效范围与递归

- 只在父级 `layout.mode === "absolute"` 时生效。stack 容器的子节点由布局引擎排，
  约束在这里没有意义（Figma 同样如此）。
- 子节点自身也必须是 `absolute`；`stretch` 只对固定尺寸（`fixed`）的轴有意义，
  `fill`/`hug` 由布局引擎决定，约束不参与。
- **递归**：子节点因为 `stretch`/`scale` 改变了尺寸，它自己的子节点也要按同一套规则重排，
  用「子节点旧尺寸 → 新尺寸」作为下一层的 W0→W1。
- 父级是 `hug`（随内容撑开）时不应用约束：hug 的尺寸是**结果**不是输入，重排子节点会反过来
  影响父级尺寸，形成回路。

### 9.5 事务与撤销

`node.patch` 在运行时内部把父级 patch 与子节点 patch 合并成**一次**文档变更：
`runtime.execute` 本来就是「一个 envelope = 一次提交 + 一条日志」，所以撤销一次即可回到
改尺寸之前。属性面板、手柄缩放、AI 计划因此自动获得一致行为，不需要各自实现。

### 9.6 UI

属性面板「约束」区，两个 `Segmented`（水平 / 垂直），各 5 个选项。只在**父级是绝对布局的
容器**时显示——在页面根或 stack 容器里显示这组控件只会误导用户。

### 9.7 验收

- 右侧固定的子节点：父级变宽时右边距不变；
- 拉伸：父级变宽时子节点等量变宽；
- 缩放：位置与尺寸按比例变化；
- 居中：相对父级中心不动；
- 父子变更在**一次**撤销内还原；
- stack 父级的子节点不受影响；
- AI/外部集成通过 `node.patch` 改父级尺寸时，行为与手动操作一致（同一段运行时逻辑）。

### 9.8 非目标

- 约束的可视化预览（Figma 拖动手柄时会在画布上画约束线）；
- 组件实例里的约束覆盖（实例的子节点目前继承组件定义里的约束）；
- 文本自动尺寸与约束的联动。
## 10. P5.2 实现结果（2026-11-08）

- **模型**：`Constraints { horizontal, vertical }`（`start/end/center/stretch/scale`）作为
  `BaseNode.constraints?` 可选字段；zod 用枚举校验，旧文档不受影响。
- **逻辑位置**：`design-runtime/src/constraints.ts`，在 `node.patch` 里应用——属性面板、
  画布手柄缩放、AI 计划、外部 MCP 集成**自动共享同一套行为**，不需要各自实现。
  这也是文档 §9.3 里定的：模型只加字段，命令层只加一段「尺寸变了就重排子节点」。
- **事务**：父级 patch 与子节点重排落在同一条命令里，`inverse` 同时包含父子状态，
  撤销一次整体还原（测试里断言了 `inverse.after` 的父与子都回到旧值）。
- **递归**：子节点被 `stretch`/`scale` 改变尺寸后，它自己的子节点按「旧尺寸 → 新尺寸」
  继续重排。
- **不做**：stack 容器的子节点、`hug` 父级的尺寸变化（尺寸是结果不是输入，会形成回路）、
  无约束节点（默认 `start`，父级变大时不动）。
- **UI**：属性面板「约束」区，水平/垂直各 5 个选项；只在**父级是绝对布局容器**时显示。
- **测试**：`constraints.test.ts` 8 条（五种模式、stack/hug 跳过、递归、运行时集成 +
  撤销语义）；`design-runtime` 59 条、`studio-web` 372 条通过。
## 11. 框外旋转手柄（2026-11-08）

P5.1 只做了属性面板输入角度，鼠标转不了图形——这是旋转能力最明显的缺口。补上：

- **位置**：从盒子「顶边中点」沿盒子本地 -y 方向外移 26 屏幕像素，再套上节点旋转。
  所以手柄永远挂在盒子正上方，转多少度都跟着走。
- **命中**：`hitTestRotationHandle()` 用屏幕像素换算到场景单位（`gap / zoom`、`radius / zoom`），
  缩放画布时手感不变；命中判定在缩放手柄**之前**，极小节点上两者重叠时优先旋转。
- **拖动**：只记录「按下时的指针极角」和「起始角度」，移动时用角度差算新角度——
  和手柄挂在哪个位置无关。松手才提交，一次拖动 = 一条 `node.patch`，撤销一次回到拖动前。
- **吸附**：按住 Shift 吸附到 15 度；`normalizeAngle()` 把结果规范到 (-180, 180]，
  避免文档里出现 720 度这种值。
- **预览**：拖动过程中只覆盖绘制副本（`rotationOverride`），不写文档；松开才提交。
- **光标**：指针停在手柄上时画布换成 `grab`（`hoverRotate` → `.canvas.rotate-hover`），
  让「这里可以拖」变得可发现。
- **测试**：`rotation.test.ts` 新增 4 条（手柄位置随旋转、命中、角度规范化与吸附、极角），
  `studio-web` 380 条通过。

已知边界：节点处在**被旋转的父容器**里时，手柄按父容器坐标系计算（视觉上会差一个父级角度）。
多选整体旋转已于 2026-11-11 实现（见 §13）。
## 12. 约束预览（2026-11-08）

拖动父级手柄时，受约束的子节点**实时跟着动**——不是画几条提示线，而是直接按约束移动。
这样预览与松手后的结果完全一致，也顺便让「约束」这个抽象被看见。

### 12.1 为什么能实时

约束数学是纯函数：`constrainLayout(layout, constraints, from, to)`。P5.2 里它是运行时的
私有实现，现在**导出**给画布用：

- 运行时在 `node.patch` 里用它算最终布局；
- 画布在拖动时用它算子节点的预览盒子。

一份公式、两个调用点。各写一份的话，松手那一刻子节点会跳一下——这是最难 debug 的那类 bug。

### 12.2 坐标换算

文档里子节点的 `x/y` 是相对父级的，画布盒子是绝对坐标。所以换算用**增量**：

```
子节点绝对位移 = 父级绝对位移 + (约束后的相对位置 - 原来的相对位置)
```

这样不用关心父级有没有内边距（内边距在拖动中不变，增量里自动抵消）。

### 12.3 递归与边界

- 子节点被 `stretch`/`scale` 改变尺寸时，它自己的子节点继续按「旧尺寸 → 新尺寸」预览。
- stack 父级、没有约束的子节点、尺寸没变的拖动都不产生预览。
- 预览只喂给绘制层（`previewBoxes` 合并），**不参与提交**：提交仍是一条 `node.patch`，
  由运行时重算子节点。拖动期间如果把子节点也提交一遍，约束会被应用两次。

### 12.4 测试

`constraint-preview.test.ts` 6 条：右固定保持右边距、拉伸跟随、父级原点移动时子节点平移、
尺寸不变时不预览、stack 与无约束跳过、子节点被拉伸时孙节点也预览。
`design-runtime` 59、`studio-web` 410 全部通过。

## 13. 多选整体旋转与实例约束覆盖（2026-11-11）

### 13.1 多选整体旋转

多选时旋转手柄绕**选区旋转后包围盒的中心**刚性旋转所有选中节点。

新增纯函数模块 `packages/studio-web/src/renderer/multi-rotate.ts`：

| 函数 | 作用 |
| --- | --- |
| `groupPivot(boxes)` | 组枢轴 = 旋转后包围盒的中心。用**视觉包围盒**而不是轴对齐盒：节点本身已转过 30° 时轴对齐盒会偏，绕它转会让整组轻微漂移 |
| `rotateTargets(targets, pivot, delta)` | 刚性变换：每个节点的中心绕枢轴公转、尺寸不变、角度加同一增量 |
| `planRotation(request)` | 合成一次手势的完整结果（预览用） |
| `rotationRelayoutNotice(...)` | 自动布局父级下的提示文案 |

**吸附规则不同**：单选按**绝对角度**吸附（15° 的整数倍，保持既有单节点手感）；多选按**增量**
吸附——整组必须转同一个角度，否则相对位置会被拉歪，刚性就没了。

其它落点：`use-canvas-drag.ts` 的 rotate 手势由单节点扩展为多节点（一次手势 = 一条事务 =
一次撤销）；`rotation.ts` 新增 `findSceneNode`/`rotatedAabbBoxes`（从 canvas-surface 提取，
两处共用）；`selection-overlay.ts` 新增角度读数（拖动中显示组增量，静止单选显示节点角度）。

### 13.2 顺带修掉的坐标缺陷

旋转提交原来传的是**相对坐标**（`options.layoutOf(id)` 返回存储的 layout），而
`commitCanvasMove` 会把它当绝对坐标**再减一次父级内容盒原点** → 嵌套节点的 x/y 被减两次。
顶层节点因原点为 (0,0) 看不出来，所以这个缺陷一直藏着。

现在旋转与移动/缩放**统一用绝对坐标**，换算收敛到唯一入口 `toParentLocalLayout()`。
回归测试走真实布局引擎 + 运行时：转 30° 后子节点绝对盒仍为 (120, 90)。

### 13.3 旋转后的自动布局重排（只做提示）

布局引擎（`packages/design-layout`）**不参与旋转**——`layout.ts` 全文无 rotation 概念，
stack 里旋转的节点仍占原来的格子。这与 Figma 一致，但用户容易误解，因此加了**如实提示**：
旋转提交后若父级是 stack/grid，状态栏说明「父容器是自动布局（stack/grid）：布局引擎不按旋转
重排兄弟节点（需要 design-layout 支持）」。

**真正让旋转参与布局重排需要改 `design-layout`**，本轮未做。

### 13.4 组件实例内的约束覆盖（studio-web 侧接口）

现状：实例物化时 `constraints` 会被**整节点深拷贝**带过去，所以实例内部节点的约束 = 组件定义里
的约束；改实例副本不影响组件定义（这是正确的）。但**没有任何覆盖机制**——`OverrideField` 只有
`text`/`name`/`visible`/`appearance`，`component.override` 的 payload 同理。

已实现的部分（`packages/studio-web/src/instance-constraint-override.ts`）：

- `findInstanceCopy()`：从副本 id（`instanceId--sourceNodeId`）解析回源节点 id（排除插槽）；
- `collectInstanceConstraintTargets()`：收集可覆盖的实例内部节点；
- `planInstanceConstraintOverride()`：返回补丁形状**与不支持原因**；
- 属性面板新增「实例约束覆盖」分段（水平/垂直 + 状态说明）；运行时未放行时**只把原因说清楚**，
  不发会被拒绝的命令。

**尚未生效**：底层还需要三处放行——`OverrideField` 加 `"constraints"`、`component.override`
payload 加 `constraints` 字段、运行时白名单放行并写入 `instance.overrides[sourceNodeId]`。
`constraints` 已是 `BaseNode` 的可选字段，**文档格式版本不变**。
