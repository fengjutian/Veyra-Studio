import assert from "node:assert/strict";
import test from "node:test";
import {
  BLEND_MODES,
  canvasCompositeFor,
  cssBlendMode,
  ellipticalGeometry,
  isBlendModeSupportedOnCanvas,
  radialGeometry,
} from "../src/index";

test("混合模式取值与 CSS mix-blend-mode 一致", () => {
  assert.equal(BLEND_MODES.length, 16);
  assert.equal(new Set(BLEND_MODES).size, 16);
  for (const mode of ["normal", "multiply", "screen", "overlay", "hue", "luminosity"]) {
    assert.ok(BLEND_MODES.includes(mode as never), `缺少 ${mode}`);
  }
});

test("Canvas 能表达的混合模式直接给出合成操作", () => {
  assert.equal(canvasCompositeFor("multiply"), "multiply");
  assert.equal(canvasCompositeFor("color-dodge"), "color-dodge");
  assert.equal(canvasCompositeFor("hard-light"), "hard-light");
  // normal 是缺省行为，不需要设合成操作。
  assert.equal(canvasCompositeFor("normal"), undefined);
  assert.equal(canvasCompositeFor(undefined), undefined);
});

test("Canvas 没有的颜色类混合模式显式退化，而不是挑一个近似的", () => {
  // hue / saturation / color / luminosity 在 Canvas 里没有等价物。
  for (const mode of ["hue", "saturation", "color", "luminosity"] as const) {
    assert.equal(canvasCompositeFor(mode), undefined, mode);
    assert.equal(isBlendModeSupportedOnCanvas(mode), false, mode);
  }
  assert.equal(isBlendModeSupportedOnCanvas("multiply"), true);
  assert.equal(isBlendModeSupportedOnCanvas("normal"), true);
  assert.equal(isBlendModeSupportedOnCanvas(undefined), true);
});

test("CSS 侧不需要翻译：名字与 mix-blend-mode 相同", () => {
  assert.equal(cssBlendMode("multiply"), "multiply");
  assert.equal(cssBlendMode("color-burn"), "color-burn");
  // normal 不写进 CSS。
  assert.equal(cssBlendMode("normal"), undefined);
  assert.equal(cssBlendMode(undefined), undefined);
});

test("椭圆渐变的几何：两个半轴分别相对盒子的宽和高", () => {
  const box = { x: 10, y: 20, width: 100, height: 50 };
  const geometry = ellipticalGeometry(box, { cx: 0.5, cy: 0.4, rx: 0.5, ry: 0.5 });
  assert.deepEqual(geometry, { cx: 60, cy: 40, rx: 50, ry: 25 });
});

test("椭圆渐变的半轴不会退化到 0（画不出椭圆）", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  const geometry = ellipticalGeometry(box, { cx: 0, cy: 0, rx: 0, ry: 0 });
  assert.ok(geometry.rx > 0);
  assert.ok(geometry.ry > 0);
});

test("径向渐变的半径基准是长边，椭圆渐变的半轴基准是各自的边", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  // 径向：r 是长边（100）的比例。
  assert.equal(radialGeometry(box, { cx: 0.5, cy: 0.5, r: 0.5 }).r, 50);
  // 椭圆：rx 相对宽、ry 相对高。
  const ellipse = ellipticalGeometry(box, { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 });
  assert.equal(ellipse.rx, 50);
  assert.equal(ellipse.ry, 25);
});
