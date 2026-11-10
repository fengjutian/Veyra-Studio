import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { exportDocumentToVectorPdf } from "@ufira/design-export";
import { defaultAppearance, defaultLayout, type AssetMetadata, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "../src/index";
import { prepareVectorPdfFonts, setFontSubsetProvider } from "../src/font-faces";
import { MemoryRepository } from "./memory-repository";

/**
 * 矢量 PDF 的字体准备。
 *
 * PDF 只能内嵌 sfnt（TrueType / OpenType）：压缩容器（woff/woff2）要先转，
 * 没有字节的系统字体只能退回 PDF 内置 Helvetica——诊断里必须写明字形对不上。
 *
 * 规格见 `docs/vector-pdf.md`。
 */

const here = dirname(fileURLToPath(import.meta.url));
const FONT_BYTES = new Uint8Array(readFileSync(join(here, "..", "..", "design-export", "test", "fixtures", "PressStart2P-Regular.ttf")));

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision + 1}`,
  documentId: "project:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

function fontAsset(bytes: Uint8Array, name: string, mimeType = "font/ttf"): AssetMetadata {
  return {
    id: `asset:${name}`,
    hash: createHash("sha256").update(bytes).digest("hex"),
    mimeType,
    byteLength: bytes.byteLength,
    name,
  };
}

function textNode(id: string, family: string): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 40 },
    appearance: defaultAppearance(),
    text: "hello",
    fontFamily: family,
    fontSize: 16,
    lineHeight: 24,
  } as DesignNode;
}

/** 一个带字体资产与声明的项目。 */
async function projectWithFont(mimeType = "font/ttf", bytes = FONT_BYTES) {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = fontAsset(bytes, "PressStart2P", mimeType);
  await repository.putAsset("project:1", { hash: asset.hash, bytes });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: textNode("text:1", "Press Start 2P") } },
    { type: "font.register", payload: { font: { family: "Press Start 2P", assetId: asset.id, weight: 400 } } },
  ]));
  return { project, repository };
}

test("矢量 PDF：文档声明过的字体被准备出来（键是 family weight style）", async () => {
  const { project, repository } = await projectWithFont();
  const prepared = await prepareVectorPdfFonts(repository, project.snapshot(), { pageId: "page:1" });
  const font = prepared.fonts.get("Press Start 2P 400 normal");
  assert.ok(font, "字体应该被准备出来");
  assert.equal(font!.bytes.byteLength, FONT_BYTES.byteLength);
  assert.equal(font!.bold, false);
  assert.equal(font!.italic, false);
  assert.equal(prepared.diagnostics.length, 0);
});

test("矢量 PDF：系统字体没有字节，不进准备结果（由导出器退回 Helvetica）", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  await project.execute(envelope(0, [
    { type: "node.create", payload: { node: textNode("text:1", "Inter") } },
  ]));
  const prepared = await prepareVectorPdfFonts(repository, project.snapshot(), { pageId: "page:1" });
  assert.equal(prepared.fonts.size, 0);
});

test("矢量 PDF：压缩容器且没有子集化能力时报诊断（不能内嵌）", async () => {
  // 真的是 woff2 头（不是 sfnt）：PDF 不认压缩容器。
  const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]);
  const { project, repository } = await projectWithFont("font/woff2", woff2);
  const prepared = await prepareVectorPdfFonts(repository, project.snapshot(), { pageId: "page:1" });
  assert.equal(prepared.fonts.size, 0);
  assert.match(prepared.diagnostics[0]?.message ?? "", /PDF 只能内嵌/);
});

test("矢量 PDF：准备好的字体真的内嵌进 PDF（端到端）", async () => {
  const { project, repository } = await projectWithFont();
  const prepared = await prepareVectorPdfFonts(repository, project.snapshot(), { pageId: "page:1" });
  const result = await exportDocumentToVectorPdf(project.snapshot(), {
    viewport: { width: 400, height: 200 },
    title: "矢量",
    fonts: prepared.fonts,
  });
  const text = new TextDecoder().decode(result.bytes);
  assert.match(text, /\/Subtype \/Type0/);
  assert.match(text, /\/FontFile2 \d+ 0 R/);
  assert.match(text, /\/ToUnicode \d+ 0 R/);
  // 文字用的是内嵌字体，不是退化的 Helvetica。
  assert.equal(text.includes("/BaseFont /Helvetica"), false);
});

test("矢量 PDF：子集化能力能把字体裁小再内嵌", async () => {
  const { project, repository } = await projectWithFont();
  let called = 0;
  setFontSubsetProvider(async () => ({
    subset(font: Uint8Array, text: string) {
      called += 1;
      assert.match(text, /hello/);
      return font;
    },
  }));
  try {
    const prepared = await prepareVectorPdfFonts(repository, project.snapshot(), { pageId: "page:1" });
    assert.equal(called, 1);
    assert.equal(prepared.fonts.size, 1);
  } finally {
    setFontSubsetProvider(undefined);
  }
});
