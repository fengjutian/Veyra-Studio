import type { ExportDiagnostic } from "./types";

/**
 * PDF 导出（图像型）。
 *
 * ## 这一版导出的是什么
 *
 * **每页一张位图**。这是 PDF 里最不容易出错的一种形态：页面尺寸、缩放、色彩都由
 * PDF 自己保证，设计稿长什么样，PDF 里就是什么样。
 *
 * 代价说清楚：**文字不可选、不可搜索**（它是像素），文件体积比矢量 PDF 大。
 * 矢量 PDF（文字可选、内嵌 TrueType 子集）是另一条路——那要处理字体子集、
 * 字形映射与文本排版，本版没做，路线图里如实标着。
 *
 * ## 为什么不用任何依赖
 *
 * PDF 本身是个文本格式的对象表，几百行就能写完。图像数据用 Flate 压缩——浏览器
 * 与 Node 都有原生的 `CompressionStream("deflate")`（输出正好就是 PDF 的
 * `/FlateDecode` 要的 zlib 流），不必引第三方库。没有压缩流的环境退化成不压缩，
 * 产物照样合法。
 *
 * ## 确定性
 *
 * 同样的输入产出同样的字节：没有时间戳、没有随机 id、对象顺序固定。资源包里
 * 「同样输入产出同样字节」那条约定在这里也成立。
 */

export interface PdfRasterPage {
  /** RGBA 像素，逐行紧密排列（4 字节一个像素）。 */
  pixels: Uint8Array;
  width: number;
  height: number;
  /**
   * 页面在 PDF 里的宽度（点）。
   *
   * 不给就按 `像素 × pixelsPerPoint` 算。给了它，位图可以按更高分辨率渲染
   * （2× 的像素放进同样大小的页面），而页面尺寸不变。
   */
  widthPoints?: number;
  /** 页面在 PDF 里的高度（点）。 */
  heightPoints?: number;
}

export interface PdfExportOptions {
  /** 文档标题（写进 PDF 元信息）。 */
  title?: string;
  /**
   * 1 个设计像素对应多少 PDF 点（1/72 英寸）。
   *
   * 默认 0.75：CSS 的 96dpi 换算到 PDF 的 72dpi。960×680 的画布因此是
   * 720×510 点（10 × 7.08 英寸），正好是一张横向 Letter 纸的大小。
   */
  pixelsPerPoint?: number;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  pageCount: number;
  diagnostics: ExportDiagnostic[];
}

/** 96dpi → 72dpi。 */
export const DEFAULT_PIXELS_PER_POINT = 0.75;

/** PDF 版本与注释里的二进制标记（>=128 的字节让工具知道这是二进制文件）。 */
const HEADER = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";

export async function exportRastersToPdf(pages: PdfRasterPage[], options: PdfExportOptions = {}): Promise<PdfExportResult> {
  if (!pages.length) throw new Error("PDF 至少要一页");
  const diagnostics: ExportDiagnostic[] = [];
  const scale = options.pixelsPerPoint ?? DEFAULT_PIXELS_PER_POINT;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("pixelsPerPoint 必须是正数");

  const pageCount = pages.length;
  // 对象编号：1=目录 2=页树 3=信息，之后每页三个（页 / 图 / 内容流）。
  const objectCount = 3 + pageCount * 3;
  const bodies: Uint8Array[] = new Array(objectCount);
  const kids: string[] = [];

  for (let index = 0; index < pageCount; index += 1) {
    const page = pages[index]!;
    if (!page.width || !page.height) throw new Error(`第 ${index + 1} 页的尺寸不合法`);
    if (page.pixels.length !== page.width * page.height * 4) {
      throw new Error(`第 ${index + 1} 页的像素长度与尺寸对不上`);
    }
    const pageObject = 4 + index * 3;
    const imageObject = 5 + index * 3;
    const contentObject = 6 + index * 3;
    kids.push(`${pageObject} 0 R`);

    const rgb = compositeOverWhite(page.pixels);
    const compressed = await deflate(rgb);
    const filter = compressed === rgb ? "" : " /Filter /FlateDecode";

    const pageWidthPoints = page.widthPoints ?? page.width * scale;
    const pageHeightPoints = page.heightPoints ?? page.height * scale;
    bodies[pageObject - 1] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(pageWidthPoints)} ${formatNumber(pageHeightPoints)}] `
      + `/Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    bodies[imageObject - 1] = concat([
      ascii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${filter} /Length ${compressed.length} >>\nstream\n`),
      compressed,
      ascii("\nendstream"),
    ]);
    // 内容流：把图铺满整页。PDF 的图像空间原点在左下角，第一行样本在上边，
    // 所以这个变换出来的图是**正着的**（不用再翻一次）。
    const content = ascii(`q\n${formatNumber(pageWidthPoints)} 0 0 ${formatNumber(pageHeightPoints)} 0 0 cm\n/Im0 Do\nQ\n`);
    bodies[contentObject - 1] = concat([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii("endstream")]);
  }

  bodies[0] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  bodies[1] = ascii(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`);
  bodies[2] = ascii(`<< /Title ${pdfTextString(options.title ?? "AI Design Studio")} /Producer ${pdfTextString("AI Design Studio")} >>`);

  return { bytes: buildPdf(bodies), pageCount, diagnostics };
}

