# 资产打包（资源包交付）

> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`、`font-inline.md`、`asset-metadata.md`

## 1. 要解决什么

导出 HTML 时，图片和字体都写成 **data URL** 内联进交付物：

```html
<img src="data:image/png;base64,iVBORw0KGgo…" />
@font-face { src: url(data:font/ttf;base64,…) format("truetype"); }
```

好处是**单文件**：随手就能发出去，对方双击就能看，不会丢图。

代价有三个：

1. **体积涨约 33%**——base64 的编码开销。
2. **字体有 1 MB 内联上限**（`FONT_INLINE_MAX_BYTES`）。中文字体动辄几 MB，
   超限就只能放弃内联并记一条诊断——对方机器上字形会变。
3. **大交付物没法分发**：一份带十几张图的稿子是一个几十 MB 的 HTML，
   邮件附件、代码评审、CI 产物都不友好。

**资产包**是另一条路：把图片和字体拆成独立文件，主文档用**相对路径**引用，
整个目录打成 ZIP 分发。

## 2. 两种策略

|  | 单文件（内联） | 资源包（外链） |
| --- | --- | --- |
| 产物 | 一个 `.html` | 一个 `.zip`（`index.html` + `assets/` + `fonts/`） |
| 体积 | 涨约 33% | 不涨 |
| 字体上限 | 1 MB，超限放弃 | **无上限**（外链文件没有 base64 膨胀） |
| 分发 | 单文件，直接发 | 一个压缩包 |
| 预览 | 可在预览弹窗里看 | **不能**（相对路径要落盘后才解析得了） |

两个入口都在「导出」分段：**导出 HTML**（单文件）与**导出资源包**（ZIP）。

## 3. 包的结构

```
Canvas Harness.zip
├── index.html              主文档
├── assets/
│   └── page-ee20adbb.png   图片原字节
└── fonts/
    └── Inter-400-1a2b3c4d.woff2
```

主文档里的引用是**相对**的：

```html
<img src="./assets/page-ee20adbb.png" />
@font-face { src: url("./fonts/Inter-400-1a2b3c4d.woff2") format("woff2"); }
```

`./` 前缀不是装饰：它保证交付物换个目录打开也对，而且导出器既有的 URL 白名单
本来就接受 `./` 开头的相对路径——**导出器一行都没改**。

### 文件名规则

| 资源 | 文件名 | 规则 |
| --- | --- | --- |
| 图片 | `assets/<名字>-<哈希前 8 位>.<扩展名>` | 名字来自资源名（去掉原扩展名），哈希片段用来避免同名互相覆盖；扩展名按 MIME 走（`image/png` → `.png`） |
| 字体 | `fonts/<族名>-<字重><i?>-<哈希前 8 位>.<扩展名>` | 每个 `(family, weight, style)` 一个文件——同一份资产可能被多个用法退化匹配，而各用法的字符集不同（子集化结果也可能不同），共用一个文件会写出两份不同内容 |

名字里的**路径分隔符、`..`、前导点全部被清掉**（`safePackageFileName`）：
资源名来自文档，可能是用户随手写的，也可能来自别人导出的 JSON，
直接写进包名就能引用到包外的文件。

哈希片段只取安全字符——导入的文档里哈希未必是真正的 SHA-256。

## 4. 实现落在哪

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 导出器 | `design-export/src/font-inline.ts` | `packagedFontFaceCss()`：`@font-face` 的 `src` 指向包内文件而不是 data URI |
| 应用层 | `studio-application/src/asset-package.ts` | 包清单规划（文件名、资源字节、字体 CSS）、`preparePackageAssets` / `preparePackageFontFaces` |
| 应用层 | `studio-application/src/studio-project.ts` | `exportHtmlPackage()`：走同一条 HTML 导出路径，只是资源换成相对路径 |
| 工作台 | `studio-web/src/zip.ts` | 零依赖 ZIP 写入（store，不压缩） |
| 工作台 | `studio-web/src/main.tsx` | 「导出资源包」按钮 |

**导出器本身没有为打包改过一行**：`resolveAsset` 回调返回什么 URL 就是什么 URL，
字体 CSS 是调用方传进去的字符串。打包只是换了一种「URL 从哪来」。

### ZIP 为什么自己写

浏览器不能直接「下载一个目录」，所以包要打成 ZIP。实现选了自己写
（`studio-web/src/zip.ts`，store 模式不压缩）：

- 不引入新依赖（仓库里 CDP 客户端也是零依赖自己写的）；
- 包里的主要内容是 PNG / JPEG / WOFF2——本来就是压缩过的，再压一遍几乎不省；
- 时间戳固定在 1980-01-01：同样的输入必须产出同样的字节，否则回归测试没法比对。

## 5. 限制（说清楚，别假装没有）

- **SVG 交付物没有打包版**。SVG 作为独立文件直接打开时外链可用，但用 `<img>`
  引入时浏览器不允许 SVG 访问外部资源——那会让交付物静默少图。SVG 继续走内联。
- **PNG 交付物没有打包版**。PNG 是光栅化产物，必须把图片读进画布，
  相对路径在光栅化时没有基准。PNG 继续走内联。
- **资源包不能预览**。相对路径要落盘后才解析得了，预览弹窗里只会看到空框。
  预览用的仍是内联版。
- **包里的字体仍会子集化**（超限时裁到导出范围用到的字符），但**不再有 1 MB 上限**。
- 缺字节的资源按「读不到」处理：不进包，导出器产出 `image-asset` 诊断。

## 6. 验收

```bash
npm run visual:package:probe   # 端到端：插真图 → 下载 ZIP → 核对条目与字节
npm run test -w packages/studio-application   # 打包清单与产物
npm run test -w packages/studio-web           # ZIP 结构
```

探针（`studio-web/visual/asset-package-probe.ts`）对着**构建产物**跑真实应用：
用真实的「添加图片」入口插一张真 PNG（fixture 里那两张图用的是假哈希，
仓库里没有字节，打不出有资源的包），在「导出」分段点「导出资源包」，
把下载下来的 ZIP 读回来核对：

- `index.html` 与 `assets/*.png` 都在包里；
- HTML 里**没有** data URL，引用的是 `./assets/…`；
- 包里的图片字节与原文件逐字节相同。

ZIP 读取器（`studio-web/visual/zip-reader.ts`）是**独立于写入器**的第二份实现——
写入器和读取器共用一份代码的话，两边犯同一个错就永远测不出来。
