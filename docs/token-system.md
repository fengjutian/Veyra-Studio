# Token 体系：分组与别名

> 文档状态：生效中的实现规格
> 建立日期：2026-11-09
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.5.0`）

## 1. 分组：名字前缀就是分组

**分组不写进文档。** 名字里的点号表达层级（`color.text.primary` → 分组
`color.text`），与 CSS 自定义属性、Tailwind 主题的命名习惯一致。这样：

- 旧文档不用迁移，已经按点号命名的人立刻受益；
- 不会出现「移动分组要改 token 名」的双写问题；
- 分组只是面板的组织方式，不影响解析与导出。

实现：`studio-web/src/token-groups.ts` 的 `groupTokens()` 把 token 表切成
`{ id, label, entries }[]`，组按名字排序、未分组（没有点号）排最后、组内按名字排序，
保证面板顺序稳定。

分组元数据（显示名、说明、排序权重）已实现，见 §4.9：它挂在文档的可选字段上，
**不改变「分组 = 名字前缀」这条规则**，只改面板上的显示方式。

## 2. 别名：`{ type: "alias", value: "<目标 token 名>" }`

```ts
type TokenValue =
  | { type: "color" | "number" | "string"; value: string | number }
  | { type: "typography"; value: TypographyValue }
  | { type: "alias"; value: string };
