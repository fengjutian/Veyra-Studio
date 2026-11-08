# Penpot 迁移基线

> 文档状态：生效中的外部代码复用基线
> 建立日期：2026-11-08
> 上游快照：`penpot/penpot` @ `904cdd9`（浅克隆，`D:\github\_ref\penpot`）
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`、`editor-tooling-roadmap.md`

## 1. 为什么是 Penpot

Penpot 是目前唯一"开源、可自托管、SVG 原生、且真的有人在用"的 Figma 替代品，
在 2026 年的对比评测里被反复描述为「核心设计能力已与 Figma 接近，差距主要在协作深度、
插件生态与大型文件性能」（来源见 §6）。

对本项目来说它有双重价值：

1. **代码参照**：几何、布局、导出、原型交互都有成熟实现可以对标语义，避免自造轮子。
2. **对标基线**：它已经跑通了「一个不需要 Figma 也能用的设计工具」的全套形态，
   它的能力边界就是本项目追赶路径上的参考刻度。

## 2. 许可证边界（**搬运前必读**）

Penpot 是双许可，**不能整仓库搬**：

| 范围 | 许可证 | 能否搬进本项目 |
| --- | --- | --- |
| 仓库根 `LICENSE` | MPL-2.0 | ✅ 可以，但**逐文件 copyleft**：搬进来的文件必须保持 MPL-2.0 头，且以 MPL-2.0 发布 |
| `backend/` | AGPL-3.0 | ❌ **禁止**。AGPL 的网络分发条款对本项目（MIT）不兼容 |
| `common/src/app/common/svg/path/arc_to_bezier.js` | **MIT**（上游声明，且原始实现来自 fontello/svgpath） | ✅ 可以自由使用，保留 MIT 声明即可 |
| `common/src/app/common/svg/path/parser.js` | MPL-2.0 + 依赖 `goog:cljs.core` | ⚠️ 只能**读懂语义后重写**，不能整文件搬（它是 ClojureScript，不是 JS） |

**结论：Penpot 的前端是 ClojureScript、渲染器是 Rust→WASM，不是 TypeScript。**
「直接搬运代码」在本项目里只有两种合法形态：

1. **MIT 文件原样搬入**（`arc_to_bezier.js`）；
2. **读懂 ClojureScript/Rust 的语义，用 TypeScript 重写**（其余全部模块）。

因此本仓库不存在「把 Penpot 源码目录拷进来」的选项。凡是本文件里出现的
「移植」，指的都是形态 2——**语义对齐的重写**，不是代码复制。

## 3. 已盘点：Penpot 的模块地图

Penpot 的几何与布局核心在 `common/src/app/common/geom/`，渲染在 `render-wasm/`（Rust→WASM）。

| Penpot 源文件 | 行数 | 语义 | 本项目对应 | 状态 |
| --- | --- | --- | --- | --- |
| `svg/path/arc_to_bezier.js` | 177 | SVG 椭圆弧 → 三次贝塞尔近似 | `design-schema/src/arc-to-bezier.ts` | ✅ **已搬运**（MIT，保留声明） |
| `svg/path/parser.js` | 828 | SVG path 解析（M/L/C/Q/A/H/V/S/T + 相对 + 隐式命令） | `design-schema/src/svg-path.ts` | ✅ **已重写**（语义对齐） |
| `geom/shapes/transforms.cljc` | 484 | 形状变换矩阵（平移/翻转/绕中心） | `studio-web/src/renderer/rotation.ts` | ✅ 已有等价实现 |
| `geom/shapes/constraints.cljc` | 283 | 约束求解 | `design-runtime` 的 `constraints` | ✅ 已有等价实现 |
| `geom/shapes/flex_layout/positions.cljc` | 233 | 自动布局位置求解 | `design-layout` stack 布局 | ⚠️ 部分等价，缺 grid |
| `geom/shapes/bounds.cljc` | 209 | 包围盒计算 | `design-layout` | ⚠️ 部分等价 |
| `geom/align.cljc` | 148 | 对齐计算 | `studio-web/src/node-arrangement.ts` | ✅ 已有等价实现 |
| `geom/snap.cljc` | 55 | 吸附 | `studio-web` 吸附实现 | ✅ 已有等价实现 |
| `types/shape/interactions.cljc` | ~400 | 原型交互模型（事件/动作/动画/overlay） | `design-schema/src/interactions.ts` | ✅ **已重写**（语义对齐） |
| `logic/variants.cljc` | — | 组件变体 | `design-schema` component | ⚠️ 缺 variant |
| `geom/shapes/grid_layout.cljc` | 21+ | Grid 布局 | `design-layout` | ❌ **缺** |
| `render-wasm/src/` | Rust | WebGL/SVG 渲染器 | `studio-web/src/renderer/canvas-renderer.ts` | ❌ **不搬**（架构不同） |
| `backend/` | AGPL | 服务端 | — | ❌ **禁止搬运** |

## 4. 搬运纪律

1. **先读懂，再写**。每个被重写的模块，注释里写明「语义对齐自 Penpot 的哪个文件」，
   便于日后 diff 上游实现。
2. **不引入 Penpot 的运行时假设**。Penpot 的形状模型（`:path` + `:content` + `points` +
   `position-data`）与本项目的 `vector.geometry` 归一化路径模型完全不同，
   搬的是**算法**，不是数据模型。
3. **上游是 MPL-2.0**。本项目重写出的代码若构成「衍生作品」需要留意，
   因此重写只借鉴**公开算法与交互语义**（这些不受版权保护），
   不复制其数据结构表达、命名与注释原文。
4. **每块搬运都要有测试**。没有测试的搬运等于没搬。

## 5. 本轮已落地的三块

### 5.1 SVG 圆弧（A 命令）→ 贝塞尔

`design-schema/src/arc-to-bezier.ts`。原样搬入 Penpot 的 MIT 文件
（`common/src/app/common/svg/path/arc_to_bezier.js`），仅做两处最小改动：
去 `goog.provide`/`goog.scope` 包装、改为 TS 导出。

**为什么**：本项目此前把 `A` 命令写进「不支持」清单，理由是「圆弧用贝塞尔近似即可，
不值得为它引入拟合代码」。Penpot 的实现证明拟合代码只有 177 行，
且是**端到端参数化**（按 SVG 规范的 endpoint→center 转换 + 每 90° 一段三次贝塞尔近似），
不是数值拟合——比拟合更准、更快。

**收益**：SVG 导入不再需要丢弃圆弧；圆弧在文档里仍以 `C` 存储，不新增命令类型。

### 5.2 SVG path 导入解析器

`design-schema/src/svg-path.ts`。按 Penpot `parser.js` 的语义重写，
覆盖 Penpot 支持的全部命令：`M/L/C/Q/A/H/V/S/T/Z` 及小写相对形式，
以及隐式命令（`M` 后续坐标视为 `L`、`m` 视为 `l`）。

**与 Penpot 的差异（有意为之）**：
- Penpot 的解析器产出 CLJS 关键字 map；本项目产出 `PathCommand[]`，直接进既有管线。
- Penpot 遇到非法输入返回 `null` 并停止；本项目整体作废（返回 `undefined`），
  理由与既有 `parseVectorPath` 一致：**静默丢掉一半路径会画出和原意完全不同的图形**。
- 相对命令与 `H/V/S/T` 在**导入时**展开成绝对 `M/L/C/Q`，因为本项目的文档格式
  只有这五种；`S`/`T` 的控制点镜像按 SVG 规范用「上一个曲线的控制点」推导。

### 5.3 原型交互模型

`design-schema/src/interactions.ts`。按 Penpot `types/shape/interactions.cljc` 的
事件/动作/动画/overlay 语义重写。

这是本项目与 Figma/Penpot 差距最大、且此前完全空缺的一块（`current-project-status.md`
的「尚未实现」清单里，协作与原型都是空项）。语义对齐要点：

- **事件类型**：`click` / `mouse-press` / `mouse-over` / `mouse-enter` / `mouse-leave` /
  `after-delay`（`after-delay` 只对 frame 合法）。
- **动作类型**：`navigate` / `open-overlay` / `toggle-overlay` / `close-overlay` /
  `prev-screen` / `open-url`。
- **动画类型**：`dissolve` / `slide` / `push`，各带 `duration` / `easing` / `direction` 等。
- **overlay 定位**：`manual` / `center` / `top-left` / `top-right` / `top-center` /
  `bottom-left` / `bottom-right` / `bottom-center`。
- **关键语义（Penpot 明确注释过的坑）**：切换事件或动作类型时**旧字段不删除**，
  以便用户切回来时能恢复。所以读取必须走 `hasDelay()` / `hasDestination()` 这类判定函数，
  不能直接读字段。本项目照搬这个语义，并把它写进 API 设计。

## 6. 来源

- Penpot 仓库：https://github.com/penpot/penpot
- 许可证：https://github.com/penpot/penpot/blob/develop/LICENSE
- Figma / Penpot 能力对比（用于确定追赶刻度）：
  - https://hedrick.io/post/penpot-vs-figma
  - https://besttoolsalternatives.com/figma-vs-penpot
  - https://shaheermalik.com/compare/figma-vs-penpot

## 7. 后续可搬清单（按本项目缺口优先级）

1. **Grid 布局**（Penpot `geom/shapes/grid_layout.cljc`）——本项目只有 absolute/stack。
2. **组件变体**（Penpot `logic/variants.cljc`）——本项目有组件但无 variant。
3. **原型运行时**——本轮只落数据模型，还需要预览模式与交互状态机。
4. **混合模式 / 椭圆渐变**——Penpot 的 `render/fills.rs` 有对应实现可对标语义。
