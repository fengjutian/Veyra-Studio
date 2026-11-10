import type { CornerRadii, DesignDocument, DesignNode, Paint, Theme, TokenValue, TypographyValue } from "./types";

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

/** 按 id 找主题；找不到返回 `undefined`（视图层据此退回基础值）。 */
export function findTheme(document: DesignDocument, themeId: string | undefined): Theme | undefined {
  if (!themeId) return undefined;
  return (document.themes ?? []).find(theme => theme.id === themeId);
}

/**
 * 主题的继承链，从**最远的祖先**到主题自己。
 *
 * 顺序很重要：叠加覆盖时祖先先、后代后，后代的值才生效。
 *
 * 链上成环或指向不存在的主题时返回 `undefined`——校验阶段会拦下这两种情况，
 * 这里只是不再无限循环。
 */
export function themeChain(document: DesignDocument, themeId: string | undefined): Theme[] | undefined {
  if (!themeId) return [];
  const themes = document.themes ?? [];
  const chain: Theme[] = [];
  const seen = new Set<string>();
  let current = themes.find(theme => theme.id === themeId);
  while (current) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    chain.push(current);
    current = current.extends ? themes.find(theme => theme.id === current!.extends) : undefined;
  }
  // 链走完了但起点没找到 → 指向不存在的主题。
  if (chain[0]?.id !== themeId) return undefined;
  return chain.reverse();
}

/**
 * 某个主题自己（不含继承）是否覆盖了这个 token。
 *
 * 面板据此显示「已覆盖」并给出「恢复基础值」——只有**自己**写了覆盖才谈得上
 * 恢复；继承来的值要改就得改父主题。
 */
export function isTokenOverridden(document: DesignDocument, themeId: string | undefined, name: string): boolean {
  const theme = findTheme(document, themeId);
  return Boolean(theme && Object.prototype.hasOwnProperty.call(theme.tokens, name));
}

/**
 * 这个 token 的值来自哪个主题（继承链上最后一个覆盖它的主题）。
 *
 * 面板据此显示「继承自 暗色」——继承来的值**不是**当前主题自己写的，用户不能
 * 在这里「恢复基础值」，得去父主题改。
 */
export function inheritedTokenSource(document: DesignDocument, themeId: string | undefined, name: string): Theme | undefined {
  const chain = themeChain(document, themeId);
  if (!chain) return undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const theme = chain[index]!;
    if (Object.prototype.hasOwnProperty.call(theme.tokens, name)) return theme;
  }
  return undefined;
}

/**
 * 某一页实际该用哪个主题。
 *
 * 优先级：**显式指定 > 页面自带 > 无主题**。
 *
 * - 显式指定（视图层选了某个主题、或导出器传了 themeId）——用户说了算；
 * - 页面自带（`page.themeId`）——「暗色演示页」靠它，翻到那页自动是暗色；
 * - 都没有就用基础值。
 */
export function effectivePageThemeId(document: DesignDocument, pageId: string | undefined, override?: string): string | undefined {
  if (override) return override;
  const page = pageId ? document.pages[pageId] : undefined;
  return page?.themeId;
}

/** 合并后的 token 表：基础值 + 主题覆盖（含继承链）。 */
export function themeTokenMap(document: DesignDocument, themeId: string | undefined): Record<string, TokenValue> {
  const chain = themeChain(document, themeId);
  if (!chain?.length) return document.tokens;
  const overrides: Record<string, TokenValue> = {};
  for (const theme of chain) Object.assign(overrides, theme.tokens);
  if (!Object.keys(overrides).length) return document.tokens;
  return { ...document.tokens, ...overrides };
}

/**
 * 把主题覆盖应用到文档上，返回一份**浅拷贝**。
 *
 * 主题不是新的解析链路：进入布局、渲染、导出之前把覆盖合并进 token 表，
 * 之后所有解析（包括别名、字体 token、组件）都按普通 token 走。
 * 因此 `resolveTokenTarget()` 不需要认识主题，调用方也不必层层传递 themeId。
 *
 * 没有主题、或主题没有任何覆盖时原样返回同一个对象，调用方可以据此跳过重算。
 */
export function applyThemeTokens(document: DesignDocument, themeId: string | undefined): DesignDocument {
  const merged = themeTokenMap(document, themeId);
  if (merged === document.tokens) return document;
  return { ...document, tokens: merged };
}

/**
 * 把**这一页该用的主题**合并进文档。
 *
 * 页面主题的优先级：显式指定 > 页面自带 > 基础值。所有渲染与导出入口都走这里，
 * 免得每个入口各写一套「到底用哪个主题」的判断——那正是画布和导出物对不上的来源。
 */
export function applyThemeForPage(
  document: DesignDocument,
  pageId: string | undefined,
  themeId?: string,
): DesignDocument {
  return applyThemeTokens(document, effectivePageThemeId(document, pageId, themeId));
}

/**
 * 别名链的最大深度。
 *
 * 语义 token 套一层就够，「主题 → 语义 → 基础」最多三层；16 层只是防御性上限，
 * 真正防环靠 `seen` 集合与文档校验。
 */
export const MAX_TOKEN_ALIAS_DEPTH = 16;

/**
 * 沿别名链解析到最终 token。
 *
 * 返回最终 token 与它的名字；断链、环、超深都返回 `undefined`（调用方退回节点值）。
 * 这是**唯一**的别名解析入口——`tokenNumber` / `tokenColor` / `tokenTypography`
 * 都经过它，因此绑定校验与渲染不会对「别名指向什么类型」有两套答案。
 */
export function resolveTokenTarget(
  document: DesignDocument,
  name: string | undefined,
): { name: string; token: TokenValue } | undefined {
  let current = name;
  const seen = new Set<string>();
  for (let depth = 0; depth <= MAX_TOKEN_ALIAS_DEPTH; depth++) {
    if (!current) return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    const token = document.tokens[current];
    if (!token) return undefined;
    if (token.type !== "alias") return { name: current, token };
    current = token.value;
  }
  return undefined;
}

/** 数值 token（间距、圆角、字号等）。 */
export function tokenNumber(document: DesignDocument, name: string | undefined): number | undefined {
  const token = resolveTokenTarget(document, name)?.token;
  return token?.type === "number" && typeof token.value === "number" ? token.value : undefined;
}

/** 颜色 token。 */
export function tokenColor(document: DesignDocument, name: string | undefined): string | undefined {
  const token = resolveTokenTarget(document, name)?.token;
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
  const token = resolveTokenTarget(document, name)?.token;
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
