/**
 * 字体度量基线的浏览器入口。
 *
 * 页面加载后用**编辑器同一条测量路径**（`createBrowserTextMeasurer()`，即 canvas
 * `measureText`）量一遍固定样例，把结果写成 JSON 放进 DOM，采集脚本再从
 * `--dump-dom` 的输出里读回来。
 *
 * 为什么不用估算器：估算器是确定性的，任何机器结果都一样，测不出跨平台差异。
 * 为什么不用别的测量方式：基线必须反映**画布实际用的**那条路径，否则漂移测出来
 * 也不是漂移。
 */
import { measureFontFingerprint } from "../src/font-baseline-probe";

/** 报告所在的元素 id；采集脚本按它取 JSON。 */
const REPORT_ID = "font-baseline-report";

async function main(): Promise<void> {
  // 字体是异步加载的：不等 `fonts.ready` 就量，拿到的是回退字形的宽度。
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }
  const { samples: cases } = measureFontFingerprint();

  const report = {
    userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
    platform: typeof navigator === "undefined" ? undefined : navigator.platform,
    cases,
  };
  const pre = document.createElement("pre");
  pre.id = REPORT_ID;
  pre.textContent = JSON.stringify(report);
  document.body.appendChild(pre);
}

void main();
