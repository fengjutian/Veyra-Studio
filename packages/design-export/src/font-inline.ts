import { TEXT_DEFAULTS, applyTypographyToken, type DesignDocument, type DocumentFont, type TextNode } from "@ufira/design-schema";
import { exportNodeSet, exportRootIds } from "./selection";
import { base64FromBytes } from "./base64";

/**
 * 导出物内联字体。
 *
 * 导出的 HTML 里只有 `font-family:"…"` 时，对方机器上没装这个字体就会走回退字形——
 * 交付稿和设计稿字形不同。本模块把文档声明过的字体文件内联进 `@font-face`。
 *
 * 规格见 `docs/font-inline.md`。
 */

/**
 * 内联上限（字节）。
 *
 * 内联会让 HTML 体积增加约 33%（base64 的代价），所以过大的字体不内联，
 * 改成记一条诊断——让用户知道「字会变」，而不是悄悄交付一份字形不对的文件。
 */
export const FONT_INLINE_MAX_BYTES = 1024 * 1024;

/** 导出范围内用到的字体。 */
export interface ExportFontUsage {
  family: string;
  weight: number;
  style: "normal" | "italic";
}

/** 一份准备内联的字体。 */
export interface InlineFont {
  family: string;
  weight: number;
  style: "normal" | "italic";
  bytes: Uint8Array;
  /** 资产的 MIME（`font/woff2` 等），决定 data URI 与 `format()`。 */
  mime: string;
}

/** 内联失败或被跳过时的原因。 */
export interface FontInlineNote {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** 字节数；被跳过时用于说明有多大。 */
  byteLength: number;
  reason: "too-large" | "weight-mismatch";
}

/** 内联结果：CSS 片段 + 需要人知道的注意事项。 */
export interface FontInlineResult {
  /** `@font-face` 规则（已拼好）。 */
  css: string;
  notes: FontInlineNote[];
}

/**
 * 收集导出范围内用到的字体。
 *
 * 只看文本节点：形状、图片不需要字体。同一族名的不同字重/字形是**不同的**条目——
 * 内联时每个 `(family, weight, style)` 一条 `@font-face`。
 */
export function collectExportFonts(
  document: DesignDocument,
  options: { pageId: string; nodeIds?: readonly string[] },
): ExportFontUsage[] {
  const page = document.pages[options.pageId];
  if (!page) return [];
  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const found = new Map<string, ExportFontUsage>();
  const walk = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    if (keep && !keep.has(nodeId)) return;
    if (node.type === "text") {
      // 字体 token 生效后的族名/字重/字形才是导出物真正要用的字体。
      const text = applyTypographyToken(document, node) as TextNode;
      const family = text.fontFamily;
      const weight = text.fontWeight ?? TEXT_DEFAULTS.fontWeight;
      const style = text.fontStyle ?? TEXT_DEFAULTS.fontStyle;
      const key = `${family} ${weight} ${style}`;
      if (!found.has(key)) found.set(key, { family, weight, style });
    }
    for (const childId of node.childIds) walk(childId);
  };
  for (const rootId of exportRootIds(document, options.pageId, keep)) walk(rootId);
  return [...found.values()];
}

/**
 * 在文档的字体声明里找一条能用的。
 *
 * 优先精确匹配 `(family, weight, style)`；找不到就退回同族名的任意一条——
 * 但那意味着字重对不上，用它内联出来的字形和设计稿不一样，所以要记一条 note。
 */
export function matchFontDeclaration(
  fonts: readonly DocumentFont[] | undefined,
  usage: ExportFontUsage,
): { declaration: DocumentFont; exact: boolean } | undefined {
  const familyFonts = (fonts ?? []).filter(font => font.family === usage.family);
  if (!familyFonts.length) return undefined;
  const exact = familyFonts.find(font =>
    (font.weight ?? TEXT_DEFAULTS.fontWeight) === usage.weight
    && (font.style ?? TEXT_DEFAULTS.fontStyle) === usage.style);
  if (exact) return { declaration: exact, exact: true };
  // 退化匹配：同族名的第一条（优先常规体）。
  const fallback = familyFonts.find(font => (font.style ?? TEXT_DEFAULTS.fontStyle) === "normal") ?? familyFonts[0]!;
  return { declaration: fallback, exact: false };
}

/**
 * 收集导出范围内每个字体**用到的字符**。
 *
 * 子集化需要知道「哪些字形必须留下」——键与 {@link collectExportFonts} 一致
 * （`family weight style`），值是这些文本节点的全部文字。
 */
