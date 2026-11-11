# 富文本段落样式（列表 + 缩进）规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`rich-text.md`、`figma-gap-roadmap.md`、`current-project-status.md`

## 1. 要解决的问题

`rich-text.md` 解决的是**段内**（字符级）样式：字重、字形、字号、颜色。
它明确列了一条不做的事：**「❌ 不做段落级样式（缩进、列表）」**。

这条缺口在本项目里比在一般工具里更疼：本仓库的定位是「本地优先 + 可被 Agent 驱动」，
而**列表是信息结构，不是装饰**。画任何带层级的界面——功能清单、导航目录、
变更日志、需求条目——都要列表。没有段落样式，画布只能画「一堆等宽的段落」。

Figma 的对应能力（已实查 Figma 帮助文档）：

- **列表类型**：bulleted list / numbered list；
- **列表缩进**：最多 **5 级**，用 Tab / Shift+Tab 增减；
- **编号样式随级别循环**：一级数字（1. 2. 3.）→ 二级字母（a. b. c.）→ 三级罗马数字（i. ii. iii.）；
- **bullet 各级别样式一致**（不随缩进换形状）；
- **段落缩进（Paragraph indent）**：以 **px** 为单位，只对左对齐文本生效。

本轮实现**段落样式**的范围：

- ✅ 列表类型：`bullet` / `ordered`；
- ✅ 列表缩进级别：0–4（对齐 Figma 的 5 级上限）；
- ✅ 编号随缩进级别切换数字 / 字母 / 罗马数字；
- ✅ 相对缩进（`indentDelta`）：每一段按**自己**的级别加减，对应 Tab / Shift+Tab；
- ✅ 段落缩进（`paragraphIndent`，px）：Figma 的 Paragraph indent，与列表缩进**并存**——
  列表缩进是「列表结构」，段落缩进是「这一段整体往右推多少像素」，两者叠加；
- ✅ 悬挂列表（`hanging`）：标记**不占正文宽度**，画在文本框左边界之外；
- ✅ 列表间距（`listSpacing`，px）：这一段**之后**额外留出的垂直空间；
- ✅ 混合列表类型（有序里嵌无序）——`ParagraphStyle.listType` 是**逐段**声明的，
  数据模型本来就允许相邻段落类型不同；编号按「列表序列」重置（不同类型的列表各自从 1 开始）。

### 1.1 三项新能力的取舍记录

- **段落缩进为什么单独一个字段**：它与列表缩进在几何上都是「把文字往右推」，
  但语义不同——`indent` 说的是「这是几级列表」，`paragraphIndent` 说的是
  「这一段整体右移多少像素」。混成一个字段会让「这一段到底缩进多少」说不清，
  也无法表达「非列表段落也要缩进」。两者叠加，顺序固定：
  `left = indent * LIST_INDENT_STEP + markerWidth + paragraphIndent`。
- **段落缩进只对左对齐生效**（与 Figma 一致）：居中 / 右对齐时画布会把它从左偏移里扣掉，
  否则「居中 + 缩进」在 Figma 里没有意义。测量链路必须知道对齐方式，
  所以 `TextMeasurementRequest` 增加了 `align`，文本缓存键也要带上它。
- **悬挂列表为什么画布能表达**：上一轮判断「画布无法表达画到框外」是错的——
  画布的裁剪区可以往左让出标记的宽度，标记画在框外。正文从框的左边缘开始，
  标记右边缘停在框左边界之前 `LIST_MARKER_GAP`。
- **列表间距为什么不是节点级行距**：行距是「所有行之间」，列表间距是「这一段之后」，
  两者作用点不同（行距会把段落内部也拉开）。

## 2. 数据模型

### 2.1 段落边界

段落边界就是 `text` 里的 `\n`。段落 i 的字符区间是
`[start_i, end_i)`，`end_i` 是第 i 个 `\n` 的下标（不含）或 `text.length`。

**段落序号随文本变化而变化**——这是本设计的全部难点所在。
`runs`（段内样式）用的是「UTF-16 区间」，文本改写时靠 `remapTextRuns()` 平移；
段落样式如果也用区间，就会有同一类问题，但更棘手：**列表编号依赖段落的相对顺序**，
而区间平移不保序。

### 2.2 选型：区间 vs 段落序号

