import { computePageLayout, type ComputedBox, type TextMeasurer } from "@ufira/design-layout";
import {
  TEXT_DEFAULTS,
  applyThemeForPage,
  applyTypographyToken,
  resolveCornerRadii,
  resolveFills,
  resolveParagraphs,
  resolveStroke,
  textRunSegmentsInRange,
  validateDocument,
  vectorPathCommands,
  type DesignDocument,
  type DesignNode,
  type TextNode,
} from "@ufira/design-schema";
import { exportNodeSet, exportRootIds } from "./selection";
import { assemblePdf, deflatePdfBytes } from "./pdf";
import { parseSfnt, type SfntFont } from "./truetype";
import type { ExportDiagnostic } from "./types";

/**
 * 矢量 PDF 导出（文字可选）。
 *
 * 与图像型 PDF 相反：这里写的是**矢量**内容——形状是路径、文字是文字对象。
 * 字体以 TrueType 子集内嵌（`Type0` / `Identity-H` + `CIDFontType2`），并附一份
 * `ToUnicode` CMap，所以文字**可选中、可搜索、可复制**。
 *
 * ## 三条取舍
 *
 * 1. **文字要有字体字节才能内嵌**。系统字体（用户没上传过的）没有字节，只能退到
 *    PDF 内置的 Helvetica——字形会不一样，诊断里会写明。文档里上传过的 `.ttf` /
 *    `.otf` 才能正确内嵌（`woff2` 是压缩容器，PDF 不认）。
 * 2. **不支持的效果明确报诊断**，不静默丢弃：图片、蒙版会标 `unsupported`，
 *    渐变、投影、混合模式标 `approximated`。
 * 3. **不换行**：与 SVG 导出一样，每个段落按一行排（段落样式只解决缩进与标记）。
 *
 * 规格见 `docs/vector-pdf.md`。
 */

/** 一份要内嵌的字体。 */
export interface VectorPdfFont {
  /** 字体字节（sfnt：TrueType / OpenType）。 */
  bytes: Uint8Array;
  /** 族名（写进 PDF 的 `BaseFont`）。 */
  family: string;
  bold: boolean;
  italic: boolean;
}

export interface VectorPdfOptions {
  viewport: { width: number; height: number };
  title?: string;
  /** 主题 id；导出前把该主题的覆盖合并进来。 */
  themeId?: string;
  textMeasurer?: TextMeasurer;
  /**
   * 内嵌字体：键是 `family weight style`（与 `fontUsageKey()` 一致）。
   *
   * 键不在这里的文字会退到内置 Helvetica，并记一条诊断。
   */
  fonts?: ReadonlyMap<string, VectorPdfFont>;
  /** 只导出包含这些节点的分支。 */
  nodeIds?: string[];
  /** 1 个设计像素对应多少 PDF 点；默认 0.75（96dpi → 72dpi）。 */
  pixelsPerPoint?: number;
}

export interface VectorPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  diagnostics: ExportDiagnostic[];
}

/** PDF 内置字体（不嵌入）的资源名。 */
const FALLBACK_FONT_RESOURCE = "Helv";

/** 一个已解析、准备写进 PDF 的字体。 */
interface EmbeddedFont {
  /** PDF 资源名（`F1`…）。 */
  resourceName: string;
  /** 原始字体字节（内嵌进 PDF 的就是它）。 */
  bytes: Uint8Array;
  sfnt: SfntFont;
  /** 子集名（`ABCDEF+Family`）。 */
  subsetName: string;
  bold: boolean;
  italic: boolean;
  /** 用到的字形：GID → Unicode。 */
  usedGlyphs: Map<number, number>;
}

/** 排版时用的字体（内嵌的或退化的）。 */
interface RunFont {
  resourceName: string;
  /** 字符的前进宽度比例（相对字号）。 */
  advanceRatio: (codePoint: number) => number;
  /** 字符 → 字形编号；退化字体没有字形映射。 */
  glyphId: (codePoint: number) => number;
  /** 上伸比例（基线之上的高度 / 字号）。 */
  ascentRatio: number;
  /** 是否是内嵌字体（决定用十六进制 GID 还是字面串）。 */
  embedded: boolean;
}

