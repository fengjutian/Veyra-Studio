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
- **SVG 导出不内联字体**：SVG 引用系统字体，且非浏览器查看器
  （Illustrator / Inkscape）对内联 `@font-face` 支持不一致；
  本轮只在 SVG 侧保持现状；
- 内联的字体让 HTML 体积增加约 33%（base64 的代价）；
- 字体解析只覆盖 `name` / `OS/2` 表，TTC 集合与部分 CJK 字体的族名
  可能读不出来（读不出就回落，不报错）。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-export/test/font-inline.test.ts` | 字体收集、@font-face 生成、阈值、字重回退诊断 |
| `studio-application/test/font-inline.test.ts` | 资产字节 → data URI、内联接线 |
| `studio-web/test/font-metadata.test.ts` | 字体元数据解析与回落 |
| `studio-web/visual/font-inline-probe.ts` | 真实浏览器：导出的 HTML 里字体真的生效 |