| 方案 | 描述 | 问题 |
| --- | --- | --- |
| A. 段落序号数组 | `paragraphs: ParagraphStyle[]`，索引 = 段落序号 | 文本改写（插删换行）会让序号整体错位，样式会「跑到隔壁段落」；且数组长度必须与段落数严格同步，任何漏改都是静默错位 |
| B. 字符区间 | `paragraphStyles: { from, to, style }[]`，用 UTF-16 区间表达 | 区间不保序这件事不存在——编号在**渲染时**按段落顺序现算，区间只回答「这一段是什么样式」 |

**选 B**。理由：

1. **与 `runs` 同构**。仓库已有的 `remapTextRuns` / `applyTextRunStyle` / `mergeTextRuns`
   全部可以复用心智模型与大部分工具函数，代码评审与后续维护成本低。
2. **文本改写时的行为可预测**：区间按公共前后缀平移，和段内样式的行为一致；
   用户在段首插一个字，列表样式跟着那一段走，而不是整体错位一位。
3. **编号不存进数据**。编号是**渲染期的纯函数**：按段落顺序遍历，遇到 `ordered` 段落就递增计数器。
   这样「插一行」「删一行」不需要任何数据迁移，编号自动正确。

代价是：一次 `ordered` 列表的多个段落会存成多个区间（除非它们相邻且样式相同）。
`mergeParagraphStyles` 会在写入时合并相邻同款区间，代价可控。

### 2.3 类型

```ts
/** 列表类型。 */
export type ListType = "bullet" | "ordered";

/** 一个段落的样式。 */
export interface ParagraphStyle {
  listType?: ListType;
  /** 列表缩进级别，0–4（对齐 Figma 的 5 级上限）。 */
  indent?: number;
  /** 段落缩进（px）：这一段整体往右推多少像素；只对左对齐生效。 */
  paragraphIndent?: number;
  /** 悬挂列表：标记不占正文宽度，画在文本框外。 */
  hanging?: boolean;
  /** 列表间距（px）：这一段之后额外留出的垂直空间。 */
  listSpacing?: number;
}

/** 段落样式区间：from/to 是 UTF-16 下标，指向整段（含首尾换行符的归属见下）。 */
export interface ParagraphStyleRun {
  from: number;
  to: number;
  style: ParagraphStyle;
}
```

区间语义与 `runs` **刻意不同**，必须写清楚：

- `runs` 的区间是**字符级覆盖**，可以只覆盖一段文字的一部分；
- `paragraphStyles` 的区间**必须对齐段落边界**：`from` 必须是某段的起点，
  `to` 必须是某段的终点。不对齐的区间在写入时被拒绝。

原因：段落样式描述的是「整个段落是什么样子」。允许半段对齐会让「这一段算不算列表项」
变成一个模糊问题，而列表编号要求段落边界清晰。

**换行的归属**：`"a\nb"` 有两个段落。段 0 是 `[0, 1)`，段 1 是 `[2, 3)`——
换行符 `[1, 2)` 不属于任何段落。这样每个段落区间都**不含尾随换行符**，
区间长度 = 段落文本长度，判断「区间是否对齐段落边界」时规则简单：
`from` 等于某个段落的 `start`，`to` 等于某个段落的 `end`。

**区间之间不允许重叠**，且「相邻」按段落算：两个区间之间只隔着换行符、
正文为空时算相邻，可以合并成一条记录（`mergeParagraphStyles`）。

### 2.4 挂载位置

```ts
export interface TextNode {
  // …既有字段
  /** 段落样式区间；为空表示整节点无段落样式。 */
  paragraphStyles?: ParagraphStyleRun[];
}
```

**可选字段，不升文档格式版本**。旧文档没有 `paragraphStyles`，行为逐字不变——
与 `runs` 同一纪律：能用默认值兼容就不升版本。

段落样式**不进 `TextPatch`**。`TextPatch` 是「节点级样式字段」的一次性替换，
而段落样式是「带区间语义」的结构，塞进 `TextPatch` 会让「改一个字」
和「改一串区间」混在一条命令里。段落样式走独立命令（见 §5）。

### 2.5 文本改写时的样式迁移

`text.patch` 改了文字而没给新的 `paragraphStyles` 时，运行时用
`remapParagraphStyles(oldText, newText, runs)` 把区间重新对齐。

迁移按**「字符是否还在」**做，而不是纯偏移平移：

1. 用「最长公共前缀 + 最长公共后缀」定位改动区间；
2. 落在公共前缀里的字符位置不变，落在公共后缀里的字符整体平移，
   落在改动区间里的字符视为消失；
