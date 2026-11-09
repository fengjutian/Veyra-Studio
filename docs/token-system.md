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

## 4. 仍未完成

- **主题切换**：同一份 token 在不同主题下取不同值；这需要 `document.themes`
  与「解析时传入当前主题」的全链路改造，单独一轮做。
- **从样式表 / Figma 导入 token**：没有解析器，也没有映射表。
- **分组元数据**：分组目前只是名字前缀的视图，不能重命名、排序或加描述。