```

语义对齐设计系统的分层：语义 token 指向基础 token（`text.primary` → `gray.900`），
换主题时只改基础层。

### 2.1 解析

`resolveTokenTarget(document, name)` 是唯一入口：沿链走到第一个非 alias token，
返回 `{ name, token }`。断链、环、超过 16 层都返回 `undefined`，调用方退回节点值
（与 token 被删除的处理一致：设计仍然可渲染，只是丢了绑定）。

`tokenColor` / `tokenNumber` / `tokenTypography` 全部经过它，所以**渲染、测量、
导出与绑定校验对「别名指向什么」只有一份答案**。

### 2.2 校验

`validateDocument()` 会拒绝：

- 目标不存在：`token a alias references missing token b`；
- 环（含自引用）：`token a has a cyclic alias chain`；
- 绑定类型不匹配：按**最终类型**判定——颜色别名可以绑填充，数值别名绑填充会被拒；
- 字体绑定仍要求最终类型是 typography 且节点是文本。

### 2.3 编辑

- 「新增 → 别名」输入目标名，校验目标存在且不是自己；
- 修改别名时弹同一个输入框；别名链不在这里做拓扑排序，环由校验层兜住；
- 面板里别名显示成 `→ 目标名`，绑定下拉按最终类型给出可选项
  （`effectiveTokenType()`，链断了就不给绑定入口）。

## 3. 验收

- schema：多级别名解析、断链/环/自引用被拒、按最终类型做绑定校验、
  字体别名仍能覆盖文字样式、旧的字面量 token 不受影响。
- studio-web：分组切分与排序、未分组排最后、别名最终类型解析（含环）。

## 4. 主题：覆盖，而不是第二条解析链

### 4.1 数据模型

```ts
interface Theme {
  id: string;          // 稳定引用键（改名字不影响当前主题）
  name: string;
  tokens: Record<string, TokenValue>;  // 只覆盖已存在的 token
}
interface DesignDocument {
  themes?: Theme[];    // 可选字段，旧文档不需要迁移
}
```

### 4.2 实现方式：合并，而不是传参

`applyThemeTokens(document, themeId)` 返回一份**浅拷贝**，`tokens` 是
「基础值 + 主题覆盖」的合并结果。进入布局、画布场景、导出（含字体内联）之前
先合并一次，之后所有解析——别名、字体 token、组件、资源——都按普通 token 走。

这样做的三个后果：

- `resolveTokenTarget()` 不需要认识主题，调用方也不必层层传递 `themeId`
  （否则每个解析函数、每个导出辅助函数都要多一个参数）；
- 主题覆盖里的别名照常解析，包括「覆盖值指向另一个被覆盖的 token」；
- 没有主题或没有覆盖时**原样返回同一个对象**，调用方可以据此跳过重算。

### 4.3 校验

- 主题 id 唯一、名称非空；
- **只能覆盖已存在的 token**：拼错名字（`gray.90`）在校验阶段就报错，
  而不是存下一份永远不生效的覆盖；
- 每个主题的合并视图都要过一遍别名检查——主题可以把基础 token 覆盖成别名，
  同样可能造出环（`gray.900 → text.primary → gray.900`）。

### 4.4 命令与界面

- 命令：`theme.upsert`（按 id 新增或整组替换）、`theme.delete`。
  MCP 适配器同步登记；AI 命令词汇表暂不开放主题编辑（模型先不碰主题）。
- 界面：「数据 → 主题」选择 `基础` 或某个主题；选中主题后，
  「设计 Tokens」里的改值会写成该主题的覆盖，行上出现「已覆盖」标记与
  「恢复基础值」按钮；新增/删除 token 仍只能在基础模式下做。
- 当前主题是**视图状态**：不进文档、不涨 revision、不写快照；
  导出时随 `themeId` 一起传给导出器。

### 4.5 主题继承（2026-11-10）

主题可以继承另一个主题：

```ts
interface Theme {
  id: string;
  name: string;
  extends?: string;   // 继承自另一个主题
  tokens: Record<string, TokenValue>;
}
```

继承链上的覆盖按「**祖先先、后代后**」叠加：后代覆盖祖先，同一个 token 上后代的值
生效。合并由 `themeTokenMap()` 一次算完，之后所有解析仍走普通 token——继承没有引入
第二条解析链。

典型用法：「暗色」继承「品牌色」。品牌色改了，暗色自动跟着变；暗色自己再覆盖两三个
token（背景、边框）就行，不用把品牌色的每个值重抄一遍。

### 4.6 「已覆盖」与「继承」是两回事

- **已覆盖**：当前主题**自己**写了这个 token → 可以「恢复基础值」；
- **继承**：值来自父主题 → 这里**不能**恢复（恢复的是父主题的覆盖），要去父主题改。

面板上用两个不同的标记区分：`inheritedTokenSource(document, themeId, name)` 说出值来自
哪个主题。

校验阶段拦下两种坏数据：继承指向不存在的主题、继承链成环（环会让「祖先先后代后」
的顺序失去意义，合并时还会无限循环）。

### 4.7 整主题重置

单个 token 的「恢复基础值」之外，面板上还有「**清空该主题的覆盖**」：一次把当前主题
的全部覆盖清掉，回到基础值（或父主题继承来的值）。主题覆盖了几十个 token 时，一个
一个点太慢。

### 4.8 按页面切换主题

`DesignPage` 新增可选 `themeId`：

```ts
interface DesignPage {
  id: PageId;
  name: string;
  childIds: NodeId[];
  themeId?: string;   // 这一页自带的主题
}
```

「暗色模式演示页」就是靠它：那一页单独是暗色，其它页是亮色，翻到那页自动切过去，
不需要用户来回切主题。

优先级：**显式指定 > 页面自带 > 基础值**。统一由 `effectivePageThemeId()` 判定，
所有渲染与导出入口都走 `applyThemeForPage(document, pageId, themeId)`——每个入口各
写一套「到底用哪个主题」的判断，正是画布和导出物对不上的来源。

- **命令**：`page.setTheme`（`themeId` 为空表示清掉）。指向不存在的主题被拒绝——
  页面安静地按基础值渲染，会让用户以为「这一页是暗色」但其实不是。
- **界面**：页面列表下方「主题」按钮给当前页指定主题；带主题的页面在列表里显示一个
  小圆点。主题面板的下拉第一项是「跟随页面」——选中时翻页自动切，不选就用基础值。
- 页面主题是**文档数据**（进文档、涨 revision）；「跟随页面 vs 显式选某个」是**视图
  状态**。

### 4.9 分组元数据

分组本身**永远由 token 名字的前缀决定**（`color.text.primary` → `color.text`），这一点
不放松：分组一旦能独立存在，就会出现「token 在哪个组」的双写问题——重命名分组要改
token 名，改 token 名又会让分组漂移。

元数据只改它在面板上的**显示方式**：

```ts
interface TokenGroupMeta {
  id: string;            // 分组 id（点号路径）；未分组是空串
  label?: string;        // 显示名；缺省用 id
  description?: string;  // 一句说明，显示在分组标题下面
  order?: number;        // 排序权重（小的在前）；缺省按 id 字典序
}
```

挂在文档的可选字段 `tokenGroups?: TokenGroupMeta[]` 上。

- **命令**：`tokenGroup.upsert`（按 id 覆盖，不重复插入）、`tokenGroup.delete`（删元数据，
  不影响 token 本身）。三项都清空等于没有元数据，界面直接删掉这条记录，不留空壳。
- **排序**：给了 `order` 的分组排在前面，没给的接在后面按 id 排；**未分组永远最后**，
  哪怕它带了 order。
- **界面**：分组标题右侧的编辑按钮，打开表单改显示名 / 说明 / 排序权重。
- 旧文档没有 `tokenGroups` 也不需要迁移；zod schema 里必须登记这个字段，否则校验会把
  它悄悄剥掉（面板上改了名，保存回来就没了）。

### 4.10 非文本属性 override

token 覆盖改的是「**值从哪来**」；属性覆盖改的是「**节点自己写死的字段**」——
圆角、间距、内边距、字号、不透明度。后者是「暗色主题下所有卡片圆角更大」这类需求的
前提：没有 token 绑定的节点，它的圆角就写在自己身上，主题不覆盖它就永远不变。

```ts
interface PropertyOverride {
  type?: NodeType;        // 只作用于这一种节点类型；缺省不限
  cornerRadius?: number;  // 圆角 px
  gap?: number;           // 自动布局间距 px
  padding?: number;       // 内边距 px（四边相同）
  fontSize?: number;      // 字号 px（只对文本节点有意义）
  opacity?: number;       // 不透明度 0–1
}