3. 旧段落里还活着的字符落在新文本的哪些段落上，样式就跟到那里。

由此得到三个直观的结果：

- 在段落中间改字：段落还在，样式跟着走；
- 在段落中间插入换行：原来的一段变成两段，**两段都继承**列表样式；
- 把整段删掉：样式一起消失（没有段落可挂）。

结果重新吸附到新文本的段落边界，因此 §2.3 的校验规则（区间必须对齐边界）仍然成立。

## 3. 布局与测量

段落样式**改变行的几何**：缩进让文字右移，列表标记占据左侧空间。
因此段落样式必须参与**测量**，否则 hug 高度算错——这正是 `rich-text.md` §4
强调过的那个坑（「画布换 3 行、布局以为 2 行」）。

### 3.1 几何常量

```ts
/** 每一级列表缩进额外让出的水平空间（px）。 */
export const LIST_INDENT_STEP = 24;
/** 列表标记（bullet / 编号）占据的固定宽度（px）。 */
export const LIST_MARKER_WIDTH = 20;
/** 列表标记与正文之间的留白（px）：标记右边缘停在正文左侧这么多位置。 */
export const LIST_MARKER_GAP = 4;
/** 列表缩进级别上限（对齐 Figma 的 5 级）。 */
export const MAX_LIST_INDENT = 4;
```

`LIST_MARKER_WIDTH` 是**固定值**而不是实测文本宽度，原因有二：
- 标记文本（`•` / `1.` / `iv.`）宽度随字体变化，而布局引擎要能在**没有字体引擎**时算宽
  （`createEstimateTextMeasurer` 是纯估算器）；
- 固定宽度让「标记区」在各端（画布 / HTML / SVG）表现一致，导出时不需要重新测量。

`LIST_MARKER_GAP` 是标记与正文之间的**视觉间隙**：编号位数不同（`1.` / `10.` / `iv.`）
时标记右对齐才不会贴到正文上。

### 3.2 行偏移

一个段落里**所有行**的左侧都要让出：

`indent * LIST_INDENT_STEP + (listType ? LIST_MARKER_WIDTH : 0) + paragraphIndent`

- `indent * LIST_INDENT_STEP`：列表缩进级别；
- `LIST_MARKER_WIDTH`：列表标记区（bullet / 编号画在这里）；
- `paragraphIndent`：段落缩进（px）。

三个例外：

- **悬挂列表**（`hanging`）：标记区宽度为 **0**——标记不占正文宽度，正文从文本框的
  左边缘开始；标记画在框外（框左边界之外 `LIST_MARKER_GAP` 处）。
  级别缩进仍然保留（`indent * LIST_INDENT_STEP`），只有标记区宽度被去掉。
- **非左对齐**：居中 / 右对齐时 `paragraphIndent` 被扣掉（§1.1），
  于是左偏移回到「列表缩进 + 标记区」。
- **列表间距**（`listSpacing`）：不改变水平偏移，而是加到该段**最后一行**的行高上，
  于是后续行（下一段）整体下移，而这一行自己的文字位置不变。

**标记只画在段落的首行**；折行后的行不再画标记，但正文仍然与首行正文左对齐
（都在同一个 `left` 偏移上）。这与 CSS 的列表一致：列表项的续行与首行文字对齐，
而不是顶到标记下面。

### 3.3 编号的计算

编号是**渲染期的纯函数**，不存进文档：

```
counters: Map<indentLevel, number>   // 每级一个计数器
for each paragraph in order:
  if style.listType !== "ordered":
    // 非编号段落：本级与更深级别的计数器清零
    // → 两段独立的编号列表各自从 1 开始
    clear counters at level >= paragraph.indent
    continue
  n = (counters.get(indent) ?? 0) + 1
  counters.set(indent, n)
  // 更深级别的计数器重置：子列表重新从 1 开始
  for (level of counters.keys()) if (level > indent) counters.delete(level)
  marker = formatOrdered(n, indent)
```

`formatOrdered(n, indent)` 按缩进级别选格式（对齐 Figma 的「随级别循环」）：
**数字 → 小写字母 → 小写罗马 → 回到数字**，两级一循环。

| indent | 格式 | 例子 |
| --- | --- | --- |
| 0 | 阿拉伯数字 | `1.` `2.` `3.` |
| 1 | 小写字母 | `a.` `b.` `c.` |
| 2 | 小写罗马数字 | `i.` `ii.` `iii.` |
| 3 | 阿拉伯数字（回到第一级） | `4.` `5.` |
| 4 | 小写字母 | `e.` `f.` |

