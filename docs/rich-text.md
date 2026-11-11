# 富文本（段内样式）规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`editor-tooling-roadmap.md`、`figma-gap-roadmap.md`

## 1. 要解决的问题

在此之前文本样式是**节点级**的：一个 `text` 节点一个字号、一个字重、一个颜色。
但真实文案稿几乎必然出现「一段话里加粗几个词、给一个词换色」——这被列为四个硬门槛之一。

本轮实现**段内样式（rich text runs）**，范围只到「字符级样式」：

- ✅ 字重（`fontWeight`）、字形（`fontStyle`）、颜色（`color`）可以在任意区间覆盖；
- ✅ 字号（`fontSize`）可以段内覆盖：它同时改变宽度与行高，行高按「该行最大字号」撑开；
- ❌ 行高不做段内覆盖——行高由节点值与该行最大字号共同决定，避免「一行多高」需要迭代求解；
- ❌ 字体族不做段内覆盖；
- ❌ 本轮不做段落级样式（缩进、列表、行内图片）——**已在后续轮次单独实现**：
  列表与列表缩进见 `paragraph-styles.md`（段落级样式与段内样式是两套模型，
  分开做是为了让「段内样式」这一层保持简单）。

## 2. 数据模型

```ts
interface TextRunStyle {
  fontWeight?: number;   // 100–900
  fontStyle?: "normal" | "italic";
  fontSize?: number;     // 段内字号（px），同时影响换行与行高
  color?: string;        // 任意 CSS 颜色字符串
}

interface TextRun {
  from: number;  // UTF-16 下标
  to: number;
  style: TextRunStyle;
}

interface TextNode {
  text: string;        // 唯一的内容真相
  runs?: TextRun[];    // 可选；空数组在命令层会被清成 undefined
}
```

三个决定：

1. **`text` 仍是纯字符串，样式用区间旁挂**，而不是把文本拆成段落数组。
   否则纯文本编辑器、AI 计划、搜索、导出、组件实例化都要理解富文本结构；
   现在的形态下，不关心样式的调用方读 `text` 就够了。
2. **偏移是 UTF-16 下标**，与 `textarea.selectionStart/End` 同口径。
   换一套坐标系（码点数、字节）只会在选区换算上制造 off-by-one。
   代价是必须拒绝「切在代理对中间」的区间（见 §3）。
3. **可选字段，不升文档格式版本**。旧文档没有 `runs`，行为逐字不变——
   这条是仓库的既定纪律：能用默认值兼容就不升版本。

## 3. 校验（唯一入口）

`design-schema/src/rich-text.ts` 的 `validateTextRuns(text, runs)` 是唯一判定：

- `from` / `to` 是整数，`0 <= from < to <= text.length`；
- 按 `from` 升序、**互不重叠**；
- 边界不得落在代理对中间（`😀` 占两个 UTF-16 单元，切一半会渲染出乱码）；
- 每个 `style` 至少有一个字段，字段值合法（字重 100–900、字形 normal/italic、字号为正数、颜色非空）。

两处调用：`schema.ts` 的 `superRefine`（导入/读盘）与运行时 `text.patch`（编辑）。
错误信息带 `runs.<i>` 下标，不是一句「Invalid input」。

**文本被改写时**（`text.patch` 只给 `text` 没给 `runs`）走 `remapTextRuns()`：
按最长公共前后缀定位改动区间，改动点之后的区间整体平移、跨区间的按规则截断。
没有这一步，在段首插入一个字就会让「加粗的那一段」整体错位一个字。

## 4. 布局与测量

`design-layout/src/rich-text-layout.ts` 提供**唯一的换行实现** `layoutRichText()`：

- 按码点拆字符、逐字累加宽度；
- 溢出时回退到本行**最后一个空格**断行（拉丁文优先断词，中文按字断行）；
- 行尾空格不参与行宽（与 CSS 一致）；
- 输出「行 → 段 → x 偏移 + 行高」，画布与测量器共用；行高 = max(节点行高, 该行 run 的行高覆盖, 该行最大字号)，
  所以段内大字号会把这一行撑高，不会被相邻行压住。

> 2026-11-11 更新：段内**行高覆盖**已实现（见 §9），行高取值多了一个来源。

三个测量入口（估算器、浏览器 Canvas、宿主注入）都走它：

- `createEstimateTextMeasurer`：字重按 +6% 估算宽度；
- `browser-text-measurer`：逐段换 `context.font` 量真实字宽；
- `TextMeasurementRequest` 带上了 `runs`，宿主可以自己实现段内测量。

测量缓存键包含 `runs` 的 JSON——少这一项就会出现「改成局部加粗后尺寸不更新」。

> 为什么必须共用：换行位置决定行数与 hug 高度。画布和测量器各写一份的话，
> 画布换 3 行、布局以为 2 行，hug 的文本框会把最后一行裁掉。

## 5. 渲染与导出

| 端 | 实现 |
| --- | --- |
| 画布 | `canvas-renderer` 逐段设置 `font`（含段内字号）/ `fillStyle` 后 `fillText`，按行高逐行推进；有字距时逐字落笔（x 偏移已含字距，整段绘制会重复加一次） |
| HTML | 每段一个 `<span style="font-weight:…;font-size:…">`，只写被覆盖的字段，其余继承 `<p>`；无 `runs` 时产物与升级前逐字一致 |
| SVG | 每段一个 `<tspan font-weight=… font-size=… fill=…>`；SVG 不自动换行是既有行为，本轮不改 |
| PNG | 由 SVG 光栅化，自动继承 |

## 6. 编辑入口

