# 外观表达能力（P6）设计

> 文档状态：生效中的 P6 规格（P6.1 阴影与模糊实现中；P6.2 渐变与 schema v3 迁移待启动）
> 最后更新：2026-11-08
> 对标：Figma 的 Fill / Effect（Drop shadow、Layer blur）
> 前置：`editor-tooling-roadmap.md` 的 P1–P5

## 1. 为什么拆成两步

P6 里混着两类完全不同风险的工作：

| 子项 | 数据影响 | 风险 |
| --- | --- | --- |
| 阴影、模糊 | **纯新增可选字段**，旧文档自动合法 | 低：不动既有语义 |
| 渐变 | `fill: string` → `fills: Paint[]`，**破坏性变更**，要升 `CURRENT_SCHEMA_VERSION`、登记迁移步骤、改所有读取点 | 高：迁移、导出基线、AI 提示词、对比度检查都会受影响 |

先做低风险的增量，再做需要迁移的那部分——这样「迁移出错」不会和「新特效渲染不对」混在一起排查。

## 2. P6.1 阴影与模糊

### 2.1 模型

```ts
export interface ShadowSpec {
  x: number;      // 偏移，px
  y: number;
  blur: number;   // 模糊半径，px，>= 0
  color: string;  // CSS 颜色
}

export interface AppearanceSpec {
  // …
  shadow?: ShadowSpec;
  /** 图层模糊半径（px）；0 表示不模糊。 */
  blur?: number;
}
```

**不加 `spread`**：Canvas 的 shadow 没有扩散半径，HTML 的 `box-shadow` 有，SVG 要用
`feMorphology` 才能凑出来。三套实现不一致的字段不如先不给——等做完整滤镜链时再加。

### 2.2 各链路

| 链路 | 做法 |
| --- | --- |
| Canvas | `shadowColor/shadowBlur/shadowOffsetX/Y` 包在 `save/restore` 里；模糊用 `ctx.filter = blur(Npx)`（现代浏览器支持） |
| SVG | `<filter>` + `<feDropShadow>`（`stdDeviation = blur/2`），模糊用 `<feGaussianBlur>`；两者用一个 filter 链起来 |
| HTML | `box-shadow: x y blur color`；模糊用 `filter: blur(Npx)` |
| PNG | 走 SVG 光栅化，自动继承 |

`feDropShadow` 的 `stdDeviation` 与 CSS/Canvas 的 `blur` 不是同一量纲：CSS 的模糊半径约等于
`2 × stdDeviation`，所以导出时除以 2。这个换算写在代码注释里，避免以后有人「修」回去。

### 2.3 作用对象

阴影与模糊都作用于**节点自身的绘制**（形状、文本、图片都算），子节点不继承——和 Figma 的
图层效果一致。真正的「子树整体模糊」需要离屏合成（先画到 offscreen canvas 再带滤镜贴回），
属于非目标；当前实现里每个节点绘制前都会把 shadow/filter 重置，所以不会有意外继承。

### 2.4 验收

- 画布、SVG、HTML 三处的阴影偏移与模糊程度肉眼一致；
- 阴影不随缩放变化（场景单位，不是屏幕单位）；
- 属性面板可增删阴影、调模糊，一条 `node.patch`，可撤销；
- 支持矩阵新增 `effects` 行（HTML/SVG 均 exact，PNG rasterized）。

## 3. P6.2 渐变与 schema v3 迁移

### 3.1 目标模型

```ts
export type Paint =
  | { type: "solid"; color: string }
  | { type: "linear"; angle: number; stops: PaintStop[] };

export interface PaintStop { offset: number; color: string }  // offset ∈ [0,1]

export interface AppearanceSpec {
  fills?: Paint[];   // 取代 fill?: string
  // …
}
```

多填充层（Figma 支持）先不做，`fills` 数组只放一层；数组形态是为了以后加层不改模型。

### 3.2 迁移方案（v2 → v3）

