# 导出物内联字体规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`font-management.md`、`current-project-status.md`、`figma-gap-roadmap.md`

## 1. 要解决的问题

字体管理的上一轮解决了「字体文件随项目走」「缺失字体不静默回退」
（见 `font-management.md`），但**交付物**这一环还是断的：

导出的 HTML 里只有 `font-family:"Source Han Sans SC"`，
**没有字体文件**。对方机器上没装这个字体 → 回退字形 → 交付稿和设计稿字形不同。
这是「画完了、交出去、字变了」这类事故的根因。

PNG 导出不受影响（文字已经光栅化成像素），**HTML 受影响最重**；
SVG 次之（SVG 引用系统字体，不带字形）。

本轮做两件事：

1. **HTML 导出把用到的字体内联进交付物**（`@font-face` + data URI）；
2. **上传字体时解析文件里的真实族名与字重**，不再让用户靠文件名猜。

## 2. 为什么不做子集化（本轮明确不做）

理想做法是「只保留页面用到的字符」——中文字体从 10 MB 压到几十 KB。
但浏览器端没有可靠的纯 JS 方案：

- `subset-font`（harfbuzz wasm）**是 Node-only**：内部用 `fs` 读 wasm、`Buffer`、
  `require.resolve`，浏览器打包直接失败。
- `fonteditor-core` 的 `write({ subset })` 实测**不裁字形**：
  Arial 1,045,720 字节 → 只保留 8 个字符后仍是 365,520 字节，
  头是合法 TTF（`00010000`）但 glyf 基本没变小。
- `fontkit` 的子集编码需要 brotli wasm，浏览器端要额外处理 wasm 装载。

把「实测不可靠」的能力写进交付链路，比不做更糟——用户会拿到一个
「看起来内联了字体、实际还是有几十 MB」的文件。

**本轮的取舍**：内联**完整**字体文件，并用阈值挡住不可接受的大文件。

## 3. 内联规则

### 3.1 哪些字体要内联

只有**文档声明过、且有字体文件**的族名才内联：

```
document.fonts[] 里 family === 节点 fontFamily 且带 assetId 的声明
```

系统字体（没有 assetId）不需要内联——对方机器上装了就有，
没装则是设计方本来就该处理的字体缺失问题（现有缺失字体诊断已覆盖）。

匹配节点的 `fontWeight` / `fontStyle`：

- 优先精确匹配（`weight ?? 400` 与 `style ?? "normal"`）；
- 找不到精确匹配时退回同族名的**任意**一条声明（并记一条 `approximated` 诊断，
  说明「字重没对上，导出物里用的是这条声明的字体」）。

一个 `(family, weight, style)` 一条 `@font-face`——
同一族名的多个字重要分别声明，否则浏览器只会按 400/normal 匹配。

### 3.2 体积阈值

内联会让 HTML 体积增加约 33%（base64）。所以：

- 字体文件 **≤ 1 MB** → 内联；
- **> 1 MB** → **不内联**，记一条诊断，明确写清后果与建议：
  「字体「思源黑体」有 12.4 MB，超过 1 MB 的内联上限，导出物没有内联它，
  打开时会走回退字形。请先子集化后再上传。」

阈值是**可配置的常量**，不是魔法数字：1 MB 的字体 base64 后约 1.33 MB，
单个 HTML 交付物还在可接受范围。

### 3.3 CSS 形态

```css
@font-face {
  font-family: "Source Han Sans SC";
  src: url(data:font/woff2;base64,…) format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

- `font-display: swap`：字体解码期间先用回退字形显示，不出现白屏；
- data URI 的 MIME 取资产自己的 MIME（`font/woff2` / `font/woff` /
  `font/ttf` / `font/otf`），`format()` 与之对应；
- 族名里的引号要转义（`cssString`）。

## 4. 上传时解析真实族名与字重

现在的上传弹窗默认用**文件名猜**族名（`fontFamilyFromFileName`），
字重固定 400。猜错的后果很具体：族名写错 → 文本节点引用不到这份字体 →
它变成「缺失字体」，白上传。

本轮用 `fonteditor-core` 读字体文件内部的名字表：

| 取值 | 来源 |
| --- | --- |
| 族名 | `name.fontFamily`（name 表 nameID 1） |
| 字重 | `OS/2.usWeightClass`（缺省 400） |
| 字形 | `OS/2.fsSelection` 的斜体位 + `head.macStyle` 的斜体位 |

解析结果**只用于预填弹窗**，用户仍可改（字体文件的族名有时不适合当设计稿里的族名）。
解析失败（格式不支持、文件损坏）就回落到文件名猜测，**不报错**——
上传流程不该因为解析失败被卡住。

`fonteditor-core` 用**动态 import** 加载：它是几百 KB 的解析库，
只有真的去上传字体时才需要，不该拖慢首屏。

## 5. 数据流

```
studio-web「导出 HTML」
  → StudioProject.exportHtmlWithAssets()
      → createFontFaceResolver(repository, document, { pageId, nodeIds })
          → 读字体资产字节 → 生成 @font-face 字符串 + 诊断
      → exportPageToHtml(document, { …, fontFaces })
          → 把 @font-face 写进 <style>