/** PDF 对象收集器。 */
class PdfObjects {
  private readonly bodies: Uint8Array[] = [];

  add(body: Uint8Array): number {
    this.bodies.push(body);
    return this.bodies.length;
  }

  /** 覆盖某个对象的内容（页树要在页对象都写完才知道 kids）。 */
  replace(number: number, body: Uint8Array): void {
    this.bodies[number - 1] = body;
  }

  build(rootNumber: number, infoNumber: number): Uint8Array {
    return assemblePdf(this.bodies, rootNumber, infoNumber);
  }
}

/** 导出上下文。 */
interface Context {
  /** 当前页的主题合并结果。 */
  document: DesignDocument;
  boxes: Record<string, ComputedBox>;
  scale: number;
  pageHeightPoints: number;
  diagnostics: ExportDiagnostic[];
  /** 内嵌字体：用法键 → 字体。 */
  embedded: Map<string, EmbeddedFont>;
  /** 排版时用到的字体：用法键 → 运行字体。 */
  runFonts: Map<string, RunFont>;
  /** 退化的内置字体（按需创建）。 */
  fallback: RunFont | undefined;
  /** 透明度状态：名称 → 透明度。 */
  extGStates: Map<string, number>;
}

/** 去掉多余小数位。 */
function num(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** 颜色（`#rgb` / `#rrggbb` / `rgb(...)`）→ PDF 的 0–1 分量。 */
export function parsePdfColor(color: string): { r: number; g: number; b: number } | undefined {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const full = digits.length === 3 ? digits.split("").map(digit => digit + digit).join("") : digits;
    return {
      r: parseInt(full.slice(0, 2), 16) / 255,
      g: parseInt(full.slice(2, 4), 16) / 255,
      b: parseInt(full.slice(4, 6), 16) / 255,
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1]!.split(",").map(part => Number(part.trim()));
    if (parts.length >= 3 && parts.every(part => Number.isFinite(part))) {
      return { r: (parts[0]! % 256) / 255, g: (parts[1]! % 256) / 255, b: (parts[2]! % 256) / 255 };
    }
  }
  return undefined;
}

/** 圆角系数：四分之一圆弧的贝塞尔近似。 */
const KAPPA = 0.5522847498307936;

/**
 * 导出整份文档为矢量 PDF。
 *
 * 每页一个内容流；字体与透明度状态是全文档共享的资源。
 */
