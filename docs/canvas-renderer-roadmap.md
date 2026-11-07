# Canvas 渲染器演进计划

状态：进行中（0.7.0 → 0.9.0）
最后更新：2026-11-07

## 背景

画布已经从「每个节点一个 DOM 元素」切换为 **Canvas 2D 场景渲染器**：

- `packages/studio-web/src/renderer/scene.ts`：把文档 + 布局盒压成纯数据的 `SceneNode` 树；
- `packages/studio-web/src/renderer/canvas-renderer.ts`：Canvas 2D 绘制（`zoom × dpr` 分辨率、圆角、裁剪、文本换行、图片 fit）；
- `packages/studio-web/src/renderer/canvas-surface.tsx`：React 挂载、图片按需加载、随文档/缩放重绘；
- 交互层已默认交给 Canvas（命中、选择框、拖拽/缩放、框选、文本编辑），DOM 节点副本默认不渲染；
- 逃生开关：`?selection=dom`（旧 DOM 交互层）/ `?renderer=dom`（旧 DOM 绘制）。

这是 tldraw / Excalidraw 的分层：**形状描述是纯函数，绘制与交互各自实现**。默认启用，但还有三个明确缺口。

## 缺口与目标

| 缺口 | 现状 | 目标 |
| --- | --- | --- |
| 像素级验证 | ✅ 已完成（Phase A）：独立 harness + Chrome 截图 + PNG diff | — |
| 绘制性能 | ✅ 已完成（Phase B）：根节点级视口裁剪 + 绘制基线 + 预算门禁；浏览器光栅化耗时待测 | — |
| 命中测试 | 🟡 Phase C 接近完成：`hitTest`、双跑对比、选择框、拖拽/缩放、框选、吸附、Canvas 单击/双击编辑；**已设为默认**（DOM 副本不再渲染） | 删除旧交互层与 Moveable/Selecto 依赖 |

## Phase A：画布像素回归（✅ 已完成）

### 目标

在**不启动后端**的前提下，把渲染器的输出变成可截图、可比对的产物，防止字体、描边、圆角、图片位置这类回归。

### 设计

1. **独立 fixture harness**（`packages/studio-web/harness/`）：
   - `harness/fixture.ts`：用 `createDocument` 构造一份覆盖全部绘制分支的文档——文本（换行/对齐/字重）、圆角、描边、透明度、嵌套裁剪、图片（cover/contain/缺图）、隐藏节点、实例覆盖后的文本；
   - `harness/main.ts`：调用 `buildScene` + `createCanvas2DRenderer` 把 fixture 画到 960×680 的 canvas 上，并把文档中每个节点的 id 写到 `data-node-id` 列表（便于断言）；
   - `harness/index.html`：只引用打包后的单文件 JS。
2. **打包**：用 esbuild（Vite 的既有依赖）把 `harness/main.ts` 打成 IIFE 单文件，内联进 HTML，`file://` 直接可加载，不依赖 dev server。
3. **截图与对比**：复用 `packages/design-export/visual/` 的 PNG 编解码、diff、Chrome headless 截图逻辑：
   - `npm run visual:canvas:baseline` 生成 `pages/design-export/test/golden/canvas.png` 类似的基线（放在 `packages/studio-web/visual/canvas.png`）；
   - `npm run visual:canvas:check` 重新截图并比较，默认阈值 0.5%，差异图落盘。
4. **DOM 对照**：同一 fixture 另有一份 DOM 渲染页（复用现有 `.node` 结构与样式），用于人工并排确认；像素对比只针对 Canvas 基线（DOM 版本跨机器字体差异更大，不作为门禁）。

### 验收结果

- `npm run visual:canvas:baseline` 生成 `packages/studio-web/visual/canvas.png`；
- `npm run visual:canvas:check` 连续两次都是 `0/652800（0.000%）`，最大通道差 0；
- fixture 覆盖文本换行/对齐/字重、圆角、描边、椭圆、嵌套裁剪、透明度、隐藏节点、
  图片 cover、缺图占位；
- 没有 Chrome/Edge 时跳过并提示，`--require-browser` 时明确失败；
- `npm run check:visual` 把导出基线与画布基线一起跑。

## Phase B：视口裁剪 + 绘制耗时（✅ 基本完成）

### 设计

1. `computeVisibleBoxes`：根据滚动容器尺寸、缩放、滚动偏移算出视口矩形，先按**根节点包围盒**过滤（O(根节点数)），命中的根节点再整棵绘制；
   - 保守策略：与视口相交即绘制，不做逐子节点裁剪，避免半截文本；
   - 保留一个 `cull: false` 选项用于截图基线（保证基线不受滚动位置影响）。
