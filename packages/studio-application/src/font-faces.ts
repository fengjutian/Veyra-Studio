import {
  FONT_INLINE_MAX_BYTES,
  collectExportFontTexts,
  collectExportFonts,
  fontUsageKey,
  inlineFonts,
  isSfntFont,
  matchFontDeclaration,
  type ExportDiagnostic,
  type FontSubsetter,
  type InlineFont,
} from "@ufira/design-export";
import type { ProjectRepository } from "@ufira/design-persistence";
import type { DesignDocument, NodeId } from "@ufira/design-schema";
import { applyThemeForPage } from "@ufira/design-schema";

/**
 * 导出时把文档声明过的字体内联进 HTML 交付物。
 *
 * 导出器本身是同步的，而字体字节在仓库里要异步读，所以这里先准备好
 * `@font-face` 规则，再交给导出器写进 `<style>`。
 *
 * 规格见 `docs/font-inline.md`、`docs/font-management.md`。
 */

/** 内联结果：CSS 片段 + 导出诊断。 */
export interface FontFacePreparation {
  /** `@font-face` 规则（可能为空）。 */
  css: string;
  diagnostics: ExportDiagnostic[];
}

/**
 * 子集化能力的提供方。
 *
 * 返回的是一个 **Promise**：wasm 是几百 KB，导出时才加载更划算，
 * 所以这里要的是「能给出一个子集化器」的承诺，而不是一个已经就绪的对象。
 */
export type FontSubsetProvider = () => Promise<FontSubsetter>;

let subsetProvider: FontSubsetProvider | undefined;

/**
 * 注册（或卸下）字体子集化能力。
 *
 * 浏览器端在启动时注册（`studio-web/src/font-subset-client.ts`），
 * 没注册就退回到「超限不内联 + 记诊断」的行为。
 */
export function setFontSubsetProvider(provider: FontSubsetProvider | undefined): void {
  subsetProvider = provider;
}

/** 当前注册的子集化能力。 */
export function getFontSubsetProvider(): FontSubsetProvider | undefined {
  return subsetProvider;
}

/**
 * 准备本次导出要内联的字体。
 *
 * 只处理**文档声明过**的字体：系统字体（没有字体文件）不需要内联——
 * 对方机器上装了就有，没装那是设计方本来就该处理的缺失字体问题。
 *
 * `subsetter` 是可选的子集化能力：字体超过内联上限时（例如几 MB 的中文字体），
 * 先把它裁到导出范围内真正用到的字符再内联。没有这个能力时行为不变
 * （超限不内联 + 记诊断）。
 */
export async function prepareFontFaces(
  repository: ProjectRepository,
  documentInput: DesignDocument,
  options: { pageId: string; nodeIds?: readonly NodeId[]; themeId?: string },
): Promise<FontFacePreparation> {
  // 字体 token 可能在不同主题里指向不同族名：字体内联必须按当前主题收集。
  const document = applyThemeForPage(documentInput, options.pageId, options.themeId);
  const diagnostics: ExportDiagnostic[] = [];
  const usages = collectExportFonts(document, options);
  const fontTexts = collectExportFontTexts(document, options);
  const fonts: InlineFont[] = [];

  for (const usage of usages) {
    const matched = matchFontDeclaration(document.fonts, usage);
    if (!matched) continue;
    if (!matched.exact) {
      diagnostics.push({
        feature: "font-inline",
        support: "approximated",
        message: `字体「${usage.family}」没有 ${usage.weight} ${usage.style} 的声明，内联的是同一族名的另一条，字重可能对不上`,
      });
    }
    const assetId = matched.declaration.assetId;
    if (!assetId) continue;
    const asset = document.assets[assetId];
    if (!asset) continue;
    const stored = await repository.getAsset(document.id, asset.hash);
    if (!stored) {
      diagnostics.push({
        feature: "font-inline",
        support: "unsupported",
        message: `字体「${usage.family}」的文件读不出来（资产 ${assetId} 缺失），导出物没有内联它`,
      });
      continue;
    }
    let bytes = stored;
    let mime = asset.mimeType;
    // 超限的字体先尝试子集化：中文字体动辄几 MB，裁到只用到的字符后往往能塞进上限。
    if (bytes.byteLength > FONT_INLINE_MAX_BYTES && subsetProvider) {
      const text = fontTexts.get(fontUsageKey(usage.family, usage.weight, usage.style)) ?? "";
      try {
        const subsetter = await subsetProvider();
        const subset = subsetter.subset(bytes, text);
        if (subset.byteLength < bytes.byteLength) {
          bytes = subset;
          // 子集化输出的是 sfnt（TrueType），原始的 woff/woff2 mime 不再适用。
          mime = "font/ttf";
        }
      } catch (error) {
        diagnostics.push({
          feature: "font-inline",
          support: "approximated",
          message: `字体「${usage.family}」子集化失败（${error instanceof Error ? error.message : String(error)}），它仍然超过内联上限，不会被内联`,
        });
      }
    }
    fonts.push({ family: usage.family, weight: usage.weight, style: usage.style, bytes, mime });
  }

  const result = inlineFonts(fonts);
  for (const note of result.notes) {
    if (note.reason === "too-large") {
      diagnostics.push({
        feature: "font-inline",
        support: "unsupported",
        message: `字体「${note.family}」有 ${formatBytes(note.byteLength)}，超过 1 MB 的内联上限，导出物没有内联它，打开时会走回退字形。请先子集化后再上传。`,
      });
    }
  }
  return { css: result.css, diagnostics };
}