export async function exportDocumentToVectorPdf(
  documentInput: DesignDocument,
  options: VectorPdfOptions,
): Promise<VectorPdfResult> {
  const validated = validateDocument(documentInput);
  const scale = options.pixelsPerPoint ?? 0.75;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("pixelsPerPoint 必须是正数");
  const diagnostics: ExportDiagnostic[] = [];

  const pageIds = validated.pageOrder.filter(pageId => validated.pages[pageId]);
  if (!pageIds.length) throw new Error("PDF 至少要一页");

  const context: Context = {
    document: validated,
    boxes: {},
    scale,
    pageHeightPoints: options.viewport.height * scale,
    diagnostics,
    embedded: new Map(),
    runFonts: new Map(),
    fallback: undefined,
    extGStates: new Map(),
  };

  // 字体先登记：资源名必须在排版前定下来，内容流里要引用它。
  let fontIndex = 0;
  for (const [key, font] of options.fonts ?? []) {
    fontIndex += 1;
    registerEmbeddedFont(context, key, font, `F${fontIndex}`);
  }

  // 先把每一页的内容流排出来（这一步会把用到的字形登记进字体）。
  const contents: string[] = [];
  for (const pageId of pageIds) {
    contents.push(renderPage(context, validated, pageId, options));
  }

  // 对象收集器：字体要先写好——页的 /Resources 要引用它们的对象编号。
  const objects = new PdfObjects();

  // 字体对象：Type0 + CIDFontType2 + FontDescriptor + FontFile2 + ToUnicode。
  const fontEntries: string[] = [];
  for (const font of context.embedded.values()) {
    const objectNumber = await writeEmbeddedFont(objects, font);
    fontEntries.push(`/${font.resourceName} ${objectNumber} 0 R`);
  }
  let fallbackObject: number | undefined;
  if (context.fallback) {
    fallbackObject = objects.add(ascii(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ));
    fontEntries.push(`/${FALLBACK_FONT_RESOURCE} ${fallbackObject} 0 R`);
  }

  // 透明度状态对象。
  const gsObjects = new Map<string, number>();
  for (const [name, opacity] of context.extGStates) {
    gsObjects.set(name, objects.add(ascii(
      `<< /Type /ExtGState /ca ${num(opacity)} /CA ${num(opacity)} >>`,
    )));
  }

  const pagesObject = objects.add(ascii(""));
  const kids: number[] = [];
  for (let index = 0; index < pageIds.length; index += 1) {
    const content = contents[index]!;
    const raw = new TextEncoder().encode(content);
    const compressed = await deflatePdfBytes(raw);
    const filter = compressed.length === raw.length ? "" : " /Filter /FlateDecode";
    const contentObject = objects.add(concatBytes([
      ascii(`<< /Length ${compressed.length}${filter} >>\nstream\n`),
      compressed,
      ascii("\nendstream"),
    ]));

    const gsEntries = [...gsObjects.entries()].map(([name, number]) => `/${name} ${number} 0 R`);
    const resources = `<< /Font << ${fontEntries.join(" ")} >>${gsEntries.length ? ` /ExtGState << ${gsEntries.join(" ")} >>` : ""} >>`;
    const pageObject = objects.add(ascii(
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${num(options.viewport.width * scale)} ${num(options.viewport.height * scale)}] `
      + `/Resources ${resources} /Contents ${contentObject} 0 R >>`,
    ));
    kids.push(pageObject);
  }

  objects.replace(pagesObject, ascii(`<< /Type /Pages /Kids [${kids.map(kid => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`));

  const catalog = objects.add(ascii(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`));
  const info = objects.add(ascii(`<< /Title ${pdfTextString(options.title ?? "Veyra")} /Producer ${pdfTextString("Veyra")} >>`));

  return { bytes: objects.build(catalog, info), pageCount: pageIds.length, diagnostics };
}

/** 渲染一页的内容流。 */
function renderPage(
  context: Context,
  validated: DesignDocument,
  pageId: string,
  options: VectorPdfOptions,
): string {
  // 页面主题在这一页生效（暗色演示页）。
  context.document = applyThemeForPage(validated, pageId, options.themeId);
  const document = context.document;
  try {
    context.boxes = computePageLayout(document, pageId, {
      viewport: options.viewport,
      textMeasurer: options.textMeasurer,
    }).boxes;
  } catch (error) {
    context.diagnostics.push({
      feature: "pdf-vector-layout",
      support: "approximated",
      message: `布局算不出来，退回节点自身的位置：${error instanceof Error ? error.message : String(error)}`,
    });
    context.boxes = {};
  }

  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const parts: string[] = [];
  // 页面坐标变换：设计坐标（左上原点、向下）→ PDF 坐标（左下原点、向上）。
  // 文字用 `1 0 0 -1 x y Tm` 把字形翻回来。
  parts.push(`q\n${num(context.scale)} 0 0 ${num(-context.scale)} 0 ${num(context.pageHeightPoints)} cm\n`);
  for (const rootId of exportRootIds(document, pageId, keep)) {
    renderNode(context, rootId, parts, keep);
  }
  parts.push("Q\n");
  return parts.join("");
}

/** 渲染一个节点及其子节点。 */
function renderNode(context: Context, nodeId: string, parts: string[], keep: Set<string> | undefined): void {
  const node = context.document.nodes[nodeId];
  if (!node) return;
  if (keep && !keep.has(nodeId)) return;
  if (!node.visible) return;

  const box = context.boxes[nodeId] ?? {
    x: node.layout.x,
    y: node.layout.y,
    width: node.layout.width,
    height: node.layout.height,
  };

  if (node.type === "text") {
    renderText(context, node, box, parts);
  } else if (node.type === "ellipse") {
    renderEllipse(context, node, box, parts);
  } else if (node.type === "vector") {
    renderVector(context, node, box, parts);
  } else if (node.type === "image") {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "pdf-vector-image",
      support: "unsupported",
      message: "矢量 PDF 不含图片：图片需要位图解码，这一版没做。需要带图的交付物请用图像型 PDF。",
    });
  } else {
    renderRect(context, node, box, parts);
  }

  if (node.appearance.blendMode && node.appearance.blendMode !== "normal") {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "pdf-vector-blend",
      support: "approximated",
      message: `混合模式「${node.appearance.blendMode}」在矢量 PDF 里按普通混合处理`,
    });
  }
  if (node.appearance.shadow) {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "pdf-vector-shadow",
      support: "approximated",
      message: "投影在矢量 PDF 里没有画出来",
    });
  }
  if (node.mask) {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "pdf-vector-mask",
      support: "unsupported",
      message: "蒙版在矢量 PDF 里没有生效",
    });
  }

  for (const childId of node.childIds) renderNode(context, childId, parts, keep);
}

