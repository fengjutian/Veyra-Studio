# Canvas 渲染器演进计划

状态：进行中（0.7.0 → 0.9.0）
最后更新：2026-11-07

## 背景

画布已经从「每个节点一个 DOM 元素」切换为 **Canvas 2D 场景渲染器**：

- `packages/studio-web/src/renderer/scene.ts`：把文档 + 布局盒压成纯数据的 `SceneNode` 树；
- `packages/studio-web/src/renderer/canvas-renderer.ts`：Canvas 2D 绘制（`zoom × dpr` 分辨率、圆角、裁剪、文本换行、图片 fit）；
- `packages/studio-web/src/renderer/canvas-surface.tsx`：React 挂载、图片按需加载、随文档/缩放重绘；
- DOM 节点保留为交互层（命中测试、Moveable/Selecto、文本编辑），视觉由 CSS 隐藏；
- 回退开关：`?renderer=dom`。

这是 tldraw / Excalidraw 的分层：**形状描述是纯函数，绘制与交互各自实现**。默认启用，但还有三个明确缺口。

## 缺口与目标

| 缺口 | 现状 | 目标 |
| --- | --- | --- |
| 像素级验证 | ✅ 已完成（Phase A）：独立 harness + Chrome 截图 + PNG diff | — |
| 绘制性能 | 整页全量绘制，无裁剪，绘制耗时未纳入预算 | 视口裁剪（culling）+ 绘制耗时基线 + `check:budgets` 门禁 |
| 命中测试 | 依赖透明 DOM 副本，节点上限仍受 DOM 限制 | 自研命中测试与选择手柄，移除 DOM 节点副本 |

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

## Phase B：视口裁剪 + 绘制耗时

### 设计

1. `computeVisibleBoxes`：根据滚动容器尺寸、缩放、滚动偏移算出视口矩形，先按**根节点包围盒**过滤（O(根节点数)），命中的根节点再整棵绘制；
   - 保守策略：与视口相交即绘制，不做逐子节点裁剪，避免半截文本；
   - 保留一个 `cull: false` 选项用于截图基线（保证基线不受滚动位置影响）。
2. 绘制耗时基线（`packages/studio-web/bench/paint-bench.ts`）：合成文档 200/1000/5000 节点，测 `paint` 耗时（Node 环境用假上下文，浏览器环境用 harness 页面的 `performance.now()` 并在控制台输出 JSON，由 Chrome `--dump-dom` 之外的 CDP 读取——若 CDP 成本高，先只做 Node 假上下文基线 + harness 页面自报数字）。
3. 把绘制耗时纳入 `npm run check:budgets`，预算按数量级设置。

### 验收

- 5000 节点、视口外内容不参与绘制（可通过假上下文调用次数断言）；
- 绘制耗时基线稳定，超预算非零退出。

## Phase C：命中测试迁移

### 设计

1. `hitTest(scene, point)`：逆序遍历 `SceneNode` 树，先判子后判父，跳过 `locked` / 不可见节点，命中返回节点 id；
2. 选择框与手柄：用 Canvas 或独立 overlay 绘制选中态，不再依赖 Moveable/Selecto；
3. 文本编辑：保留 DOM `<textarea>` 覆盖在节点位置（tldraw 同样做法），编辑结束再提交；
4. 移除透明 DOM 节点副本与 `canvas-rendered` 的 CSS 隐藏规则，减少 DOM 节点数。

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
