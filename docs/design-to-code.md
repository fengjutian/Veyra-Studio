# 设计 → 代码产物

> 状态：React 组件导出已交付（2026-11-10）。PDF 导出见文末「还没做的」。

## 为什么要有这个

设计的终点不是好看，是**能进工程的代码**。之前 Studio 只能导出 HTML / SVG / PNG：
HTML 是给人看的交付物，PNG 是给人看的图，都不是能直接写进项目里的东西。

「导出 React 组件」把设计稿变成一个能直接用的 `.tsx` 文件：布局、颜色、字号、圆角
全部落在代码里，文字内容与图片地址提成 props。

## 样式只有一份

React 导出**复用 HTML 导出的样式计算**（`html.ts` 的 `nodeStyle`），两边只差序列化：

- HTML 导出把声明拼成 CSS 文本；
- React 导出把同一批声明转成 `style` 对象。

规则写两遍的话，改一处忘一处，导出的组件就会和设计稿长得不一样——而「长得一样」
正是这个功能存在的理由。所以这里是**同一份计算，两种序列化**。

React 侧额外补了三条 HTML 靠全局规则兜底的声明：`box-sizing: border-box`、
`min-width: 0`、`min-height: 0`。React 没有全局选择器（不能写 `* { }`），不补上的话
带描边的节点会大出 2px。

## 什么变成了 prop

**内容是内容，样式是样式**：

- 文字节点的文字 → prop（默认值就是设计稿里的原文）；
- 图片节点的地址 → prop（`<name>Src`）。

有两类文字**不做** prop 化，因为结构与文字是一体的，拆开就丢了信息：

- 带段内样式（`runs`）的文字：拆成字符串 prop 就没法保留分段样式；
- 带段落样式的文字：段落结构本身是内容的一部分。

这两种情况会记一条 `text-prop` 诊断（`support: "approximated"`），不装作做了。

## Token 与主题

Token 绑定仍然导出成 CSS 变量（`var(--token-color-primary)`），变量定义**写在根元素
的 style 上**——CSS 自定义属性会继承，所以子节点里的 `var()` 照样取得到值。这样导出的
组件是自包含的，换主题时改根元素上的变量即可。

## 端到端验收：像素一致

`npm run visual:react:probe` 在真实浏览器里做这件事：

1. 同一份 fixture，走 HTML 导出得到一份静态页面；
2. 走 React 导出得到一段 TSX，用 esbuild 现场编译并渲染；
3. 两张截图**逐像素**比对。

实测结果：**0 / 652800 像素不同**（最大通道差 0）。

单元测试只能断言「生成的代码里有这几条声明」。「长得一样」这件事，只有像素能回答。

## 用法

工作台「导出交付物」分段新增「导出 React」按钮，产出 `${文档名}.tsx`。它与其它导出
入口共用同一套范围（整页 / 选区）与主题。

产物长这样：

```tsx
// 由 AI Design Studio 导出（设计 → 代码）。
// 样式来自设计稿的绝对布局；文字内容与图片地址提成了 props，改 prop 就是改内容。

import type { CSSProperties } from "react";

/** CSS 变量（--token-*）不在 CSSProperties 里，所以补一个模板索引签名。 */
type Style = CSSProperties & { [key: `--${string}`]: string | number };

export interface CanvasFixtureProps {
  /** 节点「title」的文字。 */
  title?: string;
  /** 节点「image」的图片地址。 */
  imageSrc?: string;
  /** 根节点附加的类名。 */
  className?: string;
}

export function CanvasFixture({ title = "画布渲染基线", imageSrc = "data:image/png;base64,…", className }: CanvasFixtureProps) {
  const style: Style = {
    position: "relative",
    overflow: "hidden",
    width: "960px",
    height: "680px",
    boxSizing: "border-box",
  };
  return (
    <div className={className} style={style}>
      <p data-node-id="title" style={{ position: "absolute", left: "24px", … }}>
        {title}
      </p>
    </div>
  );
}
```

## 还没做的

- **PDF 导出没有做**：这一版只交付了 React 组件。PDF 要解决的是「文字怎么进 PDF」
  （内嵌 TrueType 子集）与「打印尺寸怎么定」，不是把图塞进去就完事——后者能交，
  但那是图片型 PDF，文字不可选、不可搜索，和设计工具的 PDF 导出不是一回事。
- **不做双向同步**：产物是单向的导出，代码改了不会回写设计稿。
- **组件实例按展开后的子节点导出**：实例与主组件的关联在产物里丢失（诊断里会说明）。
- **不支持 CSS Modules / Tailwind / styled-components 等多种形态**：目前是内联
  `style` 对象，复制粘贴即可用，代价是没有类名可复用。
