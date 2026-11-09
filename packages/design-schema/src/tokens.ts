import type { CornerRadii, DesignDocument, DesignNode, Paint, TokenValue, TypographyValue } from "./types";

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

/**
 * 填充层。
 *
 * 颜色 token 只有一个颜色，所以**绑定生效时整组填充被压成单一实色**——渐变没法
 * 绑定到一个颜色 token 上。画布、HTML、SVG、对比度检查都走这个入口，保证「绑定胜出」
 * 这个规则只有一份实现。
 */
export function resolveFills(document: DesignDocument, node: DesignNode): Paint[] {
  const bound = tokenColor(document, node.bindings?.fill);
  if (bound) return [{ type: "solid", color: bound }];
  return node.appearance.fills ?? [];
}

/**
 * 填充的「主色」：实色取自身，渐变取第一个色标。
 *
 * 文本颜色、对比度检查这类只接受单一颜色的地方用它；渐变文本目前退化成首色标。
 */
export function primaryFillColor(document: DesignDocument, node: DesignNode): string | undefined {
  const first = resolveFills(document, node)[0];
  if (!first) return undefined;
  return first.type === "solid" ? first.color : first.stops[0]?.color;
}

/** 圆角：`radius` 绑定优先，否则用节点自身的值。 */
export function resolveRadius(document: DesignDocument, node: DesignNode): number | undefined {
  return tokenNumber(document, node.bindings?.radius) ?? node.appearance.cornerRadius;
}

/**
 * 四角圆角。
 *
 * 优先级：四角独立值 → `radius` token → 单值圆角。返回 `undefined` 表示没有圆角，
 * 调用方应按直角处理。画布、HTML、SVG 都走这一个入口，避免三处各算一套。
 */
export function resolveCornerRadii(document: DesignDocument, node: DesignNode): CornerRadii | undefined {
  const radii = node.appearance.cornerRadii;
  if (radii) return radii;
  const radius = resolveRadius(document, node);
  return radius === undefined ? undefined : [radius, radius, radius, radius];
}

/** 自动布局间距：`spacing` 绑定优先，否则用节点自己的 gap。 */
export function resolveGap(document: DesignDocument, node: DesignNode): number {
  return tokenNumber(document, node.bindings?.spacing) ?? node.layout.gap ?? 0;
}

/** 字体 token 的值；绑的不是 typography token 时返回 `undefined`。 */
export function tokenTypography(document: DesignDocument, name: string | undefined): TypographyValue | undefined {
  const token = resolveToken(document, name);
  return token?.type === "typography" ? token.value : undefined;
}

/**
 * 节点上的字体样式（token 绑定生效时）。
 *
 * 只有文本节点有意义——字体样式不是布局属性，绑在容器上没有任何东西可覆盖，
 * 因此 schema 也会拒绝这种绑定。
 */
export function resolveTypography(document: DesignDocument, node: DesignNode): TypographyValue | undefined {
  if (node.type !== "text") return undefined;
  return tokenTypography(document, node.bindings?.typography);
}

/**
 * 套用字体 token：返回一个文字样式已被覆盖的节点副本。
 *
 * token 里**省略的字段不覆盖**节点值——这样「只统一字号」和「统一整套文字样式」
 * 都能用同一种 token 表达。没有绑定（或绑定失效）时原样返回同一个对象，
 * 调用方可以据此跳过无谓的深拷贝。
 *
 * 画布场景、布局测量与 HTML/SVG 导出都在这里汇合，避免三处各写一套覆盖逻辑。
 */
export function applyTypographyToken(document: DesignDocument, node: DesignNode): DesignNode {
  if (node.type !== "text") return node;
  const typography = resolveTypography(document, node);
  if (!typography) return node;
  return {
    ...node,
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight ?? node.lineHeight,
    fontWeight: typography.fontWeight ?? node.fontWeight,
    fontStyle: typography.fontStyle ?? node.fontStyle,
    letterSpacing: typography.letterSpacing ?? node.letterSpacing,
  };
}
