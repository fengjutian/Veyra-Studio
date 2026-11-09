import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import {
  FONT_INLINE_MAX_BYTES,
  collectExportFonts,
  exportPageToHtml,
  exportPageToSvg,
  fontFaceCss,
  inlineFonts,
  matchFontDeclaration,
  packagedFontFaceCss,
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

test("points a packaged font face at the file inside the package", () => {
  const css = packagedFontFaceCss({
    family: "Press Start 2P",
    weight: 700,
    style: "italic",
    bytes: new Uint8Array([102, 111, 111]),
    mime: "font/woff2",
  }, "./fonts/PressStart2P-700i.woff2");
  assert.match(css, /@font-face \{/);
  assert.match(css, /font-family: "Press Start 2P";/);
  assert.match(css, /src: url\("\.\/fonts\/PressStart2P-700i\.woff2"\) format\("woff2"\);/);
  assert.match(css, /font-weight: 700;/);
  assert.match(css, /font-style: italic;/);
  // 打包模式不能退回 data URI：外链文件才是打包的意义所在。
  assert.doesNotMatch(css, /data:/);
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

test("puts the font faces into the exported SVG style block", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const css = fontFaceCss({ family: "Inter", weight: 400, style: "normal", bytes: new Uint8Array([1]), mime: "font/woff2" });
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 }, fontFaces: [css] });
  assert.match(result.svg, /@font-face \{/);
  assert.match(result.svg, /font-family: "Inter";/);
  // @font-face 要在根 <svg> 下的 <style> 里，且在使用它的文字之前。
  assert.ok(result.svg.indexOf("@font-face") < result.svg.indexOf("</svg>"));
  assert.ok(result.svg.indexOf("@font-face") < result.svg.indexOf("<text"));
});

test("keeps the old SVG export byte-identical when there are no font faces", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const withoutFaces = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 } });
  const emptyFaces = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 }, fontFaces: [] });
  assert.equal(withoutFaces.svg, emptyFaces.svg);
  assert.ok(!withoutFaces.svg.includes("@font-face"));
});

test("escapes XML special characters in the SVG font rules", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  // 规则文本里带 & 与 < ：写进 SVG 时必须转义，否则整个 XML 文档解析失败。
  const css = '@font-face { font-family: "A&B<C"; src: url(data:font/ttf;base64,AA==) format("truetype"); }';
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 }, fontFaces: [css] });
  assert.ok(result.svg.includes("A&amp;B&lt;C"));
  assert.ok(!/A&B<C/.test(result.svg));
});

test("quotes a family name that is not a bare CSS identifier", () => {
  // `2P` 以数字开头，不是合法标识符：不加引号整条 font-family 声明会作废。
  const document = documentWithTexts([{ family: "Press Start 2P", weight: 400 }]);
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 } });
  // style 属性里的引号被 XML 转义成 &quot;；XML 解析器会还原成真正的引号，CSS 才认得。
  assert.match(result.svg, /font-family:&quot;Press Start 2P&quot;/);
});

test("keeps a plain family name unquoted so old SVG exports stay byte-identical", () => {
  const document = documentWithTexts([{ family: "Inter", weight: 400 }]);
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.match(result.svg, /font-family:Inter;/);
  assert.ok(!result.svg.includes('font-family:"Inter"'));
});
