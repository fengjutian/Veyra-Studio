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

> 若以后需要「分组元数据」（描述、排序权重、可见性），再引入显式字段；
> 现在没有需求就先不加，避免为视图概念付迁移成本。

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

### 4.5 已知限制

- 主题只能覆盖 token，不能改节点/组件/字体之外的东西；
- 没有「主题继承」或「按页面切主题」；
- 导出物里不记录用了哪个主题（交付方拿到的是具体颜色，不是主题名）。

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
- **分组元数据**：分组目前只是名字前缀的视图，不能重命名、排序或加描述。
- **主题继承与按页面切换**。