/** 字节数显示成人类能读的体积。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 一份要内嵌进矢量 PDF 的字体。 */
export interface VectorPdfFontResource {
  bytes: Uint8Array;
  family: string;
  bold: boolean;
  italic: boolean;
}

/** 矢量 PDF 的字体准备结果。 */
export interface VectorPdfFontPreparation {
  /** 用法键（`family weight style`）→ 字体字节。 */
  fonts: Map<string, VectorPdfFontResource>;
  diagnostics: ExportDiagnostic[];
}

/**
 * 准备矢量 PDF 要内嵌的字体。
 *
 * PDF 只能内嵌 **sfnt**（TrueType / OpenType）：`woff` / `woff2` 是压缩容器，
 * PDF 不认。有子集化能力时（HarfBuzz）可以先把它们转成 sfnt 子集再内嵌——
 * 顺带把体积裁到只用到的字符。
 *
 * 没有字体字节的**系统字体**不在这儿处理：它们交给 PDF 内置的 Helvetica 顶替，
 * 由导出器记诊断。字形对不上这件事必须让人看见，而不是悄悄交付一份字形不对的文件。
 */
export async function prepareVectorPdfFonts(
  repository: ProjectRepository,
  documentInput: DesignDocument,
  options: { pageId: string; nodeIds?: readonly NodeId[]; themeId?: string },
): Promise<VectorPdfFontPreparation> {
  const document = applyThemeForPage(documentInput, options.pageId, options.themeId);
  const diagnostics: ExportDiagnostic[] = [];
  const usages = collectExportFonts(document, options);
  const fontTexts = collectExportFontTexts(document, options);
  const fonts = new Map<string, VectorPdfFontResource>();

  for (const usage of usages) {
    const matched = matchFontDeclaration(document.fonts, usage);
    if (!matched) continue;
    const assetId = matched.declaration.assetId;
    if (!assetId) continue;
    const asset = document.assets[assetId];
    if (!asset) continue;
    const stored = await repository.getAsset(document.id, asset.hash);
    if (!stored) {
      diagnostics.push({
        feature: "pdf-vector-font",
        support: "unsupported",
        message: `字体「${usage.family}」的文件读不出来（资产 ${assetId} 缺失），矢量 PDF 没有内嵌它`,
      });
      continue;
    }

    let bytes = stored;
    const key = fontUsageKey(usage.family, usage.weight, usage.style);
    const text = fontTexts.get(key) ?? "";
    if (!isSfntFont(bytes)) {
      // 压缩容器：只有子集化能把它变成 sfnt。
      if (!subsetProvider) {
        diagnostics.push({
          feature: "pdf-vector-font",
          support: "approximated",
          message: `字体「${usage.family}」是 ${asset.mimeType}，PDF 只能内嵌 TrueType / OpenType；没有子集化能力，文字会退回内置 Helvetica`,
        });
        continue;
      }
      try {
        const subsetter = await subsetProvider();
        bytes = subsetter.subset(bytes, text);
      } catch (error) {
        diagnostics.push({
          feature: "pdf-vector-font",
          support: "approximated",
          message: `字体「${usage.family}」没法转成 PDF 能内嵌的格式（${error instanceof Error ? error.message : String(error)}），文字会退回内置 Helvetica`,
        });
        continue;
      }
    } else if (subsetProvider) {
      // 已经是 sfnt：裁到只用到的字符，PDF 体积小一大截。
      try {
        const subsetter = await subsetProvider();
        const subset = subsetter.subset(bytes, text);
        if (subset.byteLength < bytes.byteLength) bytes = subset;
      } catch {
        // 子集化失败就用原字体：内嵌完整字体仍然是对的，只是大一点。
      }
    }

    fonts.set(key, {
      bytes,
      family: usage.family,
      bold: usage.weight >= 600,
      italic: usage.style === "italic",
    });
  }

  return { fonts, diagnostics };
}

/**
 * 诊断去重。
 *
 * 同一个问题（同一个特性 + 同一句话）只报一次：导出面板里重复十几条
 * 「字体没内联」没人会一条条读。
 */
export function dedupeByFeature(diagnostics: readonly ExportDiagnostic[]): ExportDiagnostic[] {
  const seen = new Set<string>();
  const result: ExportDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.feature}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}
