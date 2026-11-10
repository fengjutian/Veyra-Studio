import {
  FONT_INLINE_MAX_BYTES,
  collectExportFontTexts,
  collectExportFonts,
  fontUsageKey,
  matchFontDeclaration,
  packagedFontFaceCss,
  type ExportDiagnostic,
  type FontSubsetter,
} from "@ufira/design-export";
import type { ProjectRepository } from "@ufira/design-persistence";
import type { AssetMetadata, DesignDocument, NodeId } from "@ufira/design-schema";
import { applyThemeForPage } from "@ufira/design-schema";
import { collectImageAssets } from "./assets";
import { getFontSubsetProvider } from "./font-faces";

/**
 * 资产打包：把交付物从一个自包含的 HTML 变成「HTML + 资源」的包。
 *
 * 内联（现状）的好处是单文件、随手就能发；代价是体积涨约 33%（base64），
 * 而且字体超过 1 MB 就只能放弃内联。打包把图片和字体拆成独立文件，
 * HTML 用相对路径引用——体积不涨，字体也不再受内联上限约束，
 * 代价是交付物变成一个目录（对外分发时打成 ZIP）。
 *
 * 规格见 `docs/asset-packaging.md`。
 */

/** 包内图片目录。 */
export const PACKAGE_ASSET_DIR = "assets";
/** 包内字体目录。 */
export const PACKAGE_FONT_DIR = "fonts";
/** 包内主文档的文件名。 */
export const PACKAGE_DOCUMENT_NAME = "index.html";

/** 包里的一个文件。 */
export interface PackageFile {
  /** 包内路径（ZIP 里的条目名，如 `assets/photo.png`）。 */
  path: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** 打包导出的结果。 */
export interface AssetPackage {
  /** 主文档内容（`index.html`）。 */
  document: string;
  /** 除主文档外的文件。 */
  files: PackageFile[];
  diagnostics: ExportDiagnostic[];
}

/** MIME → 扩展名。认不出的类型用 `.bin`——宁可扩展名难看，也不要写错类型。 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

const FONT_EXTENSIONS: Record<string, string> = {
  "font/woff2": ".woff2",
  "application/font-woff2": ".woff2",
  "font/woff": ".woff",
  "application/font-woff": ".woff",
  "font/otf": ".otf",
  "application/font-otf": ".otf",
  "font/ttf": ".ttf",
  "application/x-font-ttf": ".ttf",
  "application/font-sfnt": ".ttf",
};

/**
 * 文件名安全化。
 *
 * 资源名来自文档，可能是用户随手写的，也可能来自别人导出的 JSON——
 * 直接写进包名就能引用到包外的文件（`../../etc/passwd`）。这里只保留安全
 * 字符，其余换成 `_`，并去掉开头的点（`.` 与 `..`）。
 */
export function safePackageFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    // 连续的点压成一个：名字里带 `..` 看着像路径穿越，宁可丑也不要。
    .replace(/\.+/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/_+/g, "_")
    .slice(0, 64);
  return cleaned || "file";
}

/** 去掉文件名里的扩展名（`photo.png` → `photo`）。 */
function stripExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

/**
 * 哈希片段：用来让同名文件互不覆盖。
 *
 * 哈希只取安全字符——导入的文档里哈希未必是真正的 SHA-256（见
 * `design-persistence` 的资产读路径），不能直接当文件名用。
 */
function hashTag(hash: string): string {
  const cleaned = hash.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return cleaned.slice(0, 8) || "0";
}

/**
 * 图片资源 → 包内路径。
 *
 * 路径带 `./` 前缀：产物里的引用必须是**相对**的，交付物换个目录打开也得对。
 * 导出器的 URL 白名单本来就接受 `./` 开头的相对路径，所以这里不需要改它。
 */
export function planPackageImagePaths(assets: readonly AssetMetadata[]): Map<string, string> {
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const asset of assets) {
    const base = safePackageFileName(stripExtension(asset.name ?? asset.id));
    const extension = IMAGE_EXTENSIONS[asset.mimeType.toLowerCase()] ?? ".bin";
    const tag = hashTag(asset.hash);
    let name = `${base}-${tag}${extension}`;
    // 同名不同资源：加序号，别让后一个把前一个盖掉。
    let counter = 2;
    while (used.has(name)) {
      name = `${base}-${tag}-${counter}${extension}`;
      counter += 1;
    }
    used.add(name);
    paths.set(asset.id, `./${PACKAGE_ASSET_DIR}/${name}`);
  }
  return paths;
}

/** 字体在包里的文件信息。 */
export interface PackageFontPlan {
  /** 资产 id。 */
  assetId: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  mime: string;
  hash: string;
}

