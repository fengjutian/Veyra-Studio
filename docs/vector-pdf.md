# 矢量 PDF：文字可选

## 1. 这一版导出的是什么

**每页一份矢量内容**：形状是 PDF 路径，文字是 PDF 文字对象。字体以 TrueType 子集
内嵌（`Type0` / `Identity-H` + `CIDFontType2`），并附一份 `ToUnicode` CMap——
所以交付方拿到的是**能选中、能搜索、能复制**的 PDF。

与图像型 PDF（`exportRastersToPdf()`）各有用处：

| | 图像型 | 矢量型 |
| --- | --- | --- |
| 文字 | 像素，不可选、不可搜 | 文字对象，可选、可搜、可复制 |
| 体积 | 大（整页位图） | 小（只嵌用到的字形） |
| 缩放 | 放大糊 | 任意缩放都清晰 |
| 图片 | 有 | **没有**（这一版没做位图解码） |
| 渐变 / 投影 / 蒙版 | 有（因为就是画出来的） | 渐变按第一档近似；投影与蒙版没有 |

两套并存，按交付需求选：带图的稿子用图像型，要文字可搜的稿子用矢量型。

## 2. 内嵌字体是怎么做的

PDF 里放一个字体要五个对象：

1. `FontFile2`——字体本体（TrueType 子集，`/FlateDecode` 压缩）；
2. `FontDescriptor`——字体的度量（外框、倾斜角、上伸下伸、大写高度）；
3. `CIDFontType2`——按**字形编号（GID）**描述字体，带 `/W` 数组（每个字形多宽）；
4. `ToUnicode`——GID → Unicode 的 CMap；
5. `Type0`——顶层字体，`/Encoding /Identity-H`（文字里写的就是 GID）。

两个关键决定：

- **CID = GID**（`/CIDToGIDMap /Identity`）。这样文字在 PDF 里直接写成字形编号的
  十六进制，不用再维护一张 CID → GID 的映射表。
- **`ToUnicode` 不能省**。没有它，PDF 里的字虽然显示正常，但读者按 Ctrl+F 搜不到、
  复制出来是一串乱码——「文字可选」最关键的一步就在这里。

字体的**字形映射**（Unicode → GID）与**前进宽度**（排版要按真实宽度算居中、右对齐）
由 `design-export/src/truetype.ts` 的最小 sfnt 解析器提供：读 `cmap`（格式 0/4/6/12）、
`hmtx`/`hhea`、`head`、`maxp`、`post`、`OS/2`。

## 3. 文字排版

与 SVG 导出保持同一条路：

- 每个段落按**一行**排（段落样式只解决缩进与标记，不解决折行——与 SVG 一致）；
- 行顶 = 盒子顶部 + 行号 × 行高；基线 = 行顶 + 上伸比例 × 字号；
- 水平对齐按**真实字宽**算：居中往右偏半个字宽，右对齐贴右边缘；
- 段内样式（`runs`）按区间切分，每段可以有自己的字号、字重、颜色。

## 4. 字体从哪来

PDF 只能内嵌 **sfnt**（TrueType / OpenType）。`woff` / `woff2` 是压缩容器，PDF 不认。

- 文档里**上传过**的字体：走 `prepareVectorPdfFonts()` 读出字节；有子集化能力
  （HarfBuzz wasm）时先裁到只用到的字符，顺带把压缩容器转成 sfnt。
- **系统字体**（用户没上传的）：没有字节，只能退到 PDF 内置的 Helvetica——
  字形会不一样，导出诊断里会明确写出来。

「字形对不上」这件事必须让人看见：交付一份悄悄换了字形的 PDF 比报错更糟。

## 5. 坐标

PDF 的原点在左下、向上；设计稿的原点在左上、向下。导出时整页套一个变换：

```
q
0.75 0 0 -0.75 0 页面高度 cm
```

设计坐标直接用。文字要额外把字形翻回来（`1 0 0 -1 x y Tm`），否则字是镜像的。

## 6. 已知限制

- **图片没有内嵌**。要把 PNG/JPEG 解成位图再塞进 PDF，这一版没做；导出诊断里会
  逐条报 `pdf-vector-image`（`unsupported`）。带图的交付物用图像型 PDF。
- **蒙版不生效**（`pdf-vector-mask`，`unsupported`）。
- **渐变按第一档颜色近似**（`pdf-vector-gradient`，`approximated`）。
- **投影不画**（`pdf-vector-shadow`，`approximated`）。
- **混合模式按普通混合**（`pdf-vector-blend`，`approximated`）。
- **不换行**，与 SVG 导出同一条限制。
- 内嵌的字体必须是 sfnt；CFF（OTTO）字体的嵌入方式不同（`CIDFontType0` +
  `FontFile3`），这一版没做。

## 7. 验收

- 单元测试（`design-export/test/pdf-vector.test.ts`）：文件结构（`Type0` /
  `Identity-H` / `ToUnicode` / `FontFile2`）、内容流里确实有路径与 `Tj`、
  没有字体时退到 Helvetica 并记诊断、CMap 内容、颜色解析、子集标记。
- 单元测试（`design-export/test/truetype.test.ts`）：字形映射、前进宽度、
  非 sfnt 明确报错。
- 端到端：用 PyMuPDF 打开产物，`get_text()` 能取出原文（证明 `ToUnicode` 生效），
  渲染出来的 PNG 里文字是正着的、形状位置正确。