属性面板「文字」区：

1. 文本框（多行）选中一段文字 → 面板记录选区（`onSelect`，只移动光标也更新）；
2. 此时改「粗细 / 字形 / 选区字号 / 选区颜色」，只作用于选区；没选区则改整个节点；
3. 「清除选区样式」把这段区间恢复成节点级样式；
4. 提示文案随选区变化（显示「已选中 N 个字符」）。

画布内联编辑（双击文本）是结构化 `contenteditable`（段落块 + 段内 run + 列表标记），
**已能直接改样式**——见 §9.2。提交时若只给了文字而没给 `runs`，运行时用
`remapTextRuns()` 按前后缀对齐，所以「在段首插字」不会把样式留在原地。

## 7. 已知限制

- 段内不支持**字体族**覆盖（字号与行高见 §1 / §9）；
- 组件实例的文本覆盖（`component.override`）只同步 `text`，不同步 `runs`；
- SVG 导出不换行（既有行为），富文本只解决样式不分段的问题；
- 段内颜色的取值不做校验（任意 CSS 颜色字符串），token 绑定不适用于段内覆盖；
- 段落级样式（列表、缩进）走独立模型与独立命令 `text.paragraph.set`，
  不与段内 `runs` 混用——详见 `paragraph-styles.md`。

## 9. 段内行高覆盖与编辑器内改样式（2026-11-11）

### 9.1 段内行高覆盖

`TextRunStyle` 增加可选 `lineHeight?: number`（px）。语义：

> 行盒高度 = max(节点级 lineHeight, 该行所有 run 的 lineHeight 覆盖, 该行最大字号)

**行高不参与换行**——换行只看字号与可用宽度，所以「把一行撑高」不会让后面的行折返位置改变，
只会把整段往下推。不做迭代求解（那需要「一行多高」的收敛），与「段内行高是行盒高度下限」
这个定义一致。

- **校验**：`rich-text.ts` 的 `TEXT_RUN_STYLE_FIELDS` / `isEmptyRunStyle` / `sameRunStyle` /
  `validateRunStyle` 同步纳入该字段（值为正数）；zod 侧 `textRunSchema.style.lineHeight`。
- **布局**：`design-layout/src/rich-text-layout.ts` 的 `lineHeightFor()` 改为四路取 max。
  相邻 run 因行高不同会被 `sameStyle()` 切开，因此行高覆盖能精确落到所在行。
- **导出**：HTML 的段内 `<span>` 输出 `line-height`；SVG **不换行**（每段一行），
  所以段内行高只体现为**段与段之间的推进距离**（`paragraphLineHeight()`）。

### 9.2 编辑器内直接改样式

画布内联编辑层新增**浮动工具条**（加粗 / 颜色 / 字号）+ `Ctrl/Cmd+B`：

- 选区用 `window.getSelection()` 的 Range 换算成 UTF-16 字符偏移
  （`editorSelectionOffsets()`，口径与 `readEditorText()` 完全一致：块间 `\n`、`<br>` 算 1、标记跳过）；
- 应用样式后**重建 DOM 并恢复选区**（`restoreEditorSelection()`）；
- 提交时从 DOM **回读** `runs`（`readEditorRuns()`），不再只回读纯文本。

原先编辑层是**只读文档 → DOM 的单向渲染**，样式永远来自文档；现在提交会带上从 DOM 反推的
`runs`，所以编辑器里改的样式能落进文档。

### 9.3 属性面板改样式实时反映到编辑器

根因是编辑层 DOM **按节点 id 只构建一次**（`builtFor.current === node.id` 提前 return），
面板改样式后文档变了、prop 变了，但 DOM 不重建 → run 级样式全部过期。

现在区分两类变化（`syncEditorModel()`）：

- **结构变化**（run 区间或段落结构改了）→ 重建 DOM；
- **样式变化**（节点级字重/字号/颜色变了）→ `updateEditorRunStyles()` **只更新 span 的行内样式，
  不动 DOM 结构**，光标与选区因此保住。

偏移对齐：节点上的 run/段落样式是按「构建时文本」算的偏移，用户打过的字会让它漂移 →
先用 `remapTextRuns()` / `remapParagraphStyles()` 对齐到当前 DOM 文本，再比较。

顺带修掉的缺陷：编辑器基础字重原先用 `node.fontWeight`（可能 `undefined`）而不是
`TEXT_DEFAULTS.fontWeight`，与画布（`?? 400`）不一致——现在两边同一套兜底。

### 9.4 已知限制

- 编辑态**不显示节点级效果**（混合模式、阴影、模糊）——编辑器只是个普通 DOM 容器，
  这些效果只在画布上生效。
- 应用样式走「重建 DOM + 恢复选区」，会丢失浏览器原生的撤销栈（`Ctrl+Z`）；
  选区与光标位置由代码精确恢复。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-schema/test/rich-text.test.ts` | 校验、区间切分、清除、修剪、平移、代理对 |
| `design-layout/test/rich-text-layout.test.ts` | 换行、空格优先、超长词硬断、字距、hug 高度随加粗变化、段内字号撑高行盒与逐行高度求和 |
| `design-export/test/rich-text.test.ts` | HTML span / SVG tspan（含段内字号）、转义、无 runs 时产物不变 |
| `design-runtime/test/runtime.test.ts` | 命令层校验、文本改写后的区间平移、清空 |
| `studio-web/test/renderer-rich-text.test.ts` | 画布逐段字体与颜色、段内字号按行高推进、无 runs 时仍逐行绘制 |

视觉基线未变（fixture 不含 runs），因此像素回归仍是 0 差异。
