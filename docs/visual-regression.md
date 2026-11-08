# 视觉回归体系：借鉴 desigma-diff 的能力模型

> 建立日期：2026-11-08
> 来源：评审 [deepfounder-ai/desigma](https://github.com/deepfounder-ai/desigma)（Rust 写的 Figma 替代品）的过程中发现的可借鉴点。
> 相关文件：`packages/design-export/visual/png.ts`、`packages/design-export/visual/suite.ts`、`visual-suite.json`

## 1. 为什么看 desigma

desigma 的 `desigma-diff` 是本项目视觉回归的直接对标物：同样是「渲染一张图 → 和基线逐像素比 → 超阈值就失败」。
但它比本项目原��的实现多了三样东西，而这三样正好是本项目缺失的：

| desigma-diff 的能力 | 本项目原状态 | 是否借鉴 |
| --- | --- | --- |
| 抗锯齿边缘像素豁免（`--no-aa` 可关） | `diffImages` 只有 `tolerance`（单通道差值） | **借鉴** |
| 区域遮罩（`--ignore x,y,w,h`） | 无 | **借鉴** |
| suite manifest（多 fixture 批量）+ HTML 报告 | 每个脚本只跑单个 fixture | **借鉴** |

参考链接：
- `crates/desigma-diff/`（源码）
- `CONTRIBUTING.md` 的 "Screenshots and pixel diffs" 一节（用法与取舍说明）
- https://github.com/deepfounder-ai/desigma

## 2. 明确不借鉴的部分

评审时发现 desigma 在若干方面**弱于**本项目，这些不能反向照搬：

| 方面 | desigma | 本项目 | 结论 |
| --- | --- | --- | --- |
| 文档格式版本 | `.desigma` 无 version 字段，靠散落的 `migrate_text()` 硬编码补丁 | `design-schema/src/migrate.ts` 有 `CURRENT_SCHEMA_VERSION = 4` + 迁移链 + `migrations` 审计记录 | **本项目更强，保持现状** |
| 性能基准 | 无任何 benchmark（README 却声称"5,000 层不卡帧"） | `bench:layout` / `bench:export` / `bench:paint` 三个预算门禁，且 `check:budgets` 进 CI | **本项目更强，保持现状** |
| 视觉回归进 CI | CI 里完全没用 `desigma-diff`（工具建好了却不接） | `check:visual` 已在 CI（有 `continue-on-error`，见 §6） | **本项目更强，保持现状** |
| lint 进 CI | clippy `-D warnings` + fmt 阻塞 | 有 `eslint.config.mjs`，但 CI **从不跑 lint** | **借鉴（见 §5）** |
| 贡献文档的包地图 | CONTRIBUTING 的 crate map 漏了 8/16 个 crate | AGENTS.md 无包地图 | 本轮不改，见 §7 |

**教训**：desigma 是「工具链完整但没接进 CI」的典型样本——这恰好说明**建了工具不等于有了回归网**。
本项目要避免同样的坑：suite 建好后必须接进 CI（见 §5）。

## 3. 抗锯齿豁免（AA exemption）

### 问题

基线是"本机浏览器 + 本机字体"的产物。跨机器比，斜边文字和圆角的灰阶舍入可能差 1 个色阶。
原来的 `tolerance` 参数能兜住一部分，但默认 `tolerance = 0`，等于没兜——CI 上因此长期挂 `continue-on-error`（见 §6）。

### 做法

`diffImages` 新增 `ignoreAntiAlias`（默认 `true`）：

- 像素若在 8 邻域中存在亮度差 > 64 的邻居，说明它跨越了前景/背景边界；
- **且**该像素的差异幅度本身也 ≤ 64；

两条同时满足才降级为 AA 差异（差异图标橙），否则标红计入失败。

### 为什么两个条件都要

只有"是否在边缘"不够。孤立的一个亮像素周围全是黑，它同样处于边缘，
但那是一次**真实的内容改动**。第一版实现只判边缘，结果真实改动被误豁免——
由 `packages/design-export/test/png.test.ts` 的用例暴露出来。
加上幅度上限后：跨机器的灰阶舍入（幅度小）被豁免，文字位移/颜色变化（幅度大）仍标红。

### 参数

```ts
diffImages(left, right, {
  tolerance: 0,          // 单通道允许差值，原有
  ignoreAntiAlias: true, // 抗锯齿豁免，默认开
  ignoreRegions: [...],  // 完全忽略的区域
});
```

## 4. 区域遮罩（ignore regions）

用于屏蔽每次渲染都不同的动态内容（时钟、随机头像、光标）。
这些区域**完全不参与差异统计**（`ignoredPixels` 单独计数），而不是提高阈值。

```json
{
  "name": "dashboard-with-clock",
  "ignoreRegions": [{ "x": 820, "y": 40, "width": 120, "height": 32 }]
}
```

坐标是 CSS 像素，原点在左上角。

## 5. suite manifest + HTML 报告

### 为什么需要

单个 fixture 只能证明"这一张图没变"。多个 fixture 散落在不同脚本里，
CI 失败时无法一眼看出"这次改动影响了哪几张图"，只能人肉翻日志。

desigma-diff 的 `desigma-diff suite path/to/manifest.json` 提供了一个 manifest 驱动的批量入口，
跑完写一份 HTML 报告。本项目按同样的模型实现。

### 用法

```bash
npm run visual:suite:baseline   # 重新生成所有基线（明确执行才会覆盖）
npm run visual:suite:check      # 渲染并与基线比较，任一用例超阈值退出 1
npm run visual:suite:check -- --manifest=visual-suite.json --require-browser
```

manifest 在仓库根 `visual-suite.json`：

```json
{
  "cases": [
    {
      "name": "export-page",
      "html": "packages/design-export/test/golden/page.html",
      "baseline": "packages/design-export/test/golden/page.png",
      "diff": "packages/design-export/test/golden/page.diff.png",
      "width": 960,
      "height": 680,
      "threshold": 0.005
    }
  ]
}
```

字段说明：

- `name`：用例名，出现在报告里，必须唯一；
- `html` / `baseline` / `diff`：相对 **manifest 所在目录**解析；
- `threshold`：允许的差异像素占比，默认 0.5%；
- `tolerance` / `ignoreAntiAlias` / `ignoreRegions`：透传给 `diffImages`。

### 报告

输出到 `.artifacts/visual-suite/report.html`（**绝对路径**锚到仓库根，避免相对路径随工作目录漂移），
含每个用例的通过/失败、差异占比、AA 豁免数、忽略像素数，以及差异图缩略图。

差异图配色：红 = 真实差异，橙 = AA 豁免，灰 = 忽略区域。

### 单个用例失败不中断整批

`runCase` 返回结果而不抛异常，坏掉的用例记为 `error` 并继续跑下一个。
否则报告里只剩第一个坏掉的用例，看不出全貌。

## 6. CI 现状与后续

`.github/workflows/studio-ci.yml` 的 `visual` job 目前是 `continue-on-error: true`，
理由写在 workflow 注释里：Linux runner 上像素差异来自字体，不是代码。

这是**诚实的现状**，但也意味着视觉回归目前只是参考信号。推进顺序：

1. **先做**：CI 加 `lint` job（eslint 从未在 CI 跑过，见 §7）；
2. **再���**：把 `visual:suite:check` 接进 CI 的 visual job，让 suite 的 HTML 报告作为
   CI artifact 上传——即使 job 不阻塞，报告也能让人直接看到"哪张图变了"；
3. **最后**：等基线在 Linux runner 上稳定（或引入容器化的固定字体环境），
   再考虑去掉 `continue-on-error`。

**不要**为了让它变绿而直接放宽 `threshold`——那等于把回归网拆了。
先用 AA 豁免和区域遮罩把**误报**消掉，剩下的是真问题。

## 7. 尚未处理

- **AGENTS.md 缺包地图**。desigma 的 CONTRIBUTING crate map 漏了 8/16 个 crate，
  新人找 crate 会直接扑空。本项目 AGENTS.md 的 "Architecture Rules" 只列了
  `schema/`、`packages/core/`、`packages/adapter-figma/` 三个子目录规则，
  没有 11 个 package 的职责一览表。值得补，但属于文档工作，本轮未做。
- **MCP 工具粒度**。desigma 的 MCP 有 23+ 个细粒度工具（`desigma_create_component` 等），
  本项目 Studio MCP 只有 3 个（`design.read` / `design.preview` / `design.apply`）。
  本项目的设计是「命令数组 + 统一入口」，粒度更粗但对 agent 更规整，
  **不照抄 desigma**。desigma 那边正在补同样的工具（见其 issue #65），
  方向上是收敛的。

## 8. 阴性对照

`packages/design-export/visual/aa-guard-probe.ts` 是一个判定逻辑的自我验证探针，
证明这套 AA 豁免**不是恒真**：

```bash
npx tsx packages/design-export/visual/aa-guard-probe.ts
```

它验证四件事：

1. 抗锯齿级的边缘灰阶差 → 豁免（`differentPixels === 0`）；
2. 孤立亮像素（真实改动）→ 必须被抓出来；
3. 大面积位移 → 必须被抓出来；
4. 忽略区域外的真实改动 → 仍被抓出来。

**为什么需要它**：放宽阈值类改动天然有"把失败调没"的风险。
只有同时证明"该豁免的豁免了"和"不该豁免的没被豁免"，这套判定才有意义。