1. `CURRENT_SCHEMA_VERSION` 升到 3，`MIGRATIONS` 登记 `v2 → v3`；
2. 迁移步骤：对每个节点，若 `appearance.fill` 存在且 `fills` 为空，写入
   `fills: [{ type: "solid", color: fill }]`，删除 `fill`；
3. `designDocumentSchema.schemaVersion` 的字面量改成 3；
4. 所有读取点改为「取最高优先级的 fill」：`resolveFill(document, node)` 成为唯一入口
   （和 `resolveStroke` / `resolveRadius` 并列），画布、HTML、SVG、对比度检查共用；
5. 旧文档在仓库读取路径上已经会走 `migrateDocument()`，导入 JSON 同理，所以不需要额外的
   兼容分支——迁移是**单向**的，文档一旦升到 v3 就不会回退。

### 3.3 导出

- HTML：`background: linear-gradient(<angle>deg, <stops>)`；
- SVG：`<defs><linearGradient>` + `fill="url(#paint-N)"`；
- 渐变角度约定与 CSS 一致（0deg 指向上，顺时针），避免两套角度换算。

### 3.4 风险与顺序

迁移会动到导出基线（golden）、AI 提示词里的节点摘要、对比度检查。所以顺序是：

1. 先抽 `resolveFill()` 并让所有读取点走它（此时 `fill` 仍在，行为不变）；
2. 再升版本、写迁移、改 schema；
3. 最后接导出与 UI。

## 4. 非目标

- 多填充层、渐变网格、遮罩填充；
- 渐变网格、渐变文字的 HTML 精确实现（CSS `background-clip:text` 会破坏选中与可访问性）；
- 阴影与模糊之外的其它效果。

> 2026-11-11 更新：内阴影、阴影 `spread` 与**子树整体模糊**已实现（见 §7），
> 本节原先列的「内阴影」「阴影的 spread」不再是限制。

## 5. P6.1 实现结果（2026-11-08）

- **模型**：`AppearanceSpec.shadow?: { x, y, blur, color }` 与 `blur?: number`，都是可选字段，
  旧文档不需要迁移。zod：`blur` 非负、`color` 非空、`x/y` 有限。
- **画布**：每个节点绘制前先把 shadow 与 `filter` 重置（避免父节点效果被子节点继承），
  再按自身字段设置；`filter` 用 `"filter" in context` 探测，老浏览器没有这个属性就跳过模糊。
- **SVG**：`<filter>` 里按需拼 `feGaussianBlur` / `feDropShadow`，`stdDeviation = 模糊半径 / 2`；
  滤镜区域放大到 200%（`x/y=-50%`、`width/height=200%`），否则偏移出去的阴影会被裁掉。
- **HTML**：`box-shadow: x y blur color`、`filter: blur(Npx)`；颜色仍过 `safeCssValue`。
- **支持矩阵**：新增 `effects` 行（HTML/SVG exact、PNG rasterized）。
- **属性面板**：外观区「添加投影 / 移除投影」，展开后是 X / Y / 模糊 / 颜色四个字段，
  外加「图层模糊」一个数字框。
- **测试**：画布渲染 3 条（阴影参数、子节点不继承、模糊 filter）、SVG 1 条、HTML 1 条；
  `studio-web` 375 条、`design-export` 58 条通过。

非目标（写在 §4）：`spread`、内阴影、子树整体模糊、背景模糊。
（2026-11-11：`spread`、内阴影与子树整体模糊已实现，见 §7；背景模糊仍是非目标。）
## 6. P6.2 实现结果（2026-11-08）

- **模型**：`Paint = { solid } | { linear, angle, stops }`；`AppearanceSpec.fills?: Paint[]`
  取代 `fill?: string`。色标 `offset` 限定在 [0,1]，线性渐变至少两个色标。
- **迁移**：`CURRENT_SCHEMA_VERSION` 升到 3，`MIGRATIONS` 登记 `v2 → v3`：把每个节点的
  `appearance.fill` 改写成 `fills: [{ type: "solid", color }]` 并删掉 `fill`；没有 fill 的
  节点原样返回（不凭空造空数组，避免把「无填充」和「空填充层」混掉）。
