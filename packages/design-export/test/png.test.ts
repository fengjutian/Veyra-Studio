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
