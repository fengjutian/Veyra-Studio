import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument } from "@ufira/design-schema";
import { fontFamilyFromFileName, fontFileError, fontMimeFromFileName, MAX_FONT_BYTES } from "../src/assets";
import { collectFontFamilies, collectMissingFonts, loadDocumentFonts } from "../src/font-loading";

function documentWithText(families: string[]): DesignDocument {
  const document = createDocument("doc:fonts", "Fonts", "page:1");
  families.forEach((family, index) => {
    const id = `text:${index}`;
    document.nodes[id] = {
      id, type: "text", name: id, parentId: "page:1", childIds: [],
      visible: true, locked: false,
      layout: { ...defaultLayout(), width: 120, height: 30 },
      appearance: defaultAppearance(),
      text: "Aa", fontFamily: family, fontSize: 16, lineHeight: 24,
    };
    document.pages["page:1"]!.childIds.push(id);
  });
  return document;
}

test("derives a mime type and a family name from the file name", () => {
  assert.equal(fontMimeFromFileName("Inter-Bold.woff2"), "font/woff2");
  assert.equal(fontMimeFromFileName("SourceSerif.OTF"), "font/otf");
  assert.equal(fontMimeFromFileName("notes.txt"), undefined);
  assert.equal(fontFamilyFromFileName("Inter_Bold-Italic.ttf"), "Inter Bold Italic");
  assert.equal(fontFamilyFromFileName("Inter.woff2"), "Inter");
  assert.equal(fontFamilyFromFileName(".woff2"), "Untitled Font");
});

test("rejects unsupported, empty and oversized font files", () => {
  const file = { name: "font" } as File;
  assert.match(fontFileError(file, 10, undefined) ?? "", /woff2/);
  assert.match(fontFileError(file, 0, "font/woff2") ?? "", /为空/);
  assert.match(fontFileError(file, MAX_FONT_BYTES + 1, "font/woff2") ?? "", /超过/);
  assert.equal(fontFileError(file, 1024, "font/woff2"), undefined);
});

test("registers declared font files and reports the families it loaded", async () => {
  const document = documentWithText(["Studio Sans"]);
  document.assets["asset:font"] = { id: "asset:font", hash: "h1", mimeType: "font/woff2", byteLength: 1024 };
  document.fonts = [{ family: "Studio Sans", assetId: "asset:font", weight: 700 }];

  const added: unknown[] = [];
  const loaded = await loadDocumentFonts(document, {
    resolveAssetUrl: async () => "blob:font-1",
    fontSet: { add: face => added.push(face) },
    createFace: () => ({ load: async () => ({}) }),
  });

  assert.deepEqual(loaded, ["Studio Sans"]);
  assert.equal(added.length, 1);
});

test("a corrupt font file is skipped instead of failing the whole load", async () => {
  const document = documentWithText(["Broken Face"]);
  document.assets["asset:broken"] = { id: "asset:broken", hash: "h2", mimeType: "font/ttf", byteLength: 10 };
  document.fonts = [{ family: "Broken Face", assetId: "asset:broken" }];

  const loaded = await loadDocumentFonts(document, {
    resolveAssetUrl: async () => "blob:broken",
    fontSet: { add: () => undefined },
    createFace: () => ({ load: async () => { throw new Error("bad font"); } }),
  });
  assert.deepEqual(loaded, []);
});

test("missing fonts are the families no source could provide", () => {
  const document = documentWithText(["Inter", "Noto Serif"]);
  assert.deepEqual(collectFontFamilies(document), ["Inter", "Noto Serif"]);
  assert.deepEqual(collectMissingFonts(document, ["Inter"]), ["Noto Serif"]);
  assert.deepEqual(collectMissingFonts(document, ["Inter", "Noto Serif"]), []);
});