- **读取收敛**：`resolveFills()` 是唯一入口——颜色 token 绑定生效时整组填充压成单一实色
  （一个颜色 token 表达不了渐变）。`primaryFillColor()` 给只接受单色的地方用（文本颜色、
  对比度检查、批量面板、实例面板）。它在 `design-schema/src/tokens.ts`，不在 `paint.ts`
  （`paint.ts` 只有渐变几何函数）。
- **画布**：`gradientLine()`（design-schema）算出渐变线，`createLinearGradient` + 按
  offset 排序后 `addColorStop`。
- **导出**：HTML 输出 `linear-gradient(θdeg, color offset%, …)`；SVG 输出
  `<linearGradient gradientUnits="userSpaceOnUse">` + `fill="url(#paint-N)"`；矢量节点的
  内联 `<svg>` 也生成同一条 gradient（CSS 渐变函数不能直接用在 SVG 路径上）。
- **UI**：属性面板「填充」变成填充层编辑器——纯色时可「改为线性渐变」，渐变时可调角度
  与起止色、并能「改回纯色」。
- **测试**：`gradientLine` 1 条、paint 校验 1 条、v2→v3 迁移 1 条、画布渐变 1 条、
  导出 2 条；`design-schema` 55、`design-export` 60、`design-runtime` 59、
  `studio-application` 52、`ai-orchestrator` 50、`studio-web` 375 全部通过。

一个刻意的取舍：**多填充层还没做**。`fills` 已经是数组，但 UI 与渲染只取第 0 层——
等真正需要「底色 + 渐变叠加」时再加层，模型不需要再改。
## 7. 多填充层（2026-11-08）

`fills` 从一开始就是数组，之前 UI 与渲染只取第 0 层。现在三层都按顺序叠放：

| 链路 | 做法 |
| --- | --- |
| 画布 | 逐层 `fillStyle` + `fill()`，数组顺序即叠放顺序（第 0 层在最底下）。**阴影只投一次**：每层各投一次会让影子叠得更黑，所以第一层填完就清掉 shadow |
| HTML | 最底层实色用 `background-color`（CSS 只允许一个）；其余层进 `background-image`，且**倒序**——CSS 的 background-image 列表是「第一个在最上面」 |
| SVG | 同一形状输出 N 份（`<rect>`/`<ellipse>`/`<path>`），各自带 `fill`；样式里的 `fill` 置空避免多铺一层。**描边只画一次**，不重复 N 遍 |
| 面板 | 「外观」区顶部是填充层按钮：数字切换当前编辑层，`＋` 添加、`－` 移除；下面的编辑器（实色/渐变、角度、色标）只作用于当前层 |

单层填充的输出**逐字未变**（`background:#xxx`、样式里的 `fill:`），所以 golden 不需要更新——
这也顺带证明多层支持没有破坏已有产物。

已知限制：文本节点只按第一层填充上色（多色文字需要 `background-clip:text` 之类的手段，
不在这一轮范围内）。
## 8. 径向渐变（2026-11-08）

`Paint` 增加第三种：`{ type: "radial", cx, cy, r, stops }`。

- **语义**：`cx`/`cy` 是相对盒子的归一化中心（0–1，允许越界——中心落在盒子外是有效设计）；
  `r` 是半径占**盒子长边**的比例。半径用长边而不是短边/对角线，是为了「r = 0.5 刚好盖住
  正方形盒子」这个直觉成立。
- **几何**：`radialGeometry()` 把归一化值换算成场景坐标里的圆（中心 + 半径），
  画布 `createRadialGradient(cx, cy, 0, cx, cy, r)`、SVG `<radialGradient>`、
  HTML `radial-gradient(circle …px at X% Y%)` 三处共用。
- **HTML 用 px 半径**：CSS 的 `circle` 不接受百分比尺寸。代价是节点被拉伸时半径不跟着缩放，
  导出产物里通常无所谓；画布与 SVG 是精确的。
