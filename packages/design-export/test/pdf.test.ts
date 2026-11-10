import assert from "node:assert/strict";
import test from "node:test";
import { exportRastersToPdf, type PdfRasterPage } from "../src/index";

/** 一张 2×2 的图：左上红、右上绿、左下蓝、右下白。 */
function samplePage(): PdfRasterPage {
  return {
    width: 2,
    height: 2,
    pixels: new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]),
  };
}

/** 从 PDF 里把某张图的样本数据抠出来（解压后）。 */
async function imageSamples(pdf: Uint8Array, index: number): Promise<Uint8Array> {
  const text = Buffer.from(pdf).toString("latin1");
  const marker = "/Subtype /Image";
  const positions: number[] = [];
  let at = text.indexOf(marker);
  while (at >= 0) {
    positions.push(at);
    at = text.indexOf(marker, at + 1);
  }
  const start = positions[index];
  assert.ok(start !== undefined, `PDF 里没有第 ${index + 1} 张图`);
  const streamStart = text.indexOf("stream\n", start) + "stream\n".length;
  const lengthMatch = /\/Length (\d+)/.exec(text.slice(start, streamStart));
  assert.ok(lengthMatch, "图像对象里没有 /Length");
  const length = Number(lengthMatch[1]);
  const raw = pdf.subarray(streamStart, streamStart + length);

  const scope = globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> };
  if (!scope.DecompressionStream) return raw;
  const stream = new scope.DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const written = writer.write(raw);
  const closed = writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;
  await closed;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

test("PDF 有正确的文件头、页数与 xref", async () => {
  const result = await exportRastersToPdf([samplePage(), samplePage()], { title: "Demo" });
  const text = Buffer.from(result.bytes).toString("latin1");
  assert.equal(result.pageCount, 2);
  assert.match(text, /^%PDF-1\.7/);
  assert.match(text, /\/Count 2/);
  assert.match(text, /%%EOF\n$/);
  // xref 偏移必须真的指向 "xref"。
  const startxref = /startxref\n(\d+)\n/.exec(text);
  assert.ok(startxref, "PDF 里没有 startxref");
  assert.equal(text.slice(Number(startxref[1]), Number(startxref[1]) + 4), "xref");
});

test("页面尺寸按 96dpi → 72dpi 换算", async () => {
  const result = await exportRastersToPdf([samplePage()]);
  const text = Buffer.from(result.bytes).toString("latin1");
  // 2 像素 × 0.75 = 1.5 点。
  assert.match(text, /\/MediaBox \[0 0 1\.5 1\.5\]/);
});

test("图像样本原样进出（解压后逐字节相同）", async () => {
  const result = await exportRastersToPdf([samplePage()]);
  const samples = await imageSamples(result.bytes, 0);
  assert.deepEqual([...samples], [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
});

test("半透明像素合成到白底", async () => {
  const page: PdfRasterPage = { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 0]) };
  const result = await exportRastersToPdf([page]);
  const samples = await imageSamples(result.bytes, 0);
  assert.deepEqual([...samples], [255, 255, 255]);
});

test("多页 PDF 每页一张图", async () => {
  const second: PdfRasterPage = { width: 1, height: 1, pixels: new Uint8Array([10, 20, 30, 255]) };
  const result = await exportRastersToPdf([samplePage(), second]);
  const first = await imageSamples(result.bytes, 0);
  const other = await imageSamples(result.bytes, 1);
  assert.equal(first.length, 12);
  assert.deepEqual([...other], [10, 20, 30]);
});

test("同样的输入产出同样的字节", async () => {
  const first = await exportRastersToPdf([samplePage()], { title: "Demo" });
  const second = await exportRastersToPdf([samplePage()], { title: "Demo" });
  assert.deepEqual([...first.bytes], [...second.bytes]);
});

test("中文标题用 UTF-16BE 十六进制串（literal string 会乱码）", async () => {
  const result = await exportRastersToPdf([samplePage()], { title: "画布基线" });
  const text = Buffer.from(result.bytes).toString("latin1");
  assert.match(text, /\/Title <FEFF/);
});

test("空页列表直接报错", async () => {
  await assert.rejects(() => exportRastersToPdf([]), /至少要一页/);
});

test("像素长度与尺寸对不上时报错", async () => {
  await assert.rejects(
    () => exportRastersToPdf([{ width: 4, height: 4, pixels: new Uint8Array(4) }]),
    /像素长度与尺寸对不上/,
  );
});
