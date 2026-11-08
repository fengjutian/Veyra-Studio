import {
  collectExportFonts,
  inlineFonts,
  matchFontDeclaration,
  type ExportDiagnostic,
  type InlineFont,
} from "@ufira/design-export";
import type { ProjectRepository } from "@ufira/design-persistence";
import type { DesignDocument, NodeId } from "@ufira/design-schema";

/**
 * 导出时把文档声明过的字体内联进 HTML 交付物。
 *
 * 导出器本身是同步的，而字体字节在仓库里要异步读，所以这里先准备好
 * `@font-face` 规则，再交给导出器写进 `<style>`。
 *
 * 规格见 `docs/font-inline.md`。
 */

/** 内联结果：CSS 片段 + 导出诊断。 */
export interface FontFacePreparation {
  /** `@font-face` 规则（可能为空）。 */
  css: string;
  diagnostics: ExportDiagnostic[];
}

/**
 * 准备本次导出要内联的字体。
 *
 * 只处理**文档声明过**的字体：系统字体（没有字体文件）不需要内联——
 * 对方机器上装了就有，没装那是设计方本来就该处理的缺失字体问题。
 */
export async function prepareFontFaces(
  repository: ProjectRepository,
  document: DesignDocument,
  options: { pageId: string; nodeIds?: readonly NodeId[] },
): Promise<FontFacePreparation> {
  const diagnostics: ExportDiagnostic[] = [];
  const usages = collectExportFonts(document, options);
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
    const bytes = await repository.getAsset(document.id, asset.hash);
    if (!bytes) {
      diagnostics.push({
        feature: "font-inline",
        support: "unsupported",
        message: `字体「${usage.family}」的文件读不出来（资产 ${assetId} 缺失），导出物没有内联它`,
      });
      continue;
    }
    fonts.push({ family: usage.family, weight: usage.weight, style: usage.style, bytes, mime: asset.mimeType });
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