interface Theme {
  // ...
  properties?: Record<string, PropertyOverride>;  // 键是**节点名**
}
```

**匹配键是节点名**。同名的节点会一起被覆盖，所以名字起得越具体越安全；
`type` 可以再把范围收窄到某一种节点类型。

三条规则：

- **绑定了对应 token 的节点不参与**。节点自己绑了 `radius` token，它的圆角来自
  token——这时该改那个 token（主题的 token 覆盖会跟着生效），而不是绕过绑定改字段。
  两处都写会让人说不清「到底谁说了算」。
- **继承链上逐字段叠加**：祖先设了圆角、后代设了间距，两条都生效（后代只覆盖自己
  写了字段）。token 覆盖是整条替换，两者规则不同。
- **不要求节点存在**：节点可能被改名或删掉，为此让整个文档失效更糟。名字打错时
  覆盖不生效——所以覆盖列表里显示节点名，用户自己看得见。

生效路径：进入布局、渲染、导出前，`applyThemeForPage()` 一次性把属性覆盖合到节点上，
之后所有下游只认普通节点。画布、HTML/SVG/React 导出、对比度检查自动跟随——
和 token 覆盖同一条思路，不引入第二条解析链。

界面在「主题」面板里：每个覆盖一行（节点名 + 覆盖了哪些字段），可编辑、可删除，
可新增。

### 4.11 已知限制

- 主题只能覆盖 token，不能改节点/组件/字体之外的东西；
- 导出物里不记录用了哪个主题（交付方拿到的是具体颜色，不是主题名）；
- 继承只有一层链的语义，但实现支持多层（A→B→C）；没有「继承的继承」的显式 UI。
- 分组元数据只影响面板显示：导出物里 token 还是原名，分组名不会写进 CSS。
- 属性覆盖按**节点名**匹配，没有 id / 路径 / 标签这类更精确的选择器；同名节点无法
  区分，只能靠命名。
- 属性覆盖不支持内边距分四边设置，也不支持位置、尺寸、旋转等几何属性。

## 5. 从样式表导入 token

### 5.1 形态

已有设计系统的团队手上通常是 **CSS 自定义属性**（`:root { --color-brand: #6366f1 }`）
或 **SCSS 变量**（`$space-md: 16px`），而不是 Studio 的 token 表。面板上的「导入」
按钮把样式表文本解析成**提案**，用户逐条确认（可改名、可不导入）后写进文档。

解析器：`design-schema/src/token-import.ts` 的 `parseStyleTokens()`；提案转成文档里的
token 值用 `proposalToToken()`。它**不直接改文档**——粘贴一段 CSS 不该悄悄改掉已有
token。

### 5.2 判定纪律

| 源里的写法 | 导入成 | 说明 |
| --- | --- | --- |
| `--color-brand: #6366f1` | color | 十六进制、颜色函数、基础色名、`transparent` / `currentColor` |
| `--space-md: 16px` / `16` | number | 只有无单位数与 px 会换算 |
| `--space-lg: 1.5rem` | string | **不猜单位换算**：rem / em 依赖根字号，猜出来的值会把设计改错，并给出警告 |
| `--text-primary: var(--gray-900)` | alias | 语义与 CSS 一致，指向 `gray-900` |
| `$color-brand: #{$brand}` | 跳过 | SCSS 插值编译后才确定，导入期给不出答案，警告说明原因 |

另外：**注释不算声明**（`/* … */` 与 `// …` 都去掉）、同名变量只保留第一次并提示、
颜色关键字只认基础色名（`bold`、`background` 这类单词在 CSS 里也可能是合法值，猜错
类型会让 token 绑不上任何东西）。

### 5.3 导入流程

1. 粘贴样式表 → 解析出提案；
2. 弹出确认表：每条一行，显示源变量、值与推断类型，**名字可改**，清空表示不导入；
   与文档里已有 token 同名的会标注「会覆盖同名 token」；
3. 确认后在一个事务里发 N 条 `token.upsert`（因此可以一次撤销）。

主题模式下不可导入——主题只能覆盖已有 token。

### 5.4 验收

- 解析器单测（`design-schema/test/token-import.test.ts`）：注释、类型推断、单位不
  换算、别名、插值跳过、重复名、覆盖标注、空输入提示。
- 端到端（`studio-web/test/token-import.test.ts`）：样式表 → 提案 → `token.upsert`
  → 文档 → 绑定解析（含别名链解析到最终颜色）。

### 5.5 已知限制

- 只导入标量 token（颜色 / 数值 / 字符串 / 别名）；**字体 token 推不出来**——
  样式表里的 `--font-body: Inter` 只是族名，导入后可以在面板里改成字体 token。
- 不解析 SCSS 的嵌套与函数（`darken()` 之类）；这类值按字符串导入。
- 不做名称改写：`--color-brand` 变成 `color-brand`（去掉 `--`），其余原样保留。
- Figma 导入尚未实现（Figma 的变量导出是另一种格式）。

## 6. 仍未完成

- **从 Figma 导入 token**：样式表导入已实现（见 §5），Figma 变量导出格式未支持。
- **非文本属性 override**：已实现（见 §4.10）：主题可按节点名覆盖圆角、间距、内边距、
  字号与不透明度；已绑定对应 token 的节点不参与（该改 token）。
- **按页面切换主题**：已实现（见 §4.8）。
- **分组元数据**：已实现（见 §4.9）：分组仍由名字前缀决定，元数据只改显示名、说明与顺序。