- **面板**：实色层现在有两个入口（改为线性渐变 / 改为径向渐变）；径向层可调中心 X/Y 与
  半径（都用百分比显示），起始色/结束色沿用同一套色标编辑。
- **不做**椭圆渐变（`ellipse` 形式的径向渐变）：三处渲染的语义差异比收益大，需要时再加。

> 2026-11-11 更新：椭圆渐变、混合模式与背景模糊已实现，见 §9。

## 9. 阴影 spread、内阴影、子树模糊与文本上色（2026-11-11）

### 9.1 阴影 `spread`

`ShadowSpec` 增加可选 `spread?: number`（px），语义对齐 CSS `box-shadow` 第 4 值。

Canvas 的 `shadow*` **没有扩散半径**，所以走离屏合成：形状先沿轮廓向外膨胀（描一条
`2×spread` 宽的圆角边，与 CSS 的几何膨胀等价；负 spread 用 `destination-out` 向内收缩），
再整张模糊，最后按偏移贴回内容下面。离屏层用**设备像素**坐标，模糊半径不随缩放漂移。

- **HTML**：`box-shadow: x y blur spread color`；
- **SVG**：`feMorphology(dilate)` → `feGaussianBlur` → `feOffset` → `feFlood` → `feComposite(in)` → `feMerge`；
- **普通投影仍走 `shadow*` 快速路径**（`needsManualShadow()` 只在有 spread 或 inner 时才转离屏），
  旧渲染逐字不变。

### 9.2 内阴影

`ShadowSpec` 增加可选 `type?: "drop" | "inner"`（缺省 `drop`）。语义与 CSS `box-shadow: inset`
一致：颜色在形状**内部**、从边缘向内，偏移方向与投影相反。

- **HTML**：`box-shadow: inset …`；
- **SVG**：`feComposite(SourceAlpha, 模糊偏移后的自己, out)`；
- **Canvas**：离屏合成——铺满阴影色，再挖掉「模糊并偏移后的自己」，剩下的即内阴影。
  正 spread 时挖掉的是**收缩**后的形状（CSS 的内阴影扩散是向内收的）。

### 9.3 子树整体模糊（修掉三端语义不一致）

原先**画布只模糊节点自身，SVG/HTML 却模糊整棵子树**——同一份文档在不同出口看到的画面不一样。
现在统一为**模糊整棵子树**（对齐 Figma 的图层模糊）：画布改为「整棵子树画进离屏 → 模糊 → 贴回」，
复用混合模式那套离屏机制（`drawLayerGroup`）。`backgroundBlur`（背景模糊）语义未动。

### 9.4 文本多层填充上色（修掉两个真缺陷）

原先：① SVG 在 ≥2 层填充时写 `fill:none`，**文字完全不可见**；② HTML 导出**根本没有输出
`color:`**，文字颜色靠浏览器默认色/继承，与画布不一致。

现在规则集中在 `design-schema/src/tokens.ts` 的 `textFillColor()`，画布 / HTML / SVG /
对比度检查**共用这一份**：

- 单层填充 → 用该层的颜色（渐变取第一个色标）；
- 多层填充 → 只按第一层上色（后面的层是形状装饰，不参与文字颜色）；
- 完全没有填充 → 用 `TEXT_DEFAULT_COLOR`（`#111111`，画布原本的兜底值）。

多层与渐变在支持矩阵标 `approximated` 并出诊断（`text-fill-multi` / `text-fill-gradient`）。
SVG 的单层渐变文字仍是**精确**的（真渐变填充）；HTML 与画布按首个色标近似。

### 9.5 已知限制

- 渐变文字在 HTML/画布只能按首个色标近似（CSS `background-clip:text` 会破坏选中与可访问性）。
- 阴影与模糊的**层序**仍有细微差异：SVG 是「先模糊再投影」（投影不被模糊），HTML 是 CSS 滤镜
  （投影被一起模糊），画布随 HTML。