/** 矩形（含圆角）。 */
function renderRect(context: Context, node: DesignNode, box: ComputedBox, parts: string[]): void {
  const radii = resolveCornerRadii(context.document, node);
  const fill = firstSolidFill(context, node);
  const stroke = resolveStroke(context.document, node);
  if (!fill && !stroke) return;
  parts.push("q\n");
  parts.push(opacitySetup(context, node));
  parts.push(`${roundedRectPath(box, radii)}\n`);
  if (fill) parts.push(`${fill} rg\nf\n`);
  if (stroke) parts.push(`${strokeColor(stroke)} RG\n${num(node.appearance.strokeWidth ?? 1)} w\nS\n`);
  parts.push("Q\n");
}

/** 椭圆。 */
function renderEllipse(context: Context, node: DesignNode, box: ComputedBox, parts: string[]): void {
  const fill = firstSolidFill(context, node);
  const stroke = resolveStroke(context.document, node);
  if (!fill && !stroke) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  parts.push("q\n");
  parts.push(opacitySetup(context, node));
  parts.push(`${num(cx + rx)} ${num(cy)} m\n`);
  parts.push(`${num(cx + rx)} ${num(cy + ky)} ${num(cx + kx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c\n`);
  parts.push(`${num(cx - kx)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ky)} ${num(cx - rx)} ${num(cy)} c\n`);
  parts.push(`${num(cx - rx)} ${num(cy - ky)} ${num(cx - kx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c\n`);
  parts.push(`${num(cx + kx)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ky)} ${num(cx + rx)} ${num(cy)} c\nh\n`);
  if (fill) parts.push(`${fill} rg\nf\n`);
  if (stroke) parts.push(`${strokeColor(stroke)} RG\n${num(node.appearance.strokeWidth ?? 1)} w\nS\n`);
  parts.push("Q\n");
}