字母用 `a..z, aa..az`（Excel 式进位，不是 `a..z, aa..ba`）；
罗马数字用标准减法记法（`4 → iv`，`9 → ix`）。

bullet 标记固定为 `•`，**各级别一致**（Figma 明确如此）。

## 4. 渲染与导出

| 端 | 实现 |
| --- | --- |
| 画布 | `canvas-renderer` 在段落首行左侧画标记（`•` 或编号，普通列表右对齐在 `x + left - LIST_MARKER_GAP`，悬挂列表右对齐在 `x - LIST_MARKER_GAP` 即框外），正文按 §3.2 的偏移右移；折行后的行只让出缩进，不再画标记。悬挂列表的裁剪区往左让出「标记宽度 + 间隙」，否则框外的标记会被裁掉 |
| HTML | 节点包一个 `<div>`，内部每段一个块：列表段落用 `<ul>/<ol>`（标记由 CSS `list-style` 提供，缩进用 `padding-left`），普通段落用 `<p>`。段落缩进并入 `padding-left`；悬挂列表的 `padding-left` 不含标记区宽度（配合 `list-style-position:outside`，标记落在列表框外）；列表间距用 `margin-bottom` |
| SVG | 标记与正文分属两个 `<text>`：标记一个（`text-anchor="end"`），正文一个（SVG 的 `<text>` 不自动换行，位置靠 `x`）；多段包在一个 `<g>` 里。段落缩进改正文的 `x`，列表间距累加到后续段的 `y` |
| PNG | 由 SVG 光栅化，自动继承 |

HTML 用**真正的 `<ul>/<ol>`** 而不是「段落 + 手写标记」：这样浏览器负责标记渲染，
缩进、编号格式都能对上，同时导出的 HTML 在浏览器里可编辑、可复制。

有序列表的编号用 `<li value="N">` **显式给值**：浏览器会按自己的规则数，
而画布上的编号是按段落顺序现算的（见 §3.3），两者的「第几项」可能不同
（例如中间插了一段普通段落）。显式给值保证导出的编号与画布一致。

**HTML 的已知近似**：Figma 支持一个文本节点里混排「列表段落 / 普通段落」，
而 `<ul>/<ol>` 是块级容器，不能与 `<p>` 平级混排。处理办法是
**每个段落独立成块**：列表段落包在自己的 `<ul>/<ol>` 里，普通段落是 `<p>`。
连续同类型的列表段落合并进同一个 `<ul>/<ol>`（这样编号才连续）。

## 5. 编辑入口

### 5.1 命令

```
text.paragraph.set
  payload: { id, from, to, style: { listType?, indent?, indentDelta?, paragraphIndent?, hanging?, listSpacing? } }
```

`from` / `to` 是 **UTF-16 下标**（与 `runs` 同口径），指向**要施加样式的段落范围**。
命令会把区间**吸附到段落边界**：给到段落中间时，整段都受影响。

- `style` 里的字段是**增量**：`listType: "bullet"` 表示设为项目符号；
  不传的字段保持原值。
- `listType: "none"` 表示**取消列表**（回到普通段落），缩进级别同时归零。
- `indent` 是**绝对**级别（0–4）。
- `indentDelta` 是**相对**缩进（−4…+4）：每一段按**自己**的级别加减，
  对应 Tab / Shift+Tab。选区里既有 0 级又有 2 级时，加一级后分别是 1 级和 3 级，
  不会被统一设成同一个值。
- `paragraphIndent` 是**绝对**像素数（≥ 0）：这一段整体右移多少。
- `hanging` 是布尔：只有列表段落才有意义（没有标记就谈不上悬挂）；
  没有 `listType` 的段落设 `hanging` 会被文档校验拒绝。
- `listSpacing` 是**绝对**像素数（≥ 0）：这一段之后的额外垂直空间。
- 三个新字段与 `listType: "none"` 一样遵循「归零 / 关掉 = 删字段」：
  写 `paragraphIndent: 0` 等于没有段落缩进，不会留下一条 `0`。

**选区右端是开区间**：`to` 是选区的结束位置，不属于选区。所以 `to` 恰好落在
某一段的起点时，那一段**不算**被选中（`"a\nb\nc"` 里选 `[0,4)` 只覆盖 `"a"` 和 `"b"`）。
光标态（`from === to`）按光标所在段落处理。

配套一条读回命令不需要——属性面板直接读文档。

