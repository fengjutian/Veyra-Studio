# 跨平台字体度量基线

> 文档状态：生效中的实现规格
> 建立日期：2026-11-09
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.4.0` / `0.7.0` / `0.9.0`）、`font-management.md`

## 1. 为什么要有它

文本宽度由**宿主字体引擎**决定：同一段文字在 Windows 的 Chrome 与 macOS 的
Safari 上宽度不同。宽度一变，hug 文本节点的尺寸变、换行点变、导出的 HTML 与
SVG 里文字落的位置也变——**画布与交付物对不上**，而这是设计工具最不能出的错。

已有的像素回归基线（`visual:check` / `visual:canvas:check`）也依赖字体，但它只
给出结论："像素不一样了"。字体度量基线补的是**原因**：把度量单独拆出来做基线，
差异落在具体的样例上，能说出是哪个宽度、哪个换行点变了。

## 2. 形态

```
design-layout/src/font-baseline.ts     样例集 + 基线数据结构 + 比较逻辑（纯函数）
studio-web/harness/font-baseline.ts    浏览器入口：用编辑器同一条测量路径量一遍
studio-web/visual/font-baseline.ts     采集脚本：打包 → headless 抓 DOM → 比较/更新
studio-web/visual/font-metrics.json    基线文件（入库）
```

### 2.1 基线文件

```json
{
  "environment": {
    "os": "win32",
    "osRelease": "win32 10.0.26200",
    "browser": "Chrome 156.0.0.0",
    "userAgent": "Mozilla/5.0 …",
    "generatedAt": "2026-11-09T06:53:11.566Z"
  },
  "cases": [
    { "id": "latin-400-14", "text": "The quick brown fox…", "fontFamily": "Inter",
      "fontSize": 14, "fontWeight": 400, "width": 301.718, "height": 20, "lines": 1 }
  ]
}
```

**平台指纹是基线的一部分**：换台机器跑 check 时，输出会先说清"基线来自
Windows/Chrome 156，当前是 macOS/Safari 18"，再报差异。这样平台差异是**可解释的**，
而不是一句含糊的"不一致"。

### 2.2 样例集

固定 10 个样例（`fontBaselineCases()`），挑样例的原则是**差异最大**：

| 维度 | 样例 |
| --- | --- |
| 拉丁文 | `latin-400-14` |
| 粗体（同族名宽约 5–6%） | `latin-700-14` |
| 纯中文（全宽） | `cjk-400-14` |
| 中英数字混排 | `mixed-400-16` |
| 斜体 | `italic-400-16` |
| 字距 | `spacing-05-16` |
| 拉丁文换行（宽 200） | `wrap-latin-200` |
| 中文换行（宽 120） | `wrap-cjk-120` |
| 衬线字体族 | `serif-400-18` |
| 等宽字体族 | `mono-400-13` |

少一个维度，就会漏掉一类跨平台漂移。

### 2.3 测量必须走编辑器那条路

采集页面里用的是 `createBrowserTextMeasurer()`（canvas `measureText`），**与编辑器
画布用的是同一个模块**。理由很直接：基线测的是"画布实际会看到的宽度"，用另一条
测量路径（哪怕更准）测出来的差异不是画布的差异。

确定性估算器（`createEstimateTextMeasurer()`）在这里没有用：它在任何机器上结果
都一样，测不出跨平台差异。

## 3. 判定纪律

| 情况 | 判定 |
| --- | --- |
| 宽度差 ≤ 0.5px | 通过（同一台机器上 canvas 度量有零点几像素抖动） |
| 宽度差 > 0.5px | 差异 |
| 行数变了 | **差异**（零容差）：换行点变了，导出物的行数与 hug 高度都跟着变 |
| 高度差 > 0 | 差异 |
| 宽度或高度非有限（NaN / null） | **差异**：不是"一致"，是"没测到" |
| 样例只在一边有 | 缺失，报出来 |

最后一条是踩过的坑：早期版本行高缺失导致高度算成 `NaN`，而 `NaN === NaN` 在
JavaScript 里成立，于是一份全是 `NaN` 的基线被判成"完全一致"。现在**采集阶段**
就拒绝非有限值（"字体或行高没准备好，基线不可信"），比较阶段也把非有限值算作
差异，两道闸。

## 4. 用法

```bash
npm run visual:font:baseline          # 采集当前机器并写入基线
npm run visual:font:check              # 与基线比较，超容差即失败
npm run visual:font:check -- --require-browser   # CI 里让缺浏览器明确失败
npm run visual:font:check -- --width-tolerance=1  # 放宽宽度容差
```

- **找不到浏览器**：默认跳过并说明原因；`--require-browser` 让 CI 明确失败。
- **换机器**：先看输出里的"平台不同"提示，再判断差异是预期的还是漂移；确认后用
  `visual:font:baseline` 更新基线。**不要**把别的平台的基线当成自己的。
- 与像素回归的关系：像素基线仍然绑定本机字体（`check:visual` 不进版本门槛），
  字体基线解释它背后的度量差异。

## 5. 验收

- 纯函数（`design-layout/test/font-baseline.test.ts`）：一致 / 超容差 / 行数变化 /
  非有限值 / 缺失 / 按 id 对齐 / 平台差异描述 / 样例集覆盖度。
- 采集脚本（`studio-web/test/font-baseline.test.ts`）：从渲染后的 DOM 里取报告
  （含 HTML 实体还原）、从 user agent 认浏览器版本。
- 实跑：`npm run visual:font:baseline` 后再 `npm run visual:font:check` 应完全一致。

## 6. 已知限制

- **只覆盖采集时的那台机器**：仓库里存的是一份基线（当前是 Windows + Chrome）。
  macOS / Linux / Firefox / Safari 的基线要各自采集；跨平台 CI 需要把各平台的
  基线文件都入库并按平台选择。
- **Inter 可能没装**：本机没有 Inter 时会走回退栈，量到的是回退字形的宽度——
  这正是基线要记录的事实，但换一台装了 Inter 的机器就会不一致。
- **不覆盖网页字体**：文档里上传的字体（`document.fonts`）走 FontFace 注册，
  基线不涉及；网页字体的度量由 `prepareFonts()` 等待加载完成后再测。
- **只有 10 个样例**：覆盖的是差异最大的维度，不是全部字形组合。
