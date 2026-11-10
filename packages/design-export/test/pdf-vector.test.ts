import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument } from "@ufira/design-schema";
import { buildToUnicodeCMap, exportDocumentToVectorPdf, parsePdfColor, subsetTag } from "../src/pdf-vector";

/** 矢量 PDF：文字可选（内嵌 TrueType 子集 + CID 字形映射）。 */

/**
 * 把 PDF 里所有能解开的流解开拼起来（内容流是 Flate 压缩的）。
 *
 * 按 `/Length` 取字节，而不是找 `endstream`——压缩后的数据里可能正好出现
 * `stream\n` 这样的字节序列，按标记切会切错位置。
 */
function inflateStreams(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("latin1");
  const parts: string[] = [];
  const pattern = /\/Length (\d+)[^>]*>>\s*stream\n/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const length = Number(match[1]);
    const start = match.index + match[0].length;
    try {
      parts.push(inflateSync(buffer.subarray(start, start + length)).toString("latin1"));
    } catch {
      // 不是 zlib 流（比如原样写入的 CMap），跳过。
    }
    match = pattern.exec(text);
  }
  return parts.join("\n");
}

const here = fileURLToPath(new URL(".", import.meta.url));
const fontBytes = new Uint8Array(readFileSync(join(here, "fixtures", "PressStart2P-Regular.ttf")));

function documentWithText(text: string): DesignDocument {
  const document = createDocument("doc:pdf", "PDF");
  document.nodes["text:1"] = {
    id: "text:1",
    type: "text",
    name: "标题",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#112233" }] },
    text,
    fontFamily: "Press Start 2P",
    fontSize: 24,
    lineHeight: 30,
  };
  document.nodes["frame:1"] = {
    id: "frame:1",
    type: "frame",
    name: "Card",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 200, height: 120 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ff0000" }], cornerRadius: 12 },
  };
  document.pages["page:1"]!.childIds = ["frame:1", "text:1"];
  return document;
}

const fonts = new Map([
  ["Press Start 2P 400 normal", { bytes: fontBytes, family: "PressStart2P", bold: false, italic: false }],
]);

test("矢量 PDF：能产出一份带内嵌字体的文件", async () => {
  const result = await exportDocumentToVectorPdf(documentWithText("Hi"), {
    viewport: { width: 400, height: 200 },
    title: "测试",
    fonts,
  });
  assert.equal(result.pageCount, 1);
  const text = new TextDecoder().decode(result.bytes);
  // 文件头与结尾。
  assert.match(text, /^%PDF-1\.7/);
  assert.match(text, /%%EOF\s*$/);
  // 文字走 Type0 + Identity-H，并带 ToUnicode（没有它就搜不到字）。
  assert.match(text, /\/Subtype \/Type0/);
  assert.match(text, /\/Encoding \/Identity-H/);
  assert.match(text, /\/Subtype \/CIDFontType2/);
  assert.match(text, /\/ToUnicode \d+ 0 R/);
  assert.match(text, /beginbfchar/);
  // 字体本体被内嵌了。
  assert.match(text, /\/FontFile2 \d+ 0 R/);
  // 页面尺寸按 96dpi → 72dpi 换算。
  assert.match(text, /\/MediaBox \[0 0 300 150\]/);
});

test("矢量 PDF：形状画成矢量路径，不是位图", async () => {
  const result = await exportDocumentToVectorPdf(documentWithText("Hi"), {
    viewport: { width: 400, height: 200 },
    fonts,
  });
  const text = new TextDecoder().decode(result.bytes);
  // 没有图片对象：矢量 PDF 里不该出现位图。
  assert.equal(text.includes("/Subtype /Image"), false);
  // 内容流里有画路径的操作符（内容流是压缩的，要先解开）。
  const content = inflateStreams(result.bytes);
  assert.match(content, / l\n/);
  assert.match(content, / c\n/);
  assert.match(content, / rg\n/);
  // 文字写成 Tj 指令。
  assert.match(content, / Tj/);
});

test("矢量 PDF：没有字体时退到内置 Helvetica，并记诊断", async () => {
  const result = await exportDocumentToVectorPdf(documentWithText("Hi"), {
    viewport: { width: 400, height: 200 },
  });
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.feature === "pdf-vector-font"));
  const text = new TextDecoder().decode(result.bytes);
  assert.match(text, /\/BaseFont \/Helvetica/);
  // 没有内嵌字体。
  assert.equal(text.includes("/FontFile2"), false);
});

test("ToUnicode CMap：GID 映射回 Unicode", () => {
  const cmap = new TextDecoder().decode(buildToUnicodeCMap(new Map([[3, 72], [4, 105]])));
  assert.match(cmap, /<0003> <0048>/);
  assert.match(cmap, /<0004> <0069>/);
  assert.match(cmap, /2 beginbfchar/);
});

test("颜色解析：十六进制与 rgb() 都能读", () => {
  assert.deepEqual(parsePdfColor("#ff0000"), { r: 1, g: 0, b: 0 });
  assert.deepEqual(parsePdfColor("#0f0"), { r: 0, g: 1, b: 0 });
  assert.deepEqual(parsePdfColor("rgb(255, 0, 0)"), { r: 1, g: 0, b: 0 });
  assert.equal(parsePdfColor("不是颜色"), undefined);
});

test("子集标记：6 位大写字母", () => {
  assert.match(subsetTag("Press Start 2P"), /^[A-Z]{6}$/);
  assert.equal(subsetTag("Inter"), subsetTag("Inter"));
  assert.notEqual(subsetTag("Inter"), subsetTag("Roboto"));
});