### 5.2 UI

属性面板「文字」区新增「段落」小节：

- **列表类型**：分段控件（无 / 项目符号 / 编号），作用于选区覆盖的段落；无选区时作用于全节点。
- **列表缩进**：`−` / `+` 步进器，0–4 级（按相对缩进加减）。
- **段落缩进**：数字输入（px，≥ 0）。
- **悬挂**：分段控件（不悬挂 / 悬挂），只在列表段落上可用。
- **列表间距**：数字输入（px，≥ 0）。

选区语义复用现有的 `textSelection`（UTF-16 选区）。
段落样式作用于「与选区相交的所有段落」——这与 Figma 一致（在列表项中间选一个字，
整个列表项都会变）。

### 5.3 混排列表类型（2026-11-11）

`ParagraphStyle.listType` 是**逐段**声明的，所以数据模型本来就允许相邻段落类型不同。
原先的限制只写在文档里，**代码层没有这个约束**——现已把编号语义对齐 Figma。

`resolveParagraphs()` 的编号算法修正：bullet 与普通段落**清空所有级别**的 ordered 计数
（原只清 `key >= level`）。修掉的 bug：

| 段落序列 | 修正前 | 修正后 |
| --- | --- | --- |
| `ordered(0) → bullet(0) → ordered(0)` | `1. / • / 1.` | `1. / • / 1.`（本来就对） |
| `ordered(0) → bullet(1) → ordered(0)` | `1. / • / 2.` | `1. / • / 1.` |

即：**不同类型的列表是独立的列表序列**，各自从 1 开始——与 Figma 一致。深层重启语义保留：
`ordered(0) → ordered(1) → ordered(0)` 仍是 `1. / a. / 2.`。

**这是对已有混排文档的行为变更**（编号从延续变成重新从 1 开始）；单类型列表文档逐字不变。

HTML 导出的分组本来就正确：按连续同类型切成 `<ul>` / `<ol>`，混排会拆成多个列表块。

## 6. 已知限制

- **悬挂列表的标记画在文本框外**：画布能画，但标记会被父级的 `clip` 裁掉
  （节点自身开了裁切时）；
- **段落缩进只对左对齐生效**：居中 / 右对齐时会被扣掉（与 Figma 一致，不是缺陷）；
- **列表间距只加在段落之后**，不能表达「段前间距」；
- **段落样式不进 `TextPatch`**：只能通过 `text.paragraph.set` 改；
- **组件实例的文本覆盖不同步段落样式**：`component.override` 只同步 `text`；
- **SVG 不换行**（既有行为），段落样式只解决缩进与标记，不解决折行。

## 7. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-schema/test/paragraph-styles.test.ts` | 校验、区间对齐、合并、remap、编号格式 |
| `design-schema/test/paragraph-indent.test.ts` | 段落缩进 / 悬挂 / 间距的解析与合并语义、非法值拒绝 |
| `design-layout/test/paragraph-layout.test.ts` | 行偏移、标记区、编号递增与重置、hug 高度 |
| `design-layout/test/paragraph-indent-layout.test.ts` | 段落缩进与对齐的关系、悬挂的标记宽度、列表间距的行高 |
| `design-runtime/test/paragraph-styles.test.ts` | 命令层：区间吸附、增量语义、取消列表 |
| `design-runtime/test/paragraph-indent.test.ts` | 三个新字段的命令校验与文档级校验 |
| `design-export/test/paragraph-styles.test.ts` | HTML 的 `<ul>/<ol>` 分组与缩进、SVG 的标记文本 |
| `design-export/test/paragraph-indent-export.test.ts` | HTML 的段落缩进 / 悬挂 / 间距表达、旧产物不变 |
| `studio-web/test/renderer-paragraph-styles.test.ts` | 画布画标记、正文右移、折行后不再让出标记区 |
| `studio-web/test/renderer-paragraph-hanging.test.ts` | 框外的悬挂标记、裁剪区让位、段落缩进与列表间距的落笔位置 |

## 8. 参照来源

- Figma 帮助文档「Lists / Paragraph indent」：
  https://help.figma.com/hc/en-us/articles/360039827134-Bulleted-and-numbered-lists
- Figma 插件 API `paragraphIndent` / `hangingList`：
  https://www.figma.com/plugin-docs/api/TextNode/
- Penpot 文本内容模型（root → paragraph-set → paragraph → text）：
  `frontend/text-editor/`（内容树，段落是结构化节点）
