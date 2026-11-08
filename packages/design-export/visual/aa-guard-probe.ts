/**
 * 阴性对照探针：验证 diffImages + suite 判定**不是恒真**。
 *
 * 做法：不碰仓库里的基线文件，而是在内存里造两张图，
 * 一对"只有抗锯齿级差别的边缘像素"（应当豁免），
 * 一对"真实内容改动"（应当被抓出来）。
 *
 * 跑法：npx tsx packages/design-export/visual/aa-guard-probe.ts
 */
import assert from "node:assert/strict";
import { diffImages, type RgbaImage } from "./png";

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a;
    }
  }
  return { width, height, data };
}

// 1) 抗锯齿级边缘差 → 应豁免
const aaLeft = image(8, 8, (x) => (x === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const aaRight = image(8, 8, (x, y) => {
  if (x === 4 && y === 0) return [238, 238, 238, 255];
  return x === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255];
});
const aaDiff = diffImages(aaLeft, aaRight);
assert.equal(aaDiff.differentPixels, 0, "AA 边缘差应当豁免");
assert.ok(aaDiff.antiAliasedPixels > 0, "AA 像素应被单独计数");

// 2) 真实内容改动 → 必须被抓出来
const realLeft = image(8, 8, () => [0, 0, 0, 255]);
const realRight = image(8, 8, () => [0, 0, 0, 255]);
realRight.data[(3 * 8 + 6) * 4] = 255; // 孤立亮像素
const realDiff = diffImages(realLeft, realRight);
assert.equal(realDiff.differentPixels, 1, "孤立亮像素是真实改动，必须被抓出来");
assert.equal(realDiff.antiAliasedPixels, 0, "真实改动不应被算成 AA");

// 3) 大面积位移 → 必须被抓出来（幅度大，不会被 delta 上限放过）
const shiftLeft = image(20, 20, (x) => (x < 10 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const shiftRight = image(20, 20, (x) => (x < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const shiftDiff = diffImages(shiftLeft, shiftRight);
assert.ok(shiftDiff.differentPixels >= 40, `位移必须被抓出来，实际 ${shiftDiff.differentPixels}`);

// 4) 忽略区域外的真实改动 → 仍被抓出来
const maskedDiff = diffImages(realLeft, realRight, {
  ignoreRegions: [{ x: 0, y: 0, width: 2, height: 2 }],
});
assert.equal(maskedDiff.differentPixels, 1, "忽略区域外的改动仍要被抓出来");

console.log("阴性对照通过：AA 差豁免、真实改动被抓、位移被抓、区域外改动被抓。");