```

`exportPageToHtml` 本身保持**同步**：字体准备是异步的（读资产），
在调用方（`exportHtmlWithAssets`）里做完再传进来。

## 6. 验收

- 导出 HTML 里出现 `@font-face`，族名与 CSS 里的 `font-family` 一致，
  带 `font-weight` / `font-style` / `font-display`；
- 同一族名的多个字重生成多条 `@font-face`；
- 系统字体（无 assetId）不产生 `@font-face`，也不产生诊断；
- 超过阈值的字体不内联，且有诊断写清后果；
- 字重找不到精确匹配时有 `approximated` 诊断；
- 旧文档（没有 `document.fonts`）导出产物**逐字不变**；
- **真实浏览器实测**：把导出的 HTML 交给 Chrome 打开，
  页面里的 `@font-face` 真的被加载并生效（`document.fonts.check` 为真、
  文字宽度与回退字体不同）——这是「交付物自带字体」的唯一硬证据；
- 上传字体时能读出真实族名与字重；读不出时回落到文件名猜测。

## 7. 已知限制

- **不做子集化**：大字体只能整份内联或放弃（见 §2）；
- 内联的字体让 HTML 体积增加约 33%（base64 的代价）；
- 字体解析只覆盖 `name` / `OS/2` 表，TTC 集合与部分 CJK 字体的族名
  可能读不出来（读不出就回落，不报错）。

## 8. SVG 导出的字体内联

### 8.1 问题

SVG 交付物和 HTML 一样只带 `font-family`：**不带字形**。
对方机器上没装这个字体 → 回退字形 → 交付稿和设计稿字形不同。
上一轮把 SVG 排在「次之」并且明确不内联，理由是「非浏览器查看器对内联
`@font-face` 支持不一致」。

### 8.2 先实测，再决定

「支持不一致」是一句没有证据的话，所以这一项**先探针、后实现**。
探针（Chrome headless，`Press Start 2P`，48px，样例 `Handgloves 0123 ABC`）
测三种加载场景，判据是「有 / 无 `@font-face` 时文字宽度是否不同」：

| 场景 | 无 `@font-face` | 有 `@font-face` | 结论 |
| --- | --- | --- | --- |
| 顶层 `.svg` 文档（直接打开） | 456 px | **912 px** | 生效 |
| HTML 里内联 `<svg>` | 456 px | **912 px** | 生效 |
| `<img src="…svg">` | 456 px | **912 px** | 生效（截图肉眼可见像素字体） |

912 = 19 字 × 48 px，正是 Press Start 2P 的等宽步进；456 是回退字体的宽度。
所以**浏览器里 SVG 的内联 `@font-face` 是可靠的**。

> ⚠️ 第一版探针给出的结论是**相反的**（「没生效」）。两个探针自身的 bug：
> ① `.svg` 是 XML，脚本里的 `&&` 让 XML 解析失败，脚本**根本没执行**，
>    于是拿不到测量值；
> ② `font-family="Press Start 2P, monospace"` 没加引号，
>    `2P` 不是合法的 CSS 标识符，整条声明作废。
> 修掉之后结论反转。**探针本身也要被验证**——「读数是空」不等于「读数相同」。
>
> 探针留在 `packages/studio-web/visual/svg-font-probe.ts`（一次性脚本不入库）。

### 8.3 规则

SVG 侧与 HTML 侧**共用同一套字体准备逻辑**（`prepareFontFaces`）：
同样的收集、同样的匹配、同样的 1 MB 阈值、同样的子集化、同样的诊断。
差别只有「规则写到哪里」。

```xml
<svg xmlns="http://www.w3.org/2000/svg" …>
  <title>…</title>
  <style type="text/css">
  @font-face { … }
  </style>
  <style>          <!-- token 变量，旧文档逐字不变 -->
  :root { … }
  </style>
  …
</svg>
```

- 字体规则放在**根 `<svg>` 下、token `<style>` 之前**：
  字体的声明要先于使用它的规则；
- 单独一个 `<style>` 元素（而不是与 token 规则合并）：
  没有字体的旧文档导出结果必须**逐字不变**，合并会让那部分产物也变；
- CSS 文本是 **XML 文本**，`&` 与 `<` 要转义（base64 字母表里没有这两个字符，
  但转义照做——规则文本不该依赖「恰好没有特殊字符」）。

### 8.4 限制

- **非浏览器查看器仍然不行**：Illustrator / Inkscape / Figma 导入 SVG 时
  不执行 CSS `@font-face`，那些工具里看到的仍是回退字形（或它们自己的
  字体替换规则）。这是工具行为，不是导出物的问题——
  导出物在浏览器里是自洽的；
- 体积代价与 HTML 相同（约 +33%），阈值同样适用；
- SVG 里没有「超限就不内联」的降级路径：超限字体不内联 + 记诊断，
  与 HTML 一致。

## 9. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-export/test/font-inline.test.ts` | 字体收集、@font-face 生成、阈值、字重回退诊断、SVG 侧写出 `<style>` 与 XML 转义 |
| `studio-application/test/font-inline.test.ts` | 资产字节 → data URI、内联接线（HTML 与 SVG 两条路径） |
| `studio-web/test/font-metadata.test.ts` | 字体元数据解析与回落 |
| `studio-web/visual/font-inline-probe.ts` | 真实浏览器：导出的 HTML 里字体真的生效 |
| `studio-web/visual/svg-font-probe.ts` | 真实浏览器：导出的 SVG 里字体真的生效（三种加载场景） |
