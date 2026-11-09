/**
 * Token 的分组视图。
 *
 * 分组**不写进文档**：名字里的点号就是层级（`color.text.primary` → `color.text`），
 * 跟 CSS 自定义属性、Tailwind 主题的命名习惯一致。这样：
 *
 * - 旧文档不用迁移，已经按点号命名的人立刻受益；
 * - 不会出现「移动分组要改 token 名」的双写问题；
 * - 分组只是面板的组织方式，不影响解析与导出。
 */

import type { TokenValue } from "@ufira/design-schema";

/** 一个分组。 */
export interface TokenGroup {
  /** 分组 id（点号路径）；未分组为空字符串。 */
  id: string;
  /** 面板上的标题。 */
  label: string;
  /** 组内 token，按名字排序。 */
  entries: Array<[string, TokenValue]>;
}

/** 未分组 token 的显示名。 */
export const UNGROUPED_LABEL = "未分组";

/**
 * 别名链的最终类型。
 *
 * 绑定下拉要按**最终类型**给选项：`text.primary`（alias → 颜色）应该能绑填充。
 * 链断了、有环或指向不存在的 token 时返回 `undefined`（不给绑定入口），
 * 与文档校验的判定保持一致。
 */
export function effectiveTokenType(tokens: Record<string, TokenValue>, name: string): TokenValue["type"] | undefined {
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const token = tokens[current];
    if (!token) return undefined;
    if (token.type !== "alias") return token.type;
    current = token.value;
  }
  return undefined;
}

/** `color.text.primary` → `color.text`；没有点号的返回空串。 */
export function tokenGroupOf(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(0, separator) : "";
}

/**
 * 按名字前缀分组。
 *
 * 组按名字排序，未分组排最后；组内条目也按名字排序，保证面板顺序稳定。
 */
export function groupTokens(tokens: Record<string, TokenValue>): TokenGroup[] {
  const groups = new Map<string, Array<[string, TokenValue]>>();
  for (const [name, token] of Object.entries(tokens)) {
    const id = tokenGroupOf(name);
    const bucket = groups.get(id);
    if (bucket) bucket.push([name, token]);
    else groups.set(id, [[name, token]]);
  }
  return [...groups.entries()]
    .map(([id, entries]) => ({
      id,
      label: id || UNGROUPED_LABEL,
      entries: [...entries].sort(([left], [right]) => left.localeCompare(right)),
    }))
    .sort((left, right) => {
      if (!left.id) return 1;
      if (!right.id) return -1;
      return left.id.localeCompare(right.id);
    });
}