export function collectExportFontTexts(
  document: DesignDocument,
  options: { pageId: string; nodeIds?: readonly string[] },
): Map<string, string> {
  const page = document.pages[options.pageId];
  if (!page) return new Map();
  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const texts = new Map<string, string[]>();
  const walk = (nodeId: string): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    if (keep && !keep.has(nodeId)) return;
    if (node.type === "text") {
      const key = fontUsageKey(node.fontFamily, node.fontWeight ?? TEXT_DEFAULTS.fontWeight, node.fontStyle ?? TEXT_DEFAULTS.fontStyle);
      const bucket = texts.get(key);
      if (bucket) bucket.push(node.text);
      else texts.set(key, [node.text]);
    }
    for (const childId of node.childIds) walk(childId);
  };
  for (const rootId of exportRootIds(document, options.pageId, keep)) walk(rootId);
  return new Map([...texts].map(([key, values]) => [key, values.join("")]));
}

/** 字体条目的键：族名 + 字重 + 字形。 */
export function fontUsageKey(family: string, weight: number, style: "normal" | "italic"): string {
  return `${family} ${weight} ${style}`;
}

/**
 * 生成 `@font-face` 规则。
 *
 * `font-display: swap`：字体解码期间先用回退字形，不出现白屏。
 */
export function fontFaceCss(font: InlineFont): string {
  return [
    "@font-face {",
    `  font-family: ${cssFontFamily(font.family)};`,
    `  src: url(${fontDataUrl(font.bytes, font.mime)}) format("${fontFormat(font.mime)}");`,
    `  font-weight: ${font.weight};`,
    `  font-style: ${font.style};`,
    "  font-display: swap;",
    "}",
  ].join("\n");
}

/**
 * 包内相对路径的 `@font-face` 规则。
 *
 * 与 {@link fontFaceCss} 只差一处：`src` 指向包里的文件，而不是 data URI。
 *
 * 打包交付物里字体是独立文件，所以**不受内联上限约束**——1 MB 的上限是为了
 * 控制 base64 膨胀（体积涨约 33%），外链文件没有这个问题。规格见
 * `docs/asset-packaging.md`。
 *
 * `path` 必须是包内相对路径（`./fonts/Inter-400.woff2`）：绝对路径或带 scheme
 * 的地址会让交付物跑到包外面去。
 */
export function packagedFontFaceCss(font: InlineFont, path: string): string {
  return [
    "@font-face {",
    `  font-family: ${cssFontFamily(font.family)};`,
    `  src: url("${path}") format("${fontFormat(font.mime)}");`,
    `  font-weight: ${font.weight};`,
    `  font-style: ${font.style};`,
    "  font-display: swap;",
    "}",
  ].join("\n");
}

/**
 * 把字体整理成可内联的结果。
 *
 * 超过上限的不内联，改为记 note——「字会变」这件事必须让人看见。
 */
export function inlineFonts(fonts: readonly InlineFont[]): FontInlineResult {
  const css: string[] = [];
  const notes: FontInlineNote[] = [];
  for (const font of fonts) {
    if (font.bytes.byteLength > FONT_INLINE_MAX_BYTES) {
      notes.push({ family: font.family, weight: font.weight, style: font.style, byteLength: font.bytes.byteLength, reason: "too-large" });
      continue;
    }
    css.push(fontFaceCss(font));
  }
  return { css: css.join("\n"), notes };
}

/** data URI：`data:<mime>;base64,<...>`。 */
export function fontDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${base64FromBytes(bytes)}`;
}

/** CSS 的 `format()` 描述符。 */
export function fontFormat(mime: string): string {
  switch (mime.toLowerCase()) {
    case "font/woff2":
    case "application/font-woff2":
      return "woff2";
    case "font/woff":
    case "application/font-woff":
      return "woff";
    case "font/otf":
    case "application/font-otf":
      return "opentype";
    default:
      return "truetype";
  }
}

/**
 * 族名加引号（族名里有空格或引号时必须加）。
 */
function cssFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}"`;
}

/** 供测试与诊断用：字体声明的显示名。 */
export function fontDeclarationLabel(font: DocumentFont): string {
  const weight = font.weight ?? TEXT_DEFAULTS.fontWeight;
  const style = font.style ?? TEXT_DEFAULTS.fontStyle;
  return style === "italic" ? `${font.family} ${weight} ${style}` : `${font.family} ${weight}`;
}
