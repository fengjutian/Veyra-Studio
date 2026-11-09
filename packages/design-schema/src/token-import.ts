import type { TokenValue } from "./types";

/**
 * 从样式表导入设计 token。
 *
 * 已有设计系统的团队手上通常是 CSS 自定义属性（`:root { --color-brand: #6366f1 }`）
 * 或 SCSS 变量（`$space-md: 16px`），而不是 Studio 的 token 表。这个模块把样式表
 * 文本解析成**提案**，交给界面让用户确认后再写进文档——
 * 解析器不直接改文档，避免"粘贴一段 CSS 就悄悄改掉已有 token"。
 *
 * 判定原则：
 *
 * - **不猜单位**：`16px` 读成数值 16；`1.5rem` / `50%` / `2em` 保留成字符串并给出
 *   警告——rem 与 em 依赖根字号，猜一个换算值会把设计改错。
 * - **不猜颜色关键字**：只认基础色名与 `transparent` / `currentColor`；其余字符串
 *   留给用户改类型。
 * - **别名照搬**：`var(--other)` 变成指向 `other` 的 alias token，语义与 CSS 一致。
 * - **插值跳过**：`#{$var}` 是 SCSS 插值，值在编译期才确定，导入期给不出答案。
 */

/** 导入提案里能给出的类型。 */
export type ImportedTokenType = "color" | "number" | "string" | "alias";

/** 一条待确认的 token。 */
export interface TokenImportProposal {
  /** 建议的 token 名：去掉 CSS 的 `--` / SCSS 的 `$` 前缀，其余原样保留。 */
  name: string;
  type: ImportedTokenType;
  /** 数值型是 number，其余是字符串。 */
  value: string | number;
  /** 原始变量名（`--color-brand` / `$space-md`），便于界面里对回源文件。 */
  source: string;
  /** 与文档里已有的 token 同名——导入会覆盖它。 */
  conflicts?: boolean;
}

/** 解析结果。 */
export interface TokenImportResult {
  /** 提案列表，按源文件里的出现顺序。 */
  tokens: TokenImportProposal[];
  /** 人话提示：跳过了什么、为什么类型是字符串。 */
  warnings: string[];
}

/** CSS 基础颜色关键字。 */
const CSS_COLOR_KEYWORDS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple", "fuchsia",
  "green", "lime", "olive", "yellow", "navy", "blue", "teal", "aqua",
  "orange", "transparent", "currentcolor",
]);

/** 十六进制颜色：`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`。 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 颜色函数：`rgb()` / `rgba()` / `hsl()` / `hsla()`。 */
const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla)\(/i;

/** 无单位数字或 px 数值。 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const PIXEL_NUMBER = /^-?\d+(?:\.\d+)?px$/i;

/** SCSS 插值：`#{$var}`。 */
const SCSS_INTERPOLATION = /#\{[^}]*\}/;

/**
 * 去掉注释。
 *
 * CSS 块注释 `/* … *\/` 与 SCSS 行注释 `// …` 都要去掉，否则注释里出现的
 * `--x: y` 会被当成真的声明。
 */
export function stripStyleComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * 判断一个值是不是颜色。
 *
 * 只认基础色名、十六进制与颜色函数——`background`、`bold` 这类单词在 CSS 里
 * 也可能是合法值，猜错类型会让 token 绑不上任何东西。
 */
export function looksLikeColor(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (CSS_COLOR_KEYWORDS.has(text)) return true;
  if (HEX_COLOR.test(text)) return true;
  if (COLOR_FUNCTION.test(text)) return true;
  return false;
}

/**
 * 推断一个值的类型。
 *
 * `var(--x)` 是别名；颜色是 color；无单位数字与 px 是 number；其余是 string。
 */
export function inferTokenType(value: string): ImportedTokenType {
  const text = value.trim();
  if (/^var\(\s*--[A-Za-z0-9_-]+\s*\)$/.test(text)) return "alias";
  if (looksLikeColor(text)) return "color";
  if (PLAIN_NUMBER.test(text) || PIXEL_NUMBER.test(text)) return "number";
  return "string";
}

/**
 * 解析样式表里的 token 声明。
 *
 * `existing` 传入文档里已有的 token 表，用来标出**会覆盖**的同名项——
 * 覆盖是不可逆的（虽然可以撤销），界面必须让用户先看见。
 */
export function parseStyleTokens(
  source: string,
  options: { existing?: Record<string, TokenValue> } = {},
): TokenImportResult {
  const text = stripStyleComments(source);
  const tokens: TokenImportProposal[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  // `--name: value` 与 `$name: value` 两种写法。
  //
  // 值的部分不能排除 `{}`：SCSS 插值 `#{$brand}` 里就有花括号，早期版本在这里
  // 用 `[^;{}]+`，结果 `#{$brand}` 被截成 `#`，插值反而没被识别出来。改为先取到
  // 分号，再把结尾多出来的 `}`（无分号写法的残留）去掉。
  const pattern = /(--[A-Za-z0-9_-]+|\$[A-Za-z0-9_-]+)\s*:\s*([^;]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const variable = match[1]!;
    // 先按原文判插值，再剥掉结尾多余的 `}`——顺序反了会把 `#{$brand}` 削成
    // `#{$brand`，插值就再也认不出来了。
    const rawText = match[2]!.trim();
    if (SCSS_INTERPOLATION.test(rawText)) {
      warnings.push(`${variable} 的值含 SCSS 插值（${rawText}），编译后才确定，已跳过`);
      continue;
    }
    const rawValue = rawText.replace(/\}+$/, "").trim();
    if (!rawValue) continue;

    const name = variable.startsWith("--") ? variable.slice(2) : variable.slice(1);
    if (!name) continue;
    if (seen.has(name)) {
      warnings.push(`${variable} 重复出现，只保留第一次`);
      continue;
    }
    seen.add(name);

    const type = inferTokenType(rawValue);
    let value: string | number = rawValue;
    if (type === "number") {
      value = Number(rawValue.replace(/px$/i, ""));
    } else if (type === "alias") {
      value = rawValue.replace(/^var\(\s*--/, "").replace(/\s*\)$/, "");
    } else if (type === "string") {
      // 带单位的数值不做换算：rem / em 依赖根字号，猜出来的值会把设计改错。
      if (/^-?\d+(?:\.\d+)?(?:rem|em|%|vh|vw|ch|ex)$/i.test(rawValue)) {
        warnings.push(`${variable} = ${rawValue} 带单位，按字符串导入（不猜换算）`);
      }
    }

    tokens.push({
      name,
      type,
      value,
      source: variable,
      conflicts: options.existing ? Object.prototype.hasOwnProperty.call(options.existing, name) : undefined,
    });
  }

  if (!tokens.length && text.trim()) {
    warnings.push("没有解析出任何变量：样式表里要写成 `--名称: 值;` 或 `$名称: 值;`");
  }
  return { tokens, warnings };
}

/** 把提案转成可以写进文档的 token 值。 */
export function proposalToToken(proposal: TokenImportProposal): TokenValue {
  if (proposal.type === "number") return { type: "number", value: Number(proposal.value) };
  if (proposal.type === "color") return { type: "color", value: String(proposal.value) };
  if (proposal.type === "alias") return { type: "alias", value: String(proposal.value) };
  return { type: "string", value: String(proposal.value) };
}
