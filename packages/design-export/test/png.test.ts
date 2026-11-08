import assert from "node:assert/strict";
import test from "node:test";
import { decodePng, diffImages, encodePng, type RgbaImage } from "../visual/png";

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a;
    }
  }
  return { width, height, data };
}

test("PNG 编解码往返保持尺寸与像素", () => {
  const original = image(5, 3, (x, y) => [x * 20, y * 40, 128, 255]);
  const decoded = decodePng(encodePng(original));
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decoded.data], [...original.data]);
});

test("相同图片没有差异", () => {
  const left = image(4, 4, () => [10, 20, 30, 255]);
  const diff = diffImages(left, left);
  assert.equal(diff.differentPixels, 0);
  assert.equal(diff.ratio, 0);
  assert.equal(diff.maxChannelDelta, 0);
});

test("单个像素差异会被计入比例", () => {
  const left = image(10, 10, () => [0, 0, 0, 255]);
  const right = image(10, 10, (x, y) => (x === 3 && y === 4 ? [0, 0, 0, 255] : [0, 0, 0, 255]));
  right.data[((4 * 10) + 3) * 4] = 200;
  const diff = diffImages(left, right);
  assert.equal(diff.differentPixels, 1);
  assert.equal(diff.ratio, 1 / 100);
  assert.equal(diff.maxChannelDelta, 200);
  // 差异图里那一像素标红。
  const offset = ((4 * 10) + 3) * 4;
  assert.deepEqual([...diff.image.data.slice(offset, offset + 4)], [255, 0, 0, 255]);
});

test("容忍阈值会忽略抗锯齿级别的小差异", () => {
  const left = image(3, 1, () => [100, 100, 100, 255]);
  const right = image(3, 1, (x) => (x === 1 ? [104, 100, 100, 255] : [100, 100, 100, 255]));
  assert.equal(diffImages(left, right).differentPixels, 1);
  assert.equal(diffImages(left, right, { tolerance: 4 }).differentPixels, 0);
});

test("尺寸不一致直接报错，而不是拉伸后比较", () => {
  const left = image(4, 4, () => [0, 0, 0, 255]);
  const right = image(5, 4, () => [0, 0, 0, 255]);
  assert.throws(() => diffImages(left, right), /尺寸不一致/);
});

test("抗锯齿边缘的灰阶差异默认被豁免", () => {
  // 左图：黑底上一个白块，边缘是灰阶。
  const left = image(6, 6, (x) => (x === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  // 右图：同一个白块，边缘像素被舍入成略暗的灰阶（典型的跨机器抗锯齿差）。
  const right = image(6, 6, (x, y) => {
    if (x === 3 && y === 0) return [240, 240, 240, 255];
    return x === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255];
  });

  const withAa = diffImages(left, right);
  assert.equal(withAa.differentPixels, 0);
  assert.equal(withAa.antiAliasedPixels, 1);

  // 关掉豁免后，同一个差异会被记为真实差异。
  const withoutAa = diffImages(left, right, { ignoreAntiAlias: false });
  assert.equal(withoutAa.differentPixels, 1);
  assert.equal(withoutAa.antiAliasedPixels, 0);
});

test("忽略区域内的像素完全不计入差异", () => {
  const left = image(10, 10, () => [0, 0, 0, 255]);
  const right = image(10, 10, () => [0, 0, 0, 255]);
  right.data[((2 * 10) + 5) * 4] = 255;

  const masked = diffImages(left, right, {
    ignoreRegions: [{ x: 4, y: 1, width: 3, height: 3 }],
  });
  assert.equal(masked.differentPixels, 0);
  assert.equal(masked.ignoredPixels, 9);

  const unmasked = diffImages(left, right);
  assert.equal(unmasked.differentPixels, 1);
  assert.equal(unmasked.ignoredPixels, 0);
});

test("忽略区域外的差异仍然会被抓出来", () => {
  const left = image(10, 10, () => [0, 0, 0, 255]);
  const right = image(10, 10, () => [0, 0, 0, 255]);
  right.data[((9 * 10) + 9) * 4] = 255;

  const masked = diffImages(left, right, {
    ignoreRegions: [{ x: 0, y: 0, width: 5, height: 5 }],
  });
  assert.equal(masked.differentPixels, 1);
});
