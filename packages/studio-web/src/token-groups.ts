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

import type { TokenGroupMeta, TokenValue } from "@ufira/design-schema";

/** 一个分组。 */
export interface TokenGroup {
  /** 分组 id（点号路径）；未分组为空字符串。 */
  id: string;
  /** 面板上的标题。 */
  label: string;
  /** 分组说明；来自元数据，没有就不显示。 */
  description?: string;
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
 *
 * `metas` 是可选的分组元数据（显示名 / 说明 / 顺序）：它**只影响面板怎么显示**，
 * 不影响分组本身的划分——分组永远由名字前缀决定。给了 order 的组按 order 排在前，
 * 没给的接在后面按 id 排；未分组无论有没有 order 都在最后。
 */
export function groupTokens(tokens: Record<string, TokenValue>, metas?: TokenGroupMeta[]): TokenGroup[] {
  const metaById = new Map<string, TokenGroupMeta>();
  for (const meta of metas ?? []) metaById.set(meta.id, meta);

  const groups = new Map<string, Array<[string, TokenValue]>>();
  for (const [name, token] of Object.entries(tokens)) {
    const id = tokenGroupOf(name);
    const bucket = groups.get(id);
    if (bucket) bucket.push([name, token]);
    else groups.set(id, [[name, token]]);
  }
  return [...groups.entries()]
    .map(([id, entries]) => {
      const meta = metaById.get(id);
      return {
        id,
        label: meta?.label ?? (id || UNGROUPED_LABEL),
        description: meta?.description,
        entries: [...entries].sort(([left], [right]) => left.localeCompare(right)),
      };
    })
    .sort((left, right) => {
      if (!left.id) return 1;
      if (!right.id) return -1;
      // 有 order 的排前面；都没有 order 时按 id 排，顺序稳定可预期。
      const leftOrder = metaById.get(left.id)?.order ?? Number.POSITIVE_INFINITY;
      const rightOrder = metaById.get(right.id)?.order ?? Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.id.localeCompare(right.id);
    });
}