/** 矢量路径（节点自身的 `d` 是归一化的）。 */
function renderVector(context: Context, node: DesignNode, box: ComputedBox, parts: string[]): void {
  const geometry = node.type === "vector" ? node.geometry : undefined;
  if (!geometry || geometry.kind !== "path") return;
  const commands = vectorPathCommands(geometry.d);
  if (!commands.length) return;
  const fill = firstSolidFill(context, node);
  const stroke = resolveStroke(context.document, node);
  if (!fill && !stroke) return;

  // 归一化坐标 → 节点盒里的绝对坐标。
  const at = (x: number, y: number): [number, number] => [box.x + x * box.width, box.y + y * box.height];
  let current: [number, number] = [0, 0];
  const operators: string[] = [];
  for (const command of commands) {
    if (command.command === "M" || command.command === "L") {
      const [x, y] = at(command.point.x, command.point.y);
      current = [x, y];
      operators.push(`${num(x)} ${num(y)} ${command.command === "M" ? "m" : "l"}`);
    } else if (command.command === "C") {
      const [x1, y1] = at(command.control1.x, command.control1.y);
      const [x2, y2] = at(command.control2.x, command.control2.y);
      const [x, y] = at(command.point.x, command.point.y);
      operators.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`);
      current = [x, y];
    } else if (command.command === "Q") {
      const [cx, cy] = at(command.control.x, command.control.y);
      const [x, y] = at(command.point.x, command.point.y);
      // PDF 没有二次曲线：转成等价的贝塞尔。
      const c1x = current[0] + (2 / 3) * (cx - current[0]);
      const c1y = current[1] + (2 / 3) * (cy - current[1]);
      const c2x = x + (2 / 3) * (cx - x);
      const c2y = y + (2 / 3) * (cy - y);
      operators.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(x)} ${num(y)} c`);
      current = [x, y];
    } else {
      operators.push("h");
    }
  }

  parts.push("q\n");
  parts.push(opacitySetup(context, node));
  parts.push(`${operators.join("\n")}\n`);
  if (fill) parts.push(`${fill} rg\nf\n`);
  if (stroke) parts.push(`${strokeColor(stroke)} RG\n${num(node.appearance.strokeWidth ?? 1)} w\nS\n`);
  parts.push("Q\n");
}

/** 圆角矩形的路径（设计坐标）。 */
function roundedRectPath(box: ComputedBox, radii: [number, number, number, number] | undefined): string {
  const x = box.x;
  const y = box.y;
  const width = box.width;
  const height = box.height;
  if (!radii) {
    return `${num(x)} ${num(y)} m\n${num(x + width)} ${num(y)} l\n${num(x + width)} ${num(y + height)} l\n${num(x)} ${num(y + height)} l\nh`;
  }
  const limit = Math.min(width, height) / 2;
  const [topLeft, topRight, bottomRight, bottomLeft] = radii.map(radius => Math.max(0, Math.min(radius, limit)));
  const parts: string[] = [];
  parts.push(`${num(x + topLeft)} ${num(y)} m`);
  parts.push(`${num(x + width - topRight)} ${num(y)} l`);
  if (topRight) parts.push(`${num(x + width - topRight + topRight * KAPPA)} ${num(y)} ${num(x + width)} ${num(y + topRight - topRight * KAPPA)} ${num(x + width)} ${num(y + topRight)} c`);
  parts.push(`${num(x + width)} ${num(y + height - bottomRight)} l`);
  if (bottomRight) parts.push(`${num(x + width)} ${num(y + height - bottomRight + bottomRight * KAPPA)} ${num(x + width - bottomRight + bottomRight * KAPPA)} ${num(y + height)} ${num(x + width - bottomRight)} ${num(y + height)} c`);
  parts.push(`${num(x + bottomLeft)} ${num(y + height)} l`);
  if (bottomLeft) parts.push(`${num(x + bottomLeft - bottomLeft * KAPPA)} ${num(y + height)} ${num(x)} ${num(y + height - bottomLeft + bottomLeft * KAPPA)} ${num(x)} ${num(y + height - bottomLeft)} c`);
  parts.push(`${num(x)} ${num(y + topLeft)} l`);
  if (topLeft) parts.push(`${num(x)} ${num(y + topLeft - topLeft * KAPPA)} ${num(x + topLeft - topLeft * KAPPA)} ${num(y)} ${num(x + topLeft)} ${num(y)} c`);
  parts.push("h");
  return parts.join("\n");
}

/** 节点的第一层纯色填充（渐变会报诊断）。 */
function firstSolidFill(context: Context, node: DesignNode): string | undefined {
  const fills = resolveFills(context.document, node);
  if (!fills.length) return undefined;
  const first = fills[0]!;
  if (first.type !== "solid") {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "pdf-vector-gradient",
      support: "approximated",
      message: "渐变填充在矢量 PDF 里按第一档颜色近似",
    });
    const stop = first.stops[0];
    if (!stop) return undefined;
    return colorComponents(stop.color);
  }
  return colorComponents(first.color);
}