2. 绘制耗时基线（`packages/studio-web/bench/paint-bench.ts`）：合成文档 200/1000/5000 节点，测 `paint` 耗时（Node 环境用假上下文，浏览器环境用 harness 页面的 `performance.now()` 并在控制台输出 JSON，由 Chrome `--dump-dom` 之外的 CDP 读取——若 CDP 成本高，先只做 Node 假上下文基线 + harness 页面自报数字）。
3. 把绘制耗时纳入 `npm run check:budgets`，预算按数量级设置。

### 验收结果

- `packages/studio-web/src/renderer/culling.ts`：只裁根节点，视口外扩 64px 防止边缘闪烁；
  子节点永远保留，避免阴影/半截文本消失；
- 工作台按滚动 + 缩放计算场景坐标的可视区域并传给 `CanvasSurface`；
- `npm run bench:paint`：200/1000/5000 节点的绘制耗时与绘制调用数；
  1280×800 视口下 5000 节点只画 139 个根节点（约 259 次绘制调用）；
- `check:budgets` 已包含 Node 假上下文的绘制预算，超预算非零退出；
- 浏览器内真实绘制耗时：harness 在 Chrome 里测完写进 `#harness-metrics`，脚本用
  `--dump-dom` 读回（`npm run visual:canvas:paint`）。实测 200/1000/5000 节点：完整场景
  0.9 / 3.5 / 12.3 ms，裁剪后 0.7 / 0.7 / 0.3 ms（132 个根节点），已纳入 `check:visual`。

仍未完成：更激进的子节点级裁剪、GPU/合成层级别的耗时分析。

## Phase C：命中测试迁移（🟡 进行中）

### 设计

1. `hitTest(scene, point)`：逆序遍历 `SceneNode` 树，先判子后判父，跳过 `locked` / 不可见节点，命中返回节点 id；
2. 选择框与手柄：用 Canvas 或独立 overlay 绘制选中态，不再依赖 Moveable/Selecto；
3. 文本编辑：保留 DOM `<textarea>` 覆盖在节点位置（tldraw 同样做法），编辑结束再提交；
4. 移除透明 DOM 节点副本与 `canvas-rendered` 的 CSS 隐藏规则，减少 DOM 节点数。

### 已完成（2026-11-07）

- `renderer/hit-test.ts`：最深命中 + 由深到外的命中栈；处理透明度、容器裁剪与椭圆精确命中；
- `renderer/hit-test-compare.ts`：`compareHits` 与 `pointFromEvent`（把指针坐标经 `zoom` 换算成场景坐标）；
- 工作台开关 `?hittest=compare`：Canvas 命中与 DOM `closest("[data-node-id]")` 同时跑，不一致只
  `console.warn`，不改变选择行为；
- 单元测试覆盖重叠顺序、父子优先级、透明穿透、椭圆角落、裁剪容器与坐标换算。
- 选择框几何与绘制：`renderer/selection.ts`（包围盒合并、8 个手柄、手柄命中、拖拽后的
  盒子、光标映射）+ `renderer/selection-overlay.ts`（Canvas 绘制轮廓与手柄，手柄按
  `zoom` 保持屏幕像素大小）；harness 基线里已叠加双选选择框，像素基线同时覆盖它；
- 选择框绘制：默认由 Canvas 画选中框与手柄（旧路径 `?selection=dom` 下仍由 Moveable 画）；
- 拖拽/缩放接管：`renderer/selection-drag.ts`（子树偏移、单节点缩放、预览覆盖、布局补丁）
  与 `renderer/use-canvas-drag.ts`（捕获阶段指针手势、`stopPropagation` 防止旧交互层
  同时启动、`consumedClick` 抑制拖拽后的误清除选择）。默认路径下拖动已选节点或拖手柄
  由 Canvas 接管，提交仍走现有 `node.patch` 事务。
- 框选：`renderer/marquee.ts`（拖拽矩形归一化、与顶层节点求交）+ Canvas 半透明框选绘制；
  默认路径下空白处拖动即开始框选，松手后直接设置选中集合。
- 对齐吸附：`renderer/snapping.ts`（左/中/右、上/中/下对齐线，阈值内取最近，输出位移与
  辅助线）+ `paintSnapGuides`；拖动时的位移会叠加吸附修正，辅助线随拖动绘制，松手后
  按吸附后的位置提交。像素基线里也画了两条固定辅助线，覆盖该绘制路径；
- **默认路径（不带开关）**：DOM 节点副本**完全不渲染**，单击选中、双击文本编辑与右键菜单
  全部走 Canvas 命中：
  - 单击/Shift 单击由 `hitTest` 决定，空白处清空选择；
  - 双击文本节点在它的布局盒上盖一个 `<textarea>`（输入法/选择交给浏览器），提交仍走
    `text.patch`；
  - 右键菜单在 DOM 命中为空时回退到 `hitTest`；
  - 文本覆盖层会阻止拖动手势，避免在输入框里拖动节点；
  - DOM 节点副本在默认路径下**完全不渲染**（`{legacyDomSelection && page.childIds.map(...)}`），
    画布上只有一个 `<canvas>` 和按需出现的文本编辑框；
  - 可访问性层：`renderer/a11y-tree.ts`（按图层顺序生成带层级的扁平列表）+ 
    `renderer/a11y-layer.tsx`（视觉隐藏的 `listbox`，上下箭头/Home/End 移动并同步选中，
    Delete 删除，`aria-selected`/`aria-level`/`aria-disabled` 齐全），保证纯 Canvas 画布
    仍然能用键盘和屏幕阅读器操作。
