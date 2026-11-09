import assert from "node:assert/strict";
import test from "node:test";
import type { AssetMetadata } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { assetIdForHash, fitImageBox, imageBackgroundStyle, imageFileError, readImageSize, sha256Hex, svgIntrinsicSize } from "../src/assets";
import { loadAssetUrl, resetAssetUrlCache } from "../src/asset-url";

const png = (bytes: number[]): File => new File([new Uint8Array(bytes)], "pixel.png", { type: "image/png" });

test("资源 id 由内容哈希推导，同一张图落到同一个 id", () => {
  const hash = "a".repeat(64);
  assert.equal(assetIdForHash(hash), `asset:${"a".repeat(16)}`);
  assert.equal(assetIdForHash(hash), assetIdForHash(hash));
  assert.notEqual(assetIdForHash(hash), assetIdForHash("b".repeat(64)));
});

test("插入尺寸按原图比例缩进上限，小图不放大", () => {
  assert.deepEqual(fitImageBox({ width: 100, height: 50 }), { width: 100, height: 50 });
  assert.deepEqual(fitImageBox({ width: 1000, height: 500 }), { width: 480, height: 240 });
  assert.deepEqual(fitImageBox({ width: 10, height: 1000 }), { width: 5, height: 480 });
  assert.deepEqual(fitImageBox({ width: 0, height: 0 }), { width: 1, height: 1 });
});

test("fit 映射成保持画布与导出一致的背景样式", () => {
  assert.equal(imageBackgroundStyle("cover").backgroundSize, "cover");
  assert.equal(imageBackgroundStyle("contain").backgroundSize, "contain");
  assert.equal(imageBackgroundStyle("fill").backgroundSize, "100% 100%");
  assert.equal(imageBackgroundStyle("cover").backgroundRepeat, "no-repeat");
});

test("非图片、不支持的格式、空文件和超大文件都被挡在插入之前", () => {
  assert.match(imageFileError(new File(["text"], "a.txt", { type: "text/plain" }), 4) ?? "", /只能插入图片文件/);
  assert.match(imageFileError(new File([new Uint8Array([1])], "a.bmp", { type: "image/bmp" }), 4) ?? "", /PNG、JPEG、GIF、WebP、SVG/);
  assert.match(imageFileError(png([]), 0) ?? "", /内容为空/);
  assert.match(imageFileError(png([1]), 21 * 1024 * 1024) ?? "", /20 MB/);
  assert.equal(imageFileError(png([1]), 1), undefined);
  // SVG 和位图一样可以插入：导出器会把它内联成 data URL。
  assert.equal(imageFileError(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }), 6), undefined);
});

test("SVG 的固有尺寸：优先 width/height，其次 viewBox", () => {
  assert.deepEqual(svgIntrinsicSize('<svg width="120" height="80"></svg>'), { width: 120, height: 80 });
  assert.deepEqual(svgIntrinsicSize("<svg width='120px' height='80px'></svg>"), { width: 120, height: 80 });
  assert.deepEqual(svgIntrinsicSize('<svg viewBox="0 0 64 32"></svg>'), { width: 64, height: 32 });
  // 只有一边有像素尺寸时，另一边从 viewBox 补。
  assert.deepEqual(svgIntrinsicSize('<svg width="128" viewBox="0 0 64 32"></svg>'), { width: 128, height: 32 });
  // 百分比没有确定像素值，不猜。
  assert.equal(svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 0 0"></svg>'), undefined);
  assert.equal(svgIntrinsicSize("not an svg"), undefined);
});

test("SVG 文件读不出像素尺寸时退回文本解析，位图退回落尺寸", async () => {
  const svg = new File(['<svg viewBox="0 0 64 40"></svg>'], "icon.svg", { type: "image/svg+xml" });
  assert.deepEqual(await readImageSize(svg), { width: 64, height: 40 });
  // 没有 createImageBitmap 时位图只能退回固定尺寸。
  assert.deepEqual(await readImageSize(png([1, 2, 3])), { width: 240, height: 160 });
});

test("sha256 与仓库校验资源用的是同一种摘要", async () => {
  // "abc" 的 SHA-256 是固定的，用它锁住实现，避免以后换成别的摘要。
  assert.equal(await sha256Hex(new Uint8Array([97, 98, 99])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("同一份资源只读一次，并且复用同一个对象 URL", async t => {
  if (typeof URL.createObjectURL !== "function") { t.skip("当前运行时没有 URL.createObjectURL"); return; }
  resetAssetUrlCache();
  const asset: AssetMetadata = { id: "asset:1", hash: "c".repeat(64), mimeType: "image/png", byteLength: 3, name: "pixel.png" };
  let reads = 0;
  const repository = { async getAsset() { reads += 1; return new Uint8Array([1, 2, 3]); } } as unknown as ProjectRepository;

  const [first, second] = await Promise.all([loadAssetUrl(repository, "project:1", asset), loadAssetUrl(repository, "project:1", asset)]);
  assert.equal(reads, 1);
  assert.equal(first, second);
  assert.ok(first);
});

test("仓库里读不到字节时返回 undefined，缓存也不再重试", async () => {
  resetAssetUrlCache();
  const asset: AssetMetadata = { id: "asset:2", hash: "d".repeat(64), mimeType: "image/png", byteLength: 0 };
  let reads = 0;
  const repository = { async getAsset() { reads += 1; return undefined; } } as unknown as ProjectRepository;

  assert.equal(await loadAssetUrl(repository, "project:1", asset), undefined);
  assert.equal(await loadAssetUrl(repository, "project:1", asset), undefined);
  assert.equal(reads, 1);
});