/** 颜色 → PDF 的 `r g b` 分量字符串。 */
function colorComponents(color: string): string | undefined {
  const parsed = parsePdfColor(color);
  if (!parsed) return undefined;
  return `${num(parsed.r)} ${num(parsed.g)} ${num(parsed.b)}`;
}

/** 描边颜色。 */
function strokeColor(color: string): string {
  return colorComponents(color) ?? "0 0 0";
}

/**
 * 透明度设置。
 *
 * PDF 的透明度是图形状态（`/ExtGState`），不是绘制属性，所以同一个透明度值
 * 只建一个对象。状态名在创建时定下来（`GS1`…），对象稍后再写。
 */
function opacitySetup(context: Context, node: DesignNode): string {
  const opacity = node.appearance.opacity;
  if (opacity === undefined || opacity >= 1) return "";
  let name = [...context.extGStates.keys()].find(key => context.extGStates.get(key) === opacity);
  if (!name) {
    name = `GS${context.extGStates.size + 1}`;
    context.extGStates.set(name, opacity);
  }
  return `/${name} gs\n`;
}

/** 文本。 */
function renderText(context: Context, node: DesignNode, box: ComputedBox, parts: string[]): void {
  const text = applyTypographyToken(context.document, node) as TextNode;
  const paragraphs = resolveParagraphs(text.text, text.paragraphStyles);
  if (!paragraphs.length) return;

  for (const [index, paragraph] of paragraphs.entries()) {
    const segments = textRunSegmentsInRange(text.text, text.runs, paragraph.start, paragraph.end);
    const lineHeight = text.lineHeight;
    // 与 SVG 一致：段落的顶部就是行顶，基线在行顶往下走一个上伸高度。
    const top = box.y + index * lineHeight;
    const left = box.x + paragraph.left;

    for (const segment of segments) {
      if (!segment.text) continue;
      const fontSize = segment.style.fontSize ?? text.fontSize;
      const weight = segment.style.fontWeight ?? text.fontWeight ?? TEXT_DEFAULTS.fontWeight;
      const style = segment.style.fontStyle ?? text.fontStyle ?? TEXT_DEFAULTS.fontStyle;
      const runFont = resolveRunFont(context, text.fontFamily, weight, style);
      const width = measureText(segment.text, runFont, fontSize);
      const align = text.textAlign ?? TEXT_DEFAULTS.textAlign;
      let x = left;
      if (align === "center") x = left + (box.width - paragraph.left - width) / 2;
      else if (align === "right") x = box.x + box.width - width;
      const baseline = top + runFont.ascentRatio * fontSize;
      const color = colorComponents(segment.style.color ?? resolveTextColor(context, text));
      parts.push("q\n");
      if (color) parts.push(`${color} rg\n`);
      parts.push(`BT\n/${runFont.resourceName} ${num(fontSize)} Tf\n`);
      // 页面坐标系是翻转的，文字矩阵再翻回来，字形才是正的。
      parts.push(`1 0 0 -1 ${num(x)} ${num(baseline)} Tm\n`);
      parts.push(`${encodeText(segment.text, runFont)} Tj\nET\n`);
      parts.push("Q\n");
    }
  }
}

/** 文字颜色：没有段内颜色时用节点的填充色，再没有就用黑色。 */
function resolveTextColor(context: Context, node: TextNode): string {
  const fills = resolveFills(context.document, node);
  const first = fills[0];
  if (first?.type === "solid") return first.color;
  if (first) return first.stops[0]?.color ?? "#000000";
  return "#000000";
}

/** 量一段文字的宽度（设计像素）。 */
function measureText(text: string, font: RunFont, fontSize: number): number {
  let total = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    total += font.advanceRatio(codePoint) * fontSize;
  }
  return total;
}

