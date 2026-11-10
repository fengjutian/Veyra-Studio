# 跨浏览器像素基线

> 文档状态：生效中的实现规格
> 建立日期：2026-11-10
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.7.0`）、`font-baseline.md`、`visual-regression.md`

## 1. 为什么要有它

已有的画布像素基线只有一份，绑死「本机 + 本浏览器 + 本机字体」。换台机器、换个
浏览器，它只会说一句"像素不一样了"——但差异到底来自**渲染回归**、**浏览器内核**
还是**字体**，它分不出来。

跨浏览器像素基线把这件事拆成两层：

- **基线按引擎 + 平台分目录存放**，每份基线自带**指纹**：引擎、家族、版本、系统、
  字体集摘要、视口、DPR。
- **比较先比指纹，再比像素**。字体集摘要不同就直接说「基线不可比」；引擎 / 平台
  不同就不是同一份基线，根本不该拿来比。

这样"哪台机器、哪个浏览器、哪套字体"成为基线的一部分，而不是失败之后再去猜的
借口。

## 2. 形态

```
design-layout/src/font-baseline.ts        fontSetDigest()：字体度量 → 稳定摘要
design-export/src/cross-browser.ts        机制层：路径布局、选基线、指纹比较、清单读写（纯函数）
design-export/visual/engines.ts           引擎适配器：chromium / firefox / webkit
studio-web/src/font-baseline-probe.ts     字体指纹采集（编辑器同一条测量路径）
studio-web/harness/main.ts                画布 harness：额外报告 user agent 与字体指纹
studio-web/visual/cross-browser.ts        采集 / 检查脚本
studio-web/visual/baselines/manifest.json 基线清单（入库）
studio-web/visual/baselines/<引擎>/<平台>/<家族>-<版本>/canvas.png
```

### 2.1 清单

```json
{
  "version": 1,
  "baselines": [
    {
      "scene": "canvas",
      "engine": "chromium",
      "family": "Chrome",
      "version": "157.0.0.0",
      "platform": "win32",
      "image": "chromium/win32/chrome-157.0.0.0/canvas.png",
      "fingerprint": {
        "engine": "chromium", "family": "Chrome", "version": "157.0.0.0",
        "platform": "win32", "osRelease": "win32 10.0.26200",
        "userAgent": "Mozilla/5.0 … HeadlessChrome/157.0.0.0 …",
        "fontDigest": "e991a78a:10",
        "viewport": { "width": 960, "height": 680 },
        "deviceScaleFactor": 1
      },
      "collectedAt": "2026-11-10T06:29:16.115Z"
    }
  ]
}
```

清单损坏会**报错**而不是当成空清单：当成空清单，脚本会报"未采集"，看起来像缺基线，
实际是文件坏了——两者的处理完全不同。

重新采集是**替换**（身份 = 场景 + 引擎 + 平台 + 家族），不是追加，否则清单会攒下
一串过期条目。

### 2.2 字体集指纹

`fontSetDigest()` 把 10 个固定样例的度量压成一个短摘要（宽度按 0.1px 取整、行数按
整数）。它回答的是「这台机器现在的字体，和采集基线时是不是同一套」。

- 宽度按 0.1px 取整：同一台机器上 canvas 度量有零点几像素的抖动（GPU / 光栅化
  后端不同），那是噪声，不是字体换了。
- 行数与高度按整数进摘要：换行点变了必须被发现——那会改变导出行数与 hug 高度。

指纹不同的机器之间，**像素差异不能归因于渲染回归**。这条是整套机制里最要紧的
判定：它把"环境变了"和"代码改坏了"分开。

## 3. 三个引擎的采集路径

| 引擎 | 截图 | 读页面指标 | 实测状态 |
| --- | --- | --- | --- |
| chromium（Chrome / Edge） | 命令行 `--headless=new --screenshot` | `--dump-dom` | **已实测**（Windows + Chrome 157） |
| firefox | Marionette `WebDriver:TakeScreenshot` | Marionette `WebDriver:ExecuteScript` | **本机未实测**（开发机只有 Chromium） |
| webkit（Safari） | `safaridriver` + WebDriver `GET /screenshot` | WebDriver `POST /execute/sync` | **本机未实测**（开发机不是 macOS） |

不引入 Playwright：它要下载浏览器二进制，仓库不打算为此引入几百 MB 的依赖。

Firefox 走 **Marionette**（Firefox 自带的远程控制协议，端口 2828），不需要另外装
geckodriver；报文格式是 `<字节长度>:<JSON>`。Safari 走 `safaridriver` + 标准
WebDriver（HTTP/JSON），需要 macOS，且要先执行一次 `sudo safaridriver --enable`
并在 Safari 的「开发」菜单里打开「允许远程自动化」。

**未实测的意思**：这两条适配器按协议实现并做了防御性处理（连接超时、握手失败、
页面指标超时报错都有明确信息），但**没有在真实 Firefox / Safari 上跑过**。第一次
在有这两个浏览器的机器上使用时，预期是要修一轮适配细节的——文档写在这里就是为了
不让下一个人以为它已经稳了。

## 4. 判定纪律

| 情况 | 判定 |
| --- | --- |
| 目标引擎 / 平台没有基线 | **未采集**：明确报出来，并列出已有基线覆盖了哪些引擎与平台，退出码非 0 |
| 显式点名的引擎不可用（`--engine=firefox` 而本机没装） | **失败**：这是配置错误，不当成"跳过" |
| 默认模式下某引擎不可用 | 跳过，但**必须打印原因**，最后汇总"跳过了几个" |
| 字体集指纹不同 | **基线不可比**：不报像素差异，先说清环境变了 |
| 视口尺寸与基线不同 | 无法逐像素比对，明确报错 |
| 浏览器版本漂移 | 仍然比对，但提示"基线来自 X，当前是 Y"（差异可能来自浏览器升级） |
| 像素差异 ≤ 阈值（默认 0.3%） | 通过 |
| 像素差异 > 阈值 | 失败 |

**不静默通过、不静默失败**：没有基线时既不能说"通过"（那是假装没问题），也不能只
抛一句错（那是把「缺基线」和「工具坏了」混为一谈）。脚本会告诉用户现在到底有哪些
基线、怎么采。

## 5. 用法

```bash
npm run visual:cross-browser:list                        # 列出已有基线
npm run visual:cross-browser:baseline                   # 采集本机所有可用引擎
npm run visual:cross-browser:baseline -- --engine=firefox
npm run visual:cross-browser:check                      # 与基线比对
npm run visual:cross-browser:check -- --engine=chromium --threshold=0.003
npm run visual:cross-browser:check -- --require-engine=firefox
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--update` | 采集并写入基线（`visual:cross-browser:baseline` 已经带上了） |
| `--engine=<id>` | 只处理指定引擎（`chromium` / `firefox` / `webkit`，可逗号分隔） |
| `--browser=<路径>` | 指定可执行文件（覆盖探测结果） |
| `--platform=<键>` | 覆盖平台键（默认 `process.platform`），用于 CI 矩阵标注 |
| `--threshold=<比例>` | 像素差异阈值，默认 `0.003` |
| `--require-engine=<id>` | 要求的引擎不可用或没有基线即失败 |
| `--width=` / `--height=` | 视口尺寸，默认 960×680（必须与基线一致才能逐像素比） |

**这个检查不进 `check:visual`**：CI 的视觉 job 跑在 Linux runner 上，而基线是按
「引擎 + 平台」入库的，Linux 上根本没有对应基线。它是**按平台显式执行**的检查。

## 6. 验收

- 纯函数（`design-export/test/cross-browser.test.ts`，14 项）：基线路径布局、非法
  字符压缩、没有基线时判"未采集"、家族不符、版本漂移、同组合取最近一份、场景隔离、
  已有基线清单、指纹差异（字体集最要紧）、清单损坏报错、清单往返、重新采集是替换、
  user agent 认家族。
- 纯函数（`design-layout/test/font-baseline.test.ts`）：指纹的稳定性（顺序无关、
  0.1px 抖动不算变化、宽度真变了 / 换行点变了能看出来、摘要带样例数）。
- 实跑（Windows + Chrome 157）：`visual:cross-browser:baseline` 采出
  `chromium/win32/chrome-157.0.0.0/canvas.png`，`visual:cross-browser:check`
  再跑一遍 **0 像素差异**（652800 像素全部一致）。
- 回归：既有 `visual:canvas:check`（0 差异）与 `visual:font:check`（10 个样例一致）
  在 harness 改动后仍通过——harness 新增的字体测量不改变任何像素。

## 7. 已知限制

- **Firefox / Safari 未实测**（见第 3 节）。机制、路径布局、选基线与指纹比较都有
  单测覆盖，但两条适配器的真实联调还没做。
- **仓库里只有一份基线**（Windows + Chromium）。macOS、Linux、Firefox、Safari 的
  基线要各自采集后入库——机制已经支持，只是没人采过。
- **基线绑定本机字体**：本机没装 Inter 时会走回退栈，采集到的就是回退字形的画面。
  字体指纹会如实记录这一点，换一台装了 Inter 的机器会判定"基线不可比"。
- **场景只有画布一个**（`canvas`）。HTML / SVG / PDF 交付物的跨浏览器基线还没做。
- **版本取自 user agent**：Chrome 的 UA 把补丁版本固定成 `0.0.0`，所以 Chrome 的
  补丁升级不会让基线失效；内核大版本升级（157 → 158）会被识别成版本漂移。