- 默认路径**不挂载** `CanvasInteractionLayer`：Moveable/Selecto 整个跳过，
  选择框、拖拽、缩放、框选全部由 Canvas 接管。
- 逃生开关 `?selection=dom`（或 `?renderer=dom`）保留旧的 DOM 交互层与 DOM 绘制，
  用于对照排查；两者同时给上就是完整的旧路径。

### 浏览器实跑验证（2026-11-07）

在真实浏览器里跑完双跑对比与整套画布手势，结论：

- `?hittest=compare`：点击画布节点，Canvas 命中与 DOM 命中**结果一致，控制台零
  `[hittest] canvas/DOM mismatch` 告警**——没有系统性偏差；
- `?selection=canvas`（当时的开关模式，现已并入默认路径）：
  - 单击选中正确节点，隐藏的可访问性 listbox 同步 `aria-selected`；
  - 拖拽由 Canvas 接管，预览框与手柄跟手，松手提交事务（r74 → r75）；
  - 空白处拖动框选，命中 8 个顶层节点（刚拖走的那一个不在框内）；
  - 双击文本节点弹出 `<textarea>` 覆盖层，落在布局盒上并继承字体样式；
  - 右键菜单在 DOM 命中为空时回退到 Canvas 命中，菜单正常打开。

顺带修掉一个会让整个工作台打不开的缺陷：`useCanvasDrag` 原本挂在
`if (!project || !document) return ...` 之后，加载态渲染的 hook 数量比加载后少，
React 直接抛「渲染了比上次更多的 hook」并让整棵 App 崩溃。hook 已挪到提前
return 之前。

### 默认路径实跑验证（2026-11-07）

把 Canvas 交互切成默认后，在不带任何开关的地址上实测：

- 画布容器的 class 是 `canvas-rendered canvas-pointer`；
- **没有** `[data-node-id]` DOM 副本、**没有** `.moveable-control` / `.selecto-selection`
  ——旧交互层确实没有挂载；
- 隐藏的可访问性 listbox 正常挂载，9 个节点的顺序与类型正确；
- 选中椭圆后拖拽 → `onPointerUp` 触发提交 → revision **r77 → r78**，命令确实落库。

又发现并修掉一个真实缺陷：`useCanvasDrag` 的 `consumedRef` 原先在**手势建立后**才置位，
于是拖完一次之后它一直是 `true`，把**下一次**正常点击也一起吞掉——拖完再点别的节点会
完全没反应。现在 `movedRef` / `consumedRef` 的重置挪到每次 pointerdown 的早退之后，
`consumed` 只抑制拖拽结束后浏览器补发的那一次 click。

### 剩余工作

1. 让 Canvas 选择层成为默认并删除 Moveable/Selecto 依赖：默认切换**已完成**（默认路径不再挂载
   `CanvasInteractionLayer`、DOM 副本默认不渲染），Moveable/Selecto 依赖与旧交互层代码待删；
2. 删掉旧交互层代码：`CanvasInteractionLayer`、`CanvasNode` 与 `react-moveable` /
   `react-selecto` 依赖；删 `CanvasNode` 会同时废掉 `?renderer=dom` 绘制回退，届时
   `?selection=dom` 逃生开关只保留 DOM 交互层、画布仍走 Canvas 绘制。

### 风险与回退

- 这是最大的一步：选择、拖拽、右键菜单、双击编辑都依赖现有 DOM 结构；
- 分阶段：先让 `hitTest` 与 DOM 结果在测试里一致（双跑对比），再切换；
- 保留 `?renderer=dom` 直到 Phase C 完成。

## 测试策略

| 层 | 方式 |
| --- | --- |
| 场景数据 | Node 单测：`buildScene` 的字段、顺序、裁剪、token、图片 fit |
| 绘制调用 | Node 单测：假 2D 上下文断言 fill/clip/drawImage/fillText 及参数 |
| 像素 | Chrome headless 截图 + PNG diff（Phase A） |
| 性能 | 假上下文 + 浏览器自报，纳入预算（Phase B） |
| 命中 | 纯函数单测 + 与 DOM 结果对比（Phase C） |

## 不做的事

- 不引入 WebGL：当前瓶颈是节点数与绘制次数，不是 GPU 填充率；Canvas 2D 已经比 DOM 快一个量级
- 不引入第三方渲染库（tldraw/excalidraw 只作为架构参考，不复制代码）
- 不追求跨浏览器像素一致：基线绑定本机字体，跨机器需 `--update`