/** 文字编码：内嵌字体写 GID（十六进制），退化字体写字面串。 */
function encodeText(text: string, font: RunFont): string {
  if (!font.embedded) {
    let literal = "";
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      // WinAnsi 只覆盖到 U+00FF；更深的码位写不出来，跳过。
      if (code > 0xff) continue;
      literal += `\\${code.toString(8).padStart(3, "0")}`;
    }
    return `(${literal})`;
  }
  let hex = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    hex += font.glyphId(codePoint).toString(16).padStart(4, "0");
  }
  return `<${hex}>`;
}

/** 取一段文字用的字体（内嵌的优先）。 */
function resolveRunFont(context: Context, family: string, weight: number, style: "normal" | "italic"): RunFont {
  const key = `${family} ${weight} ${style}`;
  const embedded = context.embedded.get(key);
  if (embedded) {
    let run = context.runFonts.get(key);
    if (!run) {
      run = {
        resourceName: embedded.resourceName,
        advanceRatio: (codePoint: number) => {
          const glyph = embedded.sfnt.glyphIdFor(codePoint);
          return embedded.sfnt.advanceWidth(glyph) / embedded.sfnt.unitsPerEm;
        },
        glyphId: (codePoint: number) => {
          const glyph = embedded.sfnt.glyphIdFor(codePoint);
          if (glyph) embedded.usedGlyphs.set(glyph, codePoint);
          return glyph;
        },
        ascentRatio: embedded.sfnt.ascent / embedded.sfnt.unitsPerEm,
        embedded: true,
      };
      context.runFonts.set(key, run);
    }
    return run;
  }
  if (!context.fallback) {
    context.fallback = {
      resourceName: FALLBACK_FONT_RESOURCE,
      advanceRatio: () => 0.5,
      glyphId: () => 0,
      ascentRatio: 0.75,
      embedded: false,
    };
  }
  context.diagnostics.push({
    feature: "pdf-vector-font",
    support: "approximated",
    message: `字体「${key}」没有可内嵌的字节，已改用 PDF 内置 Helvetica：字形与设计稿不同`,
  });
  return context.fallback;
}

/**
 * 写入一个内嵌字体，返回 Type0 字体对象的编号。
 *
 * 五个对象：`FontFile2`（字体本体）、`FontDescriptor`、`CIDFontType2`、
 * `ToUnicode`（CMap）、`Type0`（顶层字体）。
 */
