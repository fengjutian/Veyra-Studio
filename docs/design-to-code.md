# 设计 → 代码产物

> 状态：React 组件导出、PDF 导出已交付（2026-11-10）。矢量 PDF（文字可选）未做。

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
// 由 Veyra 导出（设计 → 代码）。
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

## PDF 导出（图片型）

`design-export/src/pdf.ts` 是一个**零依赖**的 PDF 写入器：PDF 本身就是文本格式的
对象表，几百行就能写完，不需要任何库。

### 导出的是什么

**每一页一张位图**。这是 PDF 里最不容易出错的一种形态：页面尺寸、缩放、色彩都由
PDF 自己保证，设计稿长什么样，PDF 里就是什么样。

代价说清楚：**文字不可选、不可搜索**（它是像素）。

### 几个关键决定

- **位图 2×、页面尺寸不变**：位图按 2× 渲染（打印更清楚），但页面尺寸仍按设计
  尺寸换算（96dpi → 72dpi，960×680 像素 = 720×510 点 ≈ 横向 Letter）。清晰度上去了，
  尺寸没变。
- **压缩用原生 `CompressionStream("deflate")`**：浏览器与 Node 都有，输出正好是
  PDF 的 `/FlateDecode` 要的 zlib 流。没有压缩流的环境退化成不压缩，产物照样合法。
- **确定性**：没有时间戳、没有随机 id、对象顺序固定——同样输入产出同样字节。
- **中文标题用 UTF-16BE 十六进制串**：PDF 的 literal string 只按 PDFDocEncoding
  解码，中文会变乱码。

### 渲染路径与 PNG 导出同源

工作台里的 PDF 导出走的是**同一条渲染路径**：先 SVG 导出，再画进 canvas。所以
PDF 里看到的就是画布上看到的那张图，不会出现「HTML 一套、PDF 一套」。

### 验收

- **单元测试**：文件头、xref 偏移、页数、页面尺寸、图像样本解压后逐字节相同、
  半透明合成到白底、同样输入同样字节、中文标题编码。
- **端到端探针**（`npm run visual:pdf:probe`）：真实应用里导入 fixture → 点
  「导出 PDF」→ 等下载完成 → 把 PDF 里的图像流解出来，确认里面**有设计稿的
  accent 颜色**（`#f87171`）而不是一张白纸。
- **人工看**：用 PDF 阅读器打开产物，确认方向没翻、内容完整（已核对：卡片、标题、
  圆角块、椭圆、裁剪、图片占位、右对齐文字都在，方向正确）。

### 页面范围

PDF 天然是多页的，所以「导出 PDF」导的是**整份文档的所有页面**，不受顶栏
「整页 / 选区」范围影响（按钮的提示里写明了）。

## 还没做的

- **矢量 PDF 没做**：这一版交付的是**图片型 PDF**——每页一张位图，文字不可选、
  不可搜索。矢量 PDF 要处理字体子集（内嵌 TrueType）、字形映射（CID）、
  文本排版与行盒，产出的 PDF 才谈得上「能选能搜」；那是另一条路，本版没做。
- **不做双向同步**：产物是单向的导出，代码改了不会回写设计稿。
- **组件实例按展开后的子节点导出**：实例与主组件的关联在产物里丢失（诊断里会说明）。
- **不支持 CSS Modules / Tailwind / styled-components 等多种形态**：目前是内联
  `style` 对象，复制粘贴即可用，代价是没有类名可复用。