/** 把对象表拼成完整的 PDF 文件（含 xref 与 trailer）。 */
function buildPdf(bodies: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [ascii(HEADER)];
  const offsets: number[] = [];
  let length = HEADER.length;
  for (let index = 0; index < bodies.length; index += 1) {
    const prefix = ascii(`${index + 1} 0 obj\n`);
    const suffix = ascii("\nendobj\n");
    offsets.push(length);
    chunks.push(prefix, bodies[index]!, suffix);
    length += prefix.length + bodies[index]!.length + suffix.length;
  }

  const xrefOffset = length;
  const xrefLines = [`xref\n0 ${bodies.length + 1}\n`, "0000000000 65535 f \n"];
  for (const offset of offsets) xrefLines.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  const xref = ascii(xrefLines.join(""));
  const trailer = ascii(
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  chunks.push(xref, trailer);
  return concat(chunks);
}

/** RGBA 合成到白底上，再去掉 alpha（PDF 的 DeviceRGB 没有 alpha 通道）。 */
function compositeOverWhite(pixels: Uint8Array): Uint8Array {
  const rgb = new Uint8Array((pixels.length / 4) * 3);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
    const alpha = pixels[source + 3]! / 255;
    if (alpha >= 1) {
      rgb[target] = pixels[source]!;
      rgb[target + 1] = pixels[source + 1]!;
      rgb[target + 2] = pixels[source + 2]!;
      continue;
    }
    rgb[target] = Math.round(pixels[source]! * alpha + 255 * (1 - alpha));
    rgb[target + 1] = Math.round(pixels[source + 1]! * alpha + 255 * (1 - alpha));
    rgb[target + 2] = Math.round(pixels[source + 2]! * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

/**
 * zlib 压缩（PDF 的 `/FlateDecode` 要的就是这个）。
 *
 * 环境没有 `CompressionStream` 时返回原字节——调用方据此不写 `/Filter`，
 * 产物照样是合法 PDF，只是没压缩。
 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const scope = globalThis as { CompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> };
  if (typeof scope.CompressionStream !== "function") return bytes;
  const stream = new scope.CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes);
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
  return concat(chunks);
}

/** ASCII 文本 → 字节（PDF 的结构部分全是 ASCII）。 */
function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
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

/** 去掉多余小数位：720 而不是 720.0000000001。 */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * PDF 文本串。
 *
 * 纯 ASCII 用字面串；含非 ASCII（中文标题）用 UTF-16BE 十六进制串——PDF 的
 * literal string 只按 PDFDocEncoding 解码，中文会变成乱码。
 */
function pdfTextString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return `(${value.replace(/([\\()])/g, "\\$1")})`;
  }
  let hex = "FEFF";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      const offset = code - 0x10000;
      hex += (0xd800 + (offset >> 10)).toString(16).padStart(4, "0");
      hex += (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += code.toString(16).padStart(4, "0");
    }
  }
  return `<${hex.toUpperCase()}>`;
}
