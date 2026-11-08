# 画布内联文本编辑（样式可视化）规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`rich-text.md`、`paragraph-styles.md`、`figma-gap-roadmap.md`、`current-project-status.md`

## 1. 要解决的问题

画布上的文本节点可以双击进入编辑，但编辑的是**一个纯 `<textarea>`**：

```tsx
<textarea className="canvas-text-edit" style={{ fontFamily, fontSize, lineHeight, fontWeight, color }} />
```

它只应用**节点级**样式。于是：

- 段内加粗 / 斜体 / 颜色 / 字号在编辑时**全部看不见**——编辑框里是一段均匀的文字，
  用户不知道哪些字是粗的；
- 列表段落完全看不出是列表：没有标记、没有缩进，编辑时是一堆平铺的行；
- 用户在编辑框里看到的排版与画布上的排版**不一致**（尤其段内字号改变行高时）。

结果是「已实现的能力在编辑时像没实现」——这是最容易让人以为功能坏掉的一种缺口。

## 2. 范围

本轮把编辑态升级为**结构化编辑器**：

- ✅ 段落结构：每个段落一个块，段落之间的换行可见；
- ✅ 段内样式：字重、字形、字号、颜色按 `runs` 渲染（编辑时能看到加粗/变色/改字号）；
- ✅ 段落样式：列表标记（`•` / 编号）与缩进可见，编号与画布一致；
- ✅ 节点级对齐（`textAlign`）应用到段落块；
- ✅ 交互保持不变：`Enter` 提交、`Shift+Enter` 换行、`Esc` 取消、失焦提交；
- ❌ 编辑器内**不**直接加粗/变色（仍走属性面板的选区控件）；
- ❌ 编辑器内**不**切列表类型、**不**用 Tab/Shift+Tab 改缩进（仍走属性面板「段落」小节）；
- ❌ 编辑器内不显示画布上的混合模式 / 阴影 / 模糊等节点级效果。

## 3. 为什么用 contenteditable，而不是「高亮层 + 透明 textarea」

常见做法是两层叠放：底层用 DOM 渲染带样式的文字，顶层是透明的 `<textarea>` 承接输入。
本轮**没有**采用，原因是这个方案里有两个排版系统（DOM 与 textarea），
它们的换行位置、行高、缩进必须**逐像素一致**才不会出现光标错位：

- 段内字号变化 → 底层行高变化 → textarea 行高不变 → 后面所有行错位；
- 列表缩进 → textarea 无法逐段缩进 → 底层有缩进、顶层没有 → 光标横向错位。

要同时支持「段内字号」与「列表缩进」，就必须**只有一个排版系统**——
于是编辑态改成一块 `contenteditable` 区域，段落是 DOM 里的块，标记与缩进都是真实 DOM。
光标、选区、输入法全部由浏览器原生处理，不存在两个排版系统对齐的问题。

## 4. 数据与 DOM 结构

### 4.1 编辑器 DOM

```html
<div class="rich-text-editor" contenteditable="true">
  <div class="rte-paragraph" data-editor-paragraph="0" style="padding-left: 24px">
    <span class="rte-marker" contenteditable="false" data-editor-marker>1.</span>
    <span class="rte-run" style="font-weight: 700">abc</span>
    <span class="rte-run">def</span>
  </div>
  <div class="rte-paragraph" data-editor-paragraph="1">…</div>
</div>
```

- `data-editor-paragraph`：段落序号，提交时按它还原段落顺序；
- `data-editor-marker`：列表标记，`contenteditable="false"` 让光标进不去，
  提交时**按标记忽略**（即使用户把它删了也不影响文本）；
- `data-editor-run`：段内样式片段。

### 4.2 受控 vs 不受控

`contenteditable` 的内容被用户直接改写，React 再用 `children` 渲染回去会**每键都重建 DOM**，
光标随之丢失。因此编辑器**不受控**：

- 挂载时用 `useEffect` 构建一次 DOM；
- 之后 React 不再渲染 children，只在 `onInput` 里读 DOM 更新内部状态；
- 提交时从 DOM 还原文本。