async function writeEmbeddedFont(objects: PdfObjects, font: EmbeddedFont): Promise<number> {
  const sfnt = font.sfnt;
  const compressed = await deflatePdfBytes(font.bytes);
  const fontFile2 = objects.add(concatBytes([
    ascii(`<< /Length1 ${font.bytes.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
    compressed,
    ascii("\nendstream"),
  ]));

  const widths = new Map<number, number>();
  for (const glyph of font.usedGlyphs.keys()) {
    widths.set(glyph, Math.round((sfnt.advanceWidth(glyph) * 1000) / sfnt.unitsPerEm));
  }

  // /W 数组：按字形编号排序后分段写出。
  const sorted = [...widths.entries()].sort((left, right) => left[0] - right[0]);
  const wParts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index]!;
    const group: number[] = [];
    while (index < sorted.length && sorted[index]![0] === start[0] + group.length) {
      group.push(sorted[index]![1]);
      index += 1;
    }
    wParts.push(`${start[0]} [${group.join(" ")}]`);
  }

  const flags = 4 | (font.italic ? 64 : 0) | (font.bold ? 1 << 18 : 0);
  const bbox = [
    Math.round((sfnt.bbox.xMin * 1000) / sfnt.unitsPerEm),
    Math.round((sfnt.bbox.yMin * 1000) / sfnt.unitsPerEm),
    Math.round((sfnt.bbox.xMax * 1000) / sfnt.unitsPerEm),
    Math.round((sfnt.bbox.yMax * 1000) / sfnt.unitsPerEm),
  ];
  const descriptor = objects.add(ascii(
    `<< /Type /FontDescriptor /FontName /${font.subsetName} /Flags ${flags} `
    + `/FontBBox [${bbox.join(" ")}] /ItalicAngle ${num(sfnt.italicAngle)} `
    + `/Ascent ${Math.round((sfnt.ascent * 1000) / sfnt.unitsPerEm)} /Descent ${Math.round((sfnt.descent * 1000) / sfnt.unitsPerEm)} `
    + `/CapHeight ${Math.round((sfnt.capHeight * 1000) / sfnt.unitsPerEm)} /StemV 80 /FontFile2 ${fontFile2} 0 R >>`,
  ));
  const cidFont = objects.add(ascii(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.subsetName} `
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
    + `/FontDescriptor ${descriptor} 0 R /DW 1000${wParts.length ? ` /W [${wParts.join(" ")}]` : ""} /CIDToGIDMap /Identity >>`,
  ));

  const cmap = buildToUnicodeCMap(font.usedGlyphs);
  const toUnicode = objects.add(concatBytes([
    ascii(`<< /Length ${cmap.length} >>\nstream\n`),
    cmap,
    ascii("\nendstream"),
  ]));

  return objects.add(ascii(
    `<< /Type /Font /Subtype /Type0 /BaseFont /${font.subsetName} /Encoding /Identity-H `
    + `/DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
  ));
}

/**
 * 生成 `ToUnicode` CMap：GID → Unicode。
 *
 * 没有它，PDF 里的文字虽然能显示，但**搜不到、复制不出来**——读者拿到的是
 * 一堆无意义的编码。读者按下 Ctrl+F 找不到字，这是「文字可选」最关键的一步。
 */
export function buildToUnicodeCMap(usedGlyphs: Map<number, number>): Uint8Array {
  const entries = [...usedGlyphs.entries()].sort((left, right) => left[0] - right[0]);
  const lines: string[] = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ];
  // bfchar 一段最多 100 条，超了要另起一段。
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [glyph, codePoint] of chunk) {
      lines.push(`<${glyph.toString(16).padStart(4, "0")}> <${utf16be(codePoint)}>`);
    }
    lines.push("endbfchar");
  }
  lines.push("endcmap");
  lines.push("CMapName currentdict /CMap defineresource pop");
  lines.push("end");
  lines.push("end");
  return ascii(lines.join("\n"));
}

/** 码点 → UTF-16BE 十六进制（超过 BMP 的用代理对）。 */
function utf16be(codePoint: number): string {
  if (codePoint > 0xffff) {
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return high.toString(16).padStart(4, "0") + low.toString(16).padStart(4, "0");
  }
  return codePoint.toString(16).padStart(4, "0");
}

/** PDF 文本串。 */
function pdfTextString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/([\\()])/g, "\\$1")})`;
  let hex = "FEFF";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    hex += code.toString(16).padStart(4, "0");
  }
  return `<${hex.toUpperCase()}>`;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
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

/** 子集标记：PDF 要求 6 位大写字母（`ABCDEF+Family`）。 */
export function subsetTag(family: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < family.length; index += 1) {
    hash ^= family.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let tag = "";
  let value = hash;
  for (let index = 0; index < 6; index += 1) {
    tag = String.fromCharCode(65 + (value % 26)) + tag;
    value = Math.floor(value / 26);
  }
  return tag;
}

/** 解析一个字体并登记进上下文。 */
function registerEmbeddedFont(context: Context, key: string, font: VectorPdfFont, resourceName: string): void {
  try {
    const sfnt = parseSfnt(font.bytes);
    context.embedded.set(key, {
      resourceName,
      bytes: font.bytes,
      sfnt,
      subsetName: `${subsetTag(font.family)}+${font.family.replace(/[^A-Za-z0-9]/g, "")}`,
      bold: font.bold,
      italic: font.italic,
      usedGlyphs: new Map(),
    });
  } catch (error) {
    context.diagnostics.push({
      feature: "pdf-vector-font",
      support: "approximated",
      message: `字体「${key}」解析失败，改用内置 Helvetica：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
