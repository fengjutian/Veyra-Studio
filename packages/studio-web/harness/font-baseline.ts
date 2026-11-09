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
import { DEFAULT_BASELINE_LINE_HEIGHT, fontBaselineCases, type FontBaselineCase, type FontBaselineEntry } from "@ufira/design-layout";
import { defaultAppearance, defaultLayout, type TextNode } from "@ufira/design-schema";
import { createBrowserTextMeasurer } from "../src/browser-text-measurer";

/** 报告所在的元素 id；采集脚本按它取 JSON。 */
const REPORT_ID = "font-baseline-report";

/** 量到小数点后三位：再往下就是浮点噪声，不是度量差异。 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toTextNode(entry: FontBaselineCase): TextNode {
  return {
    id: entry.id,
    type: "text",
    name: entry.id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: entry.text,
    fontFamily: entry.fontFamily,
    fontSize: entry.fontSize,
    lineHeight: entry.lineHeight ?? DEFAULT_BASELINE_LINE_HEIGHT,
    fontWeight: entry.fontWeight ?? 400,
    fontStyle: entry.fontStyle ?? "normal",
    letterSpacing: entry.letterSpacing ?? 0,
  };
}

async function main(): Promise<void> {
  // 字体是异步加载的：不等 `fonts.ready` 就量，拿到的是回退字形的宽度。
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }
  const measurer = createBrowserTextMeasurer();
  const cases: FontBaselineEntry[] = fontBaselineCases().map(entry => {
    const size = measurer.measure(toTextNode(entry), entry.availableWidth);
    const lineHeight = entry.lineHeight ?? DEFAULT_BASELINE_LINE_HEIGHT;
    return {
      ...entry,
      width: round(size.width),
      height: round(size.height),
      lines: Math.round(size.height / lineHeight),
    };
  });

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