代价：**编辑期间属性面板改动 `runs` 不会立刻反映到编辑器里**（要等下次进入编辑）。
本轮接受这个限制——Figma 那种「编辑器里实时改样式」需要自绘光标与选区，
远超本仓库当前的编辑器能力。

### 4.3 文本还原

提交时的文本从 DOM 反推，规则：

1. 顶层每个段落块 = 一个段落；
2. 块内的 `<br>` = 段内换行（`Shift+Enter` 产生）；
3. 标记元素（`data-editor-marker`）**跳过**；
4. 段落之间用 `\n` 连接。

还原结果就是提交给 `text.patch` 的 `text`。
段内 `runs` 与段落 `paragraphStyles` **不由编辑器产生**——
文字变了但没给新样式时，运行时的 `remapTextRuns()` / `remapParagraphStyles()`
按「字符是否还在」把样式对齐到新文本（段落被合并时样式取存活字符所在的那一段）。

## 5. 组件与纯逻辑的分工

| 文件 | 职责 | 可测性 |
| --- | --- | --- |
| `renderer/rich-text-editor-model.ts` | 纯逻辑：文本 → 段落描述（每段的 run 切片、列表信息）；DOM → 文本 | 纯函数，直接单测 |
| `renderer/text-edit-overlay.tsx` | React 组件：构建 DOM、接管键盘、提交/取消 | jsdom 组件测试 |
| `text-edit.ts` | 键盘规则（`Enter` 提交 / `Shift+Enter` 换行 / `Esc` 取消） | 纯函数，已有测试 |

纯逻辑拆出来的原因：DOM 构建与文本还原是这个功能最容易出错的地方
（少一个 `\n`、标记被算进文本、run 边界切错），必须能不靠浏览器就测。

## 6. 验收

- 编辑器 DOM 与画布一致：段内加粗/斜体/字号/颜色、列表标记与缩进、
  节点级对齐都能在编辑态看到（jsdom 组件测试断言 DOM 结构与样式）；
- 提交时还原出的文本与用户输入一致：
  纯文本、带 run 的文本、列表文本、含段内换行（`<br>`）的文本；
- 标记元素不会被算进文本（删掉标记也不影响提交结果）；
- `Enter` 提交、`Shift+Enter` 换行、`Esc` 取消的规则不变；
- 取消编辑不产生任何命令（revision 不变）；
- 旧文档（无 `runs` / 无 `paragraphStyles`）的编辑行为与升级前一致；
- **真实浏览器实测**（`npm run visual:inline-editor-probe`）：
  浏览器认得段内加粗（计算 `font-weight` 是 700 而不是「DOM 上写了 700」）、
  认得段内颜色、列表标记可见且右对齐、
  **正文起点与画布的 `left` 完全一致**（缩进 24 + 标记区 20 = 44px）、
  插入字符后能从 DOM 还原出文本。

## 7. 已知限制

- 编辑期间属性面板改样式不实时反映到编辑器（下一次进入编辑才生效）；
- 编辑器内不能直接改样式（加粗/变色/列表/缩进都要去属性面板）；
- 编辑态不显示混合模式、阴影、模糊等节点级效果；
- 编辑框自带 1px 边框与 2px 内边距（提示「正在编辑」），因此编辑态文字比画布上的
  文字右移 3px、下移 3px。排版本身（缩进、标记区、换行）与画布一致；
- 浏览器差异：不同浏览器对 `contenteditable` 的段落拆分行为略有不同
  （`Enter` 在本编辑器里被拦截为提交，不依赖浏览器拆分行为）。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `studio-web/test/rich-text-editor.test.ts` | 段落描述（run 切片、列表标记与缩进）、DOM 构建、文本还原、键盘规则 |
| `studio-web/visual/inline-editor-probe.ts` | 真实浏览器：计算样式、标记几何、正文起点与画布一致、能输入 |

探针用 `--dump-dom` 把浏览器排版后的 DOM 抓回来读**计算样式**：
jsdom 没有排版引擎，算不出字号、宽度与行高，「编辑态显示样式」这件事
只有实测才算数。
