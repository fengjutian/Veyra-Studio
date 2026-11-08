/**
 * 字体文件里的族名与字重。
 *
 * 上传字体时如果只能靠文件名猜族名（`MyFont-Bold.ttf` → 「MyFont Bold」这种），
 * 猜错的后果很具体：族名与文件里真实的族名对不上，文本节点引用不到这份字体，
 * 它就变成「缺失字体」——白上传。
 *
 * 解析用 `fonteditor-core`（纯 JS，无需 wasm）。它有几百 KB，
 * 所以用**动态 import**：只有真的去上传字体时才加载，不拖慢首屏。
 *
 * 解析失败就回落到文件名猜测，**不报错**——上传流程不该被解析卡住。
 */

/** 从字体文件里读到的元数据。 */
export interface FontMetadata {
  /** 族名（name 表的 nameID 1）。 */
  family?: string;
  /** 字重（OS/2 的 usWeightClass）。 */
  weight?: number;
  /** 字形。 */
  style?: "normal" | "italic";
}

/** MIME → `fonteditor-core` 的格式名。 */
function formatOf(mimeType: string | undefined): string | undefined {
  switch ((mimeType ?? "").toLowerCase()) {
    case "font/woff2":
    case "application/font-woff2":
      return "woff2";
    case "font/woff":
    case "application/font-woff":
      return "woff";
    case "font/ttf":
    case "application/x-font-ttf":
    case "application/font-sfnt":
      return "ttf";
    case "font/otf":
    case "application/font-otf":
      return "opentype";
    default:
      return undefined;
  }
}

/**
 * 读取字体文件的族名与字重。
 *
 * 读不出来（格式不支持、文件损坏、不是字体）时返回 `undefined`——
 * 调用方回落��文件名猜测。
 */
export async function readFontMetadata(bytes: Uint8Array, mimeType?: string): Promise<FontMetadata | undefined> {
  const format = formatOf(mimeType);
  if (!format) return undefined;
  try {
    const { Font } = await import("fonteditor-core");
    // fonteditor-core 要 ArrayBuffer；给一份精确长度的副本。
    const buffer = bytes.slice().buffer;
    const font = Font.create(buffer, { type: format });
    const parsed = font.get() as FontTables;
    const family = parsed.name?.fontFamily?.trim();
    const os2 = parsed["OS/2"];
    const weight = typeof os2?.usWeightClass === "number" ? os2.usWeightClass : undefined;
    const italic = Boolean(os2?.fsSelection && (os2.fsSelection & 0x01) !== 0)
      || Boolean(parsed.head?.macStyle && (parsed.head.macStyle & 0x02) !== 0);
    const result: FontMetadata = {
      ...(family ? { family } : {}),
      ...(weight && weight >= 100 && weight <= 900 ? { weight: Math.round(weight / 100) * 100 } : {}),
      ...(italic ? { style: "italic" as const } : {}),
    };
    return Object.keys(result).length ? result : undefined;
  } catch {
    // 解析失败不是错误：回落文件名猜测。
    return undefined;
  }
}

/** fonteditor-core 的表结构（只列本模块用到的字段）。 */
interface FontTables {
  name?: { fontFamily?: string };
  head?: { macStyle?: number };
  "OS/2"?: { usWeightClass?: number; fsSelection?: number };
}
