import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineImagePath,
  compareFingerprints,
  describeAvailableBaselines,
  fontSetChanged,
  parseBrowserUserAgent,
  parseManifest,
  selectBaseline,
  serializeManifest,
  slugifySegment,
  upsertBaseline,
  type CrossBrowserBaseline,
  type CrossBrowserFingerprint,
  type CrossBrowserManifest,
} from "../src/cross-browser";

/**
 * 跨浏览器像素基线的机制层。
 *
 * 这些函数决定「这份基线能不能跟当前环境比」：路径布局对不对、选基线选得准不准、
 * 指纹差异说清楚没有。采集脚本只是它们的调用方——机制错了，采集得再勤也只是在
 * 稳定地产生错误答案。
 */

function fingerprint(overrides: Partial<CrossBrowserFingerprint> = {}): CrossBrowserFingerprint {
  return {
    engine: "chromium",
    family: "Chrome",
    version: "157.0.0.0",
    platform: "win32",
    osRelease: "win32 10.0.26200",
    userAgent: "UA",
    fontDigest: "e991a78a:10",
    viewport: { width: 960, height: 680 },
    deviceScaleFactor: 1,
    ...overrides,
  };
}

function baseline(overrides: Partial<CrossBrowserBaseline> = {}): CrossBrowserBaseline {
  const fp = fingerprint();
  return {
    scene: "canvas",
    engine: fp.engine,
    family: fp.family,
    version: fp.version,
    platform: fp.platform,
    image: "chromium/win32/chrome-157.0.0.0/canvas.png",
    fingerprint: fp,
    collectedAt: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(baselines: CrossBrowserBaseline[]): CrossBrowserManifest {
  return { version: 1, baselines };
}

test("基线路径按引擎 + 平台 + 家族版本分目录", () => {
  const image = baselineImagePath({
    scene: "canvas",
    engine: "firefox",
    family: "Firefox",
    version: "142.0",
    platform: "darwin",
  });
  assert.equal(image, "firefox/darwin/firefox-142.0/canvas.png");
});

test("目录名里的非法字符被压掉", () => {
  assert.equal(slugifySegment("Chrome 157.0.0.0"), "chrome-157.0.0.0");
  assert.equal(slugifySegment("  "), "unknown");
  assert.equal(slugifySegment("a/b"), "a-b");
});

test("没有基线时报告「未采集」，并说清缺的是哪一层", () => {
  const selection = selectBaseline(manifest([baseline()]), {
    scene: "canvas",
    engine: "firefox",
    platform: "win32",
  });
  assert.equal(selection.status, "missing");
  assert.match(selection.notes.join("；"), /还没有采集过基线/);
});

test("浏览器家族不同时不算命中，但要说清已有的家族", () => {
  const selection = selectBaseline(manifest([baseline({ family: "Chrome" })]), {
    scene: "canvas",
    engine: "chromium",
    platform: "win32",
    family: "Edge",
  });
  assert.equal(selection.status, "missing");
  assert.match(selection.notes.join("；"), /其它浏览器家族/);
  assert.match(selection.notes.join("；"), /Chrome/);
});

test("版本漂移时仍然给出基线，并明确提示版本不同", () => {
  const selection = selectBaseline(manifest([baseline()]), {
    scene: "canvas",
    engine: "chromium",
    platform: "win32",
    family: "Chrome",
    version: "158.0.0.0",
  });
  assert.equal(selection.status, "found");
  assert.equal(selection.baseline?.version, "157.0.0.0");
  assert.match(selection.notes.join("；"), /版本漂移/);
});

test("同一组合有多份时取最近采集的那份", () => {
  const older = baseline({ collectedAt: "2026-01-01T00:00:00.000Z", version: "156.0.0.0" });
  const newer = baseline({ collectedAt: "2026-11-10T00:00:00.000Z", version: "157.0.0.0" });
  const selection = selectBaseline(manifest([older, newer]), {
    scene: "canvas",
    engine: "chromium",
    platform: "win32",
    family: "Chrome",
  });
  assert.equal(selection.baseline?.version, "157.0.0.0");
});

test("场景不同不算命中", () => {
  const selection = selectBaseline(manifest([baseline()]), {
    scene: "export",
    engine: "chromium",
    platform: "win32",
  });
  assert.equal(selection.status, "missing");
});

test("已有基线的清单要能说出引擎、平台与家族", () => {
  const lines = describeAvailableBaselines(
    manifest([baseline(), baseline({ engine: "firefox", family: "Firefox", version: "142.0", platform: "darwin" })]),
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /chromium \/ win32 \/ Chrome 157\.0\.0\.0/);
  assert.match(lines[1]!, /firefox \/ darwin \/ Firefox 142\.0/);
});

test("字体集不同是最要紧的指纹差异", () => {
  const differences = compareFingerprints(fingerprint(), fingerprint({ fontDigest: "00000000:10" }));
  const font = differences.find(difference => difference.field === "fontDigest");
  assert.ok(font);
  assert.match(font!.note ?? "", /不可比/);
  assert.equal(fontSetChanged(fingerprint(), fingerprint({ fontDigest: "00000000:10" })), true);
  assert.equal(fontSetChanged(fingerprint(), fingerprint()), false);
});

test("指纹一致时不报差异", () => {
  assert.deepEqual(compareFingerprints(fingerprint(), fingerprint()), []);
});

test("清单损坏必须报错，不能当成空清单", () => {
  assert.throws(() => parseManifest("{ 不是 JSON"), /不是合法 JSON/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 2, baselines: [] })), /版本不支持/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, baselines: [{ scene: "canvas" }] })), /缺少字段/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, baselines: [{ ...baseline(), fingerprint: undefined }] })), /缺少 fingerprint/);
});

test("清单能原样往返", () => {
  const original = manifest([baseline()]);
  const parsed = parseManifest(serializeManifest(original));
  assert.deepEqual(parsed, original);
});

test("重新采集是替换而不是追加", () => {
  const first = baseline({ version: "156.0.0.0", collectedAt: "2026-01-01T00:00:00.000Z" });
  const second = baseline({ version: "157.0.0.0", collectedAt: "2026-11-10T00:00:00.000Z" });
  const other = baseline({ engine: "firefox", family: "Firefox", platform: "darwin" });
  const result = upsertBaseline(manifest([first, other]), second);
  assert.equal(result.baselines.length, 2);
  const chromium = result.baselines.filter(item => item.engine === "chromium");
  assert.equal(chromium.length, 1);
  assert.equal(chromium[0]?.version, "157.0.0.0");
});

test("user agent 能认出浏览器家族", () => {
  assert.deepEqual(parseBrowserUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/157.0.0.0 Safari/537.36"), {
    family: "Chrome",
    version: "157.0.0.0",
  });
  assert.deepEqual(parseBrowserUserAgent("Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/157.0.0.0 Safari/537.36"), {
    family: "Chrome",
    version: "157.0.0.0",
  });
  assert.deepEqual(parseBrowserUserAgent("Mozilla/5.0 (Windows NT 10.0) Edg/157.0.0.0 Chrome/157.0.0.0"), {
    family: "Edge",
    version: "157.0.0.0",
  });
  assert.deepEqual(parseBrowserUserAgent("Mozilla/5.0 (X11; Linux; rv:142.0) Gecko/20100101 Firefox/142.0"), {
    family: "Firefox",
    version: "142.0",
  });
  assert.deepEqual(parseBrowserUserAgent("Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15"), {
    family: "Safari",
    version: "18.0",
  });
  assert.equal(parseBrowserUserAgent("完全认不出来的 agent"), undefined);
});
