import { TEXT_DEFAULTS, type TextNode } from "@ufira/design-schema";
import type { Size, TextMeasurer } from "./types";

/**
 * 文本测量的缓存与字体回退。
 *
 * 布局一次要算几十个文本节点的尺寸，每次走真实字体引擎都很贵；缓存把"同样的
 * 文本 + 同样的样式 + 同样的可用宽度"压成一次测量。缓存必须有上限，否则长时间
 * 编辑会随着不同文本无限增长。
 */

/** 缓存键要覆盖所有会影响测量的字段；少一个就会串结果。 */
export function textMeasurementKey(node: TextNode, availableWidth?: number): string {
  return [
    node.fontFamily,
    node.fontSize,
    node.lineHeight,
    node.fontWeight ?? TEXT_DEFAULTS.fontWeight,
    node.fontStyle ?? TEXT_DEFAULTS.fontStyle,
    node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing,
    availableWidth ?? "",
    node.text,
  ].join("\u0000");
}

export interface TextMeasurerCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface CachedTextMeasurer extends TextMeasurer {
  stats(): TextMeasurerCacheStats;
  clear(): void;
}

export interface CachedTextMeasurerOptions {
  /** 最多缓存多少条测量结果，默认 512。 */
  limit?: number;
}

/**
 * 给任意测量器套一层有上限的缓存。
 *
 * 计数命中/未命中是为了让测试能断言"缓存真的生效"，也方便以后排查性能。
 * 淘汰策略用最久未使用（Map 的插入顺序 + 命中时重新插入）。
 */
export function createCachedTextMeasurer(measurer: TextMeasurer, options: CachedTextMeasurerOptions = {}): CachedTextMeasurer {
  const limit = Math.max(1, Math.floor(options.limit ?? 512));
  const cache = new Map<string, Size>();
  let hits = 0;
  let misses = 0;

  const touch = (key: string, value: Size): Size => {
    // 重新插入放到队尾，最近最少使用的那条就排在最前面。
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return { ...value };
  };

  return {
    measure(node: TextNode, availableWidth?: number): Size {
      const key = textMeasurementKey(node, availableWidth);
      const cached = cache.get(key);
      if (cached) {
        hits += 1;
        return touch(key, cached);
      }
      misses += 1;
      const size = measurer.measure(node, availableWidth);
      const safe = {
        width: Number.isFinite(size.width) ? Math.max(0, size.width) : 0,
        height: Number.isFinite(size.height) ? Math.max(0, size.height) : 0,
      };
      return touch(key, safe);
    },
    stats: () => ({ hits, misses, size: cache.size }),
    clear: () => { cache.clear(); hits = 0; misses = 0; },
  };
}

/** 已知的等宽/中文回退栈；顺序与 CSS 的 font-family 语义一致。 */
export const FONT_FALLBACK_STACK = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 把节点里的字体名变成一段安全的 CSS font-family。
 *
 * - 空值/纯空白回退到默认栈，避免生成 `16px` 这种非法 shorthand；
 * - 去掉引号与括号等会破坏 CSS 的字符（字体名来自用户输入/导入文件，不可信）；
 * - 总是补上系统回退栈，缺字体时至少字形宽度可预期。
 */
export function resolveFontFamily(fontFamily: string | undefined): string {
  const cleaned = (fontFamily ?? "")
    .replace(/["'\\;{}()]/g, "")
    .trim();
  if (!cleaned) return FONT_FALLBACK_STACK;
  // 含空格的字体名必须加引号（例如 "SF Pro"）。
  const quoted = /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
  return `${quoted}, ${FONT_FALLBACK_STACK}`;
}
