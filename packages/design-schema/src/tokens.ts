import type { DesignDocument, DesignNode, TokenValue } from "./types";

/**
 * Token 解析。
 *
 * 文档里存的是"绑定名 → token 名"，渲染、布局和导出需要的是最终值。这里集中
 * 定义解析规则，保证画布和导出不会各写一套。
 *
 * 解析失败一律退回节点自身的字段，而不是抛错：token 被删掉、类型不匹配、或者
 * 导入的文档里引用了不存在的 token 时，设计仍然能显示，只是丢了绑定。
 */

export function resolveToken(document: DesignDocument, name: string | undefined): TokenValue | undefined {
  return name ? document.tokens[name] : undefined;
}

/** 数值 token（间距、圆角、字号等）。 */
export function tokenNumber(document: DesignDocument, name: string | undefined): number | undefined {
  const token = resolveToken(document, name);
  return token?.type === "number" && typeof token.value === "number" ? token.value : undefined;
}

/** 颜色 token。 */
export function tokenColor(document: DesignDocument, name: string | undefined): string | undefined {
  const token = resolveToken(document, name);
  return token?.type === "color" && typeof token.value === "string" ? token.value : undefined;
}

/** 描边颜色：绑定优先，否则用节点自身的描边。 */
export function resolveStroke(document: DesignDocument, node: DesignNode): string | undefined {
  return tokenColor(document, node.bindings?.stroke) ?? node.appearance.stroke;
}

/** 圆角：`radius` 绑定优先，否则用节点自身的值。 */
export function resolveRadius(document: DesignDocument, node: DesignNode): number | undefined {
  return tokenNumber(document, node.bindings?.radius) ?? node.appearance.cornerRadius;
}

/** 自动布局间距：`spacing` 绑定优先，否则用节点自己的 gap。 */
export function resolveGap(document: DesignDocument, node: DesignNode): number {
  return tokenNumber(document, node.bindings?.spacing) ?? node.layout.gap ?? 0;
}