/**
 * 字体 → 包内路径。
 *
 * 路径按「族名 + 字重 + 字形 + 哈希片段」定：同一份资产可能被多个
 * `(family, weight, style)` 退化匹配，而每个用法的字符集不同（子集化结果
 * 也可能不同），所以每个用法一个文件，不共用。
 */
export function planPackageFontPath(font: PackageFontPlan): string {
  const base = safePackageFileName(font.family);
  const extension = FONT_EXTENSIONS[font.mime.toLowerCase()] ?? ".bin";
  const italic = font.style === "italic" ? "i" : "";
  return `./${PACKAGE_FONT_DIR}/${base}-${font.weight}${italic}-${hashTag(font.hash)}${extension}`;
}

/** 打包资源包里的图片。 */
export interface PackageAssetPreparation {
  /** 交给导出器的资源解析回调：返回包内相对路径。 */
  resolveAsset: (asset: AssetMetadata) => string | undefined;
  /** 包里的图片文件。 */
  files: PackageFile[];
}

/**
 * 读取导出要用的图片，准备成包里的文件。
 *
 * 读不到的资源不在这里报错：不给 URL，导出器自己会产出 `image-asset` 诊断，
 * 语言和导出范围保持一致。
 */
export async function preparePackageAssets(
  repository: ProjectRepository,
  document: DesignDocument,
  pageId: string,
  nodeIds?: readonly NodeId[],
): Promise<PackageAssetPreparation> {
  const assets = collectImageAssets(document, pageId, nodeIds);
  const paths = planPackageImagePaths(assets);
  const urls = new Map<string, string>();
  const files: PackageFile[] = [];
  for (const asset of assets) {
    const bytes = await repository.getAsset(document.id, asset.hash);
    if (!bytes) continue;
    const path = paths.get(asset.id);
    if (!path) continue;
    urls.set(asset.id, path);
    files.push({ path: path.replace(/^\.\//, ""), bytes, mimeType: asset.mimeType });
  }
  return { resolveAsset: asset => urls.get(asset.id), files };
}

/** 打包资源包里的字体。 */
export interface PackageFontPreparation {
  /** `@font-face` 规则（引用包内文件）。 */
  css: string;
  /** 包里的字体文件。 */
  files: PackageFile[];
  diagnostics: ExportDiagnostic[];
}

/**
 * 准备本次打包要带的字体。
 *
 * 与内联版（`prepareFontFaces`）的差别有两条：
 * ① `src` 指向包内文件，不是 data URI；
 * ② **不检查内联上限**——1 MB 的限制是为了控制 base64 膨胀，外链文件没有
 *    这个约束。子集化仍然做：它能减小包体积。
 */
export async function preparePackageFontFaces(
  repository: ProjectRepository,
  documentInput: DesignDocument,
  options: { pageId: string; nodeIds?: readonly NodeId[]; themeId?: string },
): Promise<PackageFontPreparation> {
  const document = applyThemeForPage(documentInput, options.pageId, options.themeId);
  const diagnostics: ExportDiagnostic[] = [];
  const usages = collectExportFonts(document, options);
  const fontTexts = collectExportFontTexts(document, options);
  const subsetProvider = getFontSubsetProvider();
  const files = new Map<string, PackageFile>();
  const css: string[] = [];

  for (const usage of usages) {
    const matched = matchFontDeclaration(document.fonts, usage);
    if (!matched) continue;
    if (!matched.exact) {
      diagnostics.push({
        feature: "font-inline",
        support: "approximated",
        message: `字体「${usage.family}」没有 ${usage.weight} ${usage.style} 的声明，打包的是同一族名的另一条，字重可能对不上`,
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
        message: `字体「${usage.family}」的文件读不出来（资产 ${assetId} 缺失），资源包里没有它`,
      });
      continue;
    }
    let bytes = stored;
    let mime = asset.mimeType;
    // 超限的字体先尝试子集化：中文字体动辄几 MB，裁到只用到的字符后往往小很多。
    if (bytes.byteLength > FONT_INLINE_MAX_BYTES && subsetProvider) {
      const text = fontTexts.get(fontUsageKey(usage.family, usage.weight, usage.style)) ?? "";
      try {
        const subsetter: FontSubsetter = await subsetProvider();
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
          message: `字体「${usage.family}」子集化失败（${error instanceof Error ? error.message : String(error)}），资源包里放的是完整字体`,
        });
      }
    }
    const path = planPackageFontPath({
      assetId,
      family: usage.family,
      weight: usage.weight,
      style: usage.style,
      mime,
      hash: asset.hash,
    });
    const packagePath = path.replace(/^\.\//, "");
    if (!files.has(packagePath)) files.set(packagePath, { path: packagePath, bytes, mimeType: mime });
    css.push(packagedFontFaceCss({ family: usage.family, weight: usage.weight, style: usage.style, bytes, mime }, path));
  }

  return { css: css.join("\n"), files: [...files.values()], diagnostics };
}
