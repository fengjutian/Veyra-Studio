import assert from "node:assert/strict";
import test from "node:test";
import { extractReport, parseBrowserVersion } from "../visual/font-baseline";

/**
 * 字体度量基线的采集脚本里的纯函数。
 *
 * 这两个函数决定「采到的数对不对」：报告 JSON 要能从渲染后的 DOM 里正确取出来
 * （内容是 textContent，HTML 实体要先还原），浏览器版本要从 user agent 里认出来
 * ——认错了，平台差异说明就会说错话。
 */

test("从渲染后的 DOM 里取出报告 JSON", () => {
  const dom = `<html><body><pre id="font-baseline-report">{"userAgent":"UA","platform":"Win32","cases":[{"id":"a","text":"x","fontFamily":"Inter","fontSize":14,"width":100,"height":20,"lines":1}]}</pre></body></html>`;
  const report = extractReport(dom);
  assert.equal(report.userAgent, "UA");
  assert.equal(report.platform, "Win32");
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0]?.width, 100);
});

test("报告里的 HTML 实体要还原", () => {
  // textContent 会把 & < > 转义成实体；不还原就 JSON.parse 失败。
  const dom = `<pre id="font-baseline-report">{"cases":[{"id":"a","text":"a &amp; b &lt;tag&gt;","fontFamily":"Inter","fontSize":14,"width":1,"height":20,"lines":1}]}</pre>`;
  const report = extractReport(dom);
  assert.equal(report.cases[0]?.text, "a & b <tag>");
});

test("没有报告时明确报错", () => {
  assert.throws(() => extractReport("<html><body></body></html>"), /没有字体基线报告/);
});

test("从 user agent 认浏览器版本", () => {
  assert.equal(parseBrowserVersion("Mozilla/5.0 (Windows NT 10.0) Chrome/156.0.0.0 Safari/537.36"), "Chrome 156.0.0.0");
  assert.equal(parseBrowserVersion("Mozilla/5.0 (Windows NT 10.0) Edg/156.0.0.0 Chrome/156.0.0.0"), "Edge 156.0.0.0");
  assert.equal(parseBrowserVersion("Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15"), "Safari 18.0");
  assert.equal(parseBrowserVersion("Mozilla/5.0 (X11; Linux) Firefox/140.0"), "Firefox 140.0");
  assert.equal(parseBrowserVersion(undefined), undefined);
  assert.equal(parseBrowserVersion("完全认不出来的 agent"), undefined);
});
