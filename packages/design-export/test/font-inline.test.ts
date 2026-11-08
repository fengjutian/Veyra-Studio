import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import {
  FONT_INLINE_MAX_BYTES,
  collectExportFonts,
  exportPageToHtml,
  fontFaceCss,
  inlineFonts,
  matchFontDeclaration,
} from "../src/index";

/**
 * 导出物内联字体的纯逻辑。
 *
 * 规格见 `docs/font-inline.md`。
 */

function documentWithTexts(fonts: Array<{ family: string; weight?: number; style?: "normal" | "italic" }>): DesignDocument {
  const document = createDocument("doc:fonts", "字体");
  document.fonts = fonts.map(font => ({
    family: font.family,
    ...(font.weight !== undefined ? { weight: font.weight } : {}),
    ...(font.style !== undefined ? { style: font.style } : {}),
  }));
  fonts.forEach((font, index) => {
    const node = {
      id: `text:${index}`,
      type: "text",
      name: `text:${index}`,
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: { ...defaultLayout(), x: 0, y: index * 40, width: 200, height: 40 },
      appearance: defaultAppearance(),
      text: "hello",
      fontFamily: font.family,
      fontSize: 16,
      lineHeight: 24,
      ...(font.weight !== undefined ? { fontWeight: font.weight } : {}),
      ...(font.style !== undefined ? { fontStyle: font.style } : {}),
    } as DesignNode;
    document.nodes[node.id] = node;
    document.pages["page:1"]!.childIds.push(node.id);
  });
  return document;
}

test("collects the fonts used by the exported text nodes", () => {
  const document = documentWithTexts([
    { family: "Inter", weight: 400 },
    { family: "Inter", weight: 700 },
    { family: "Source Han Sans", weight: 400 },
  ]);
  const fonts = collectExportFonts(document, { pageId: "page:1" });
  assert.deepEqual(fonts, [
    { family: "Inter", weight: 400, style: "normal" },
    { family: "Inter", weight: 700, style: "normal" },
    { family: "Source Han Sans", weight: 400, style: "normal" },
  ]);
});

test("matches the declaration of the same family and weight", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 700 }]);
  const matched = matchFontDeclaration(document.fonts, { family: "Inter", weight: 700, style: "normal" });
  assert.equal(matched?.exact, true);
  assert.equal(matched?.declaration.weight, 700);
});

test("falls back to another declaration of the same family when the weight does not match", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const matched = matchFontDeclaration(document.fonts, { family: "Inter", weight: 700, style: "normal" });
  assert.equal(matched?.exact, false);
  assert.equal(matched?.declaration.weight, 400);
});

test("has no match for a family that was never declared", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  assert.equal(matchFontDeclaration(document.fonts, { family: "Comic Sans", weight: 400, style: "normal" }), undefined);
});

test("writes a font-face rule with the weight, the style and the data url", () => {
  const css = fontFaceCss({
    family: "Press Start 2P",
    weight: 400,
    style: "normal",
    bytes: new Uint8Array([102, 111, 111]),
    mime: "font/woff2",
  });
  assert.match(css, /@font-face \{/);
  assert.match(css, /font-family: "Press Start 2P";/);
  assert.match(css, /src: url\(data:font\/woff2;base64,Zm9v\) format\("woff2"\);/);
  assert.match(css, /font-weight: 400;/);
  assert.match(css, /font-style: normal;/);
  assert.match(css, /font-display: swap;/);
});

test("escapes the quotes in a family name", () => {
  const css = fontFaceCss({ family: 'Say "Hi"', weight: 400, style: "normal", bytes: new Uint8Array([1]), mime: "font/ttf" });
  assert.match(css, /font-family: "Say \\"Hi\\"";/);
});

test("skips a font that is too large and says so", () => {
  const result = inlineFonts([
    { family: "Big", weight: 400, style: "normal", bytes: new Uint8Array(FONT_INLINE_MAX_BYTES + 1), mime: "font/ttf" },
  ]);
  assert.equal(result.css, "");
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]!.reason, "too-large");
});

test("keeps a font that fits the inline budget", () => {
  const result = inlineFonts([
    { family: "Small", weight: 400, style: "normal", bytes: new Uint8Array([1, 2, 3]), mime: "font/ttf" },
  ]);
  assert.match(result.css, /@font-face/);
  assert.deepEqual(result.notes, []);
});

test("puts the font faces into the exported style block", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const css = fontFaceCss({ family: "Inter", weight: 400, style: "normal", bytes: new Uint8Array([1]), mime: "font/woff2" });
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 400, height: 200 }, fontFaces: [css] });
  assert.match(result.document, /@font-face \{/);
  assert.match(result.document, /font-family: "Inter";/);
  // @font-face 要在 <style> 块里。
  assert.ok(result.document.indexOf("@font-face") < result.document.indexOf("</style>"));
});

test("keeps the old export byte-identical when there are no font faces", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const withFaces = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 400, height: 200 } });
  const withoutFaces = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 400, height: 200 }, fontFaces: [] });
  assert.equal(withFaces.document, withoutFaces.document);
});
