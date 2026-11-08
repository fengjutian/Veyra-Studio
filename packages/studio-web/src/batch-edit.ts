import { TEXT_DEFAULTS, type AppearanceSpec, type DesignDocument, type DesignNode, type FontStyle, type LayoutSpec, type PropertyBindings, type SizeMode, type TextAlign, type TextPatch } from "@ufira/design-schema";

/** 批量面板里一个字段的取值状态：值一致时 `value` 有效，值不一致时 `mixed` 为 true。 */
export interface BatchField<T> {
  value: T;
  mixed: boolean;
}

/** 批量外观改动。只列出要改的字段，未列出的字段保持节点自己的值。 */
export interface BatchAppearanceChanges {
  fill?: string;
  stroke?: string;
  cornerRadius?: number;
  opacity?: number;
}

/** 批量布局改动。只列出要改的字段，未列出的字段保持节点自己的值。 */
export interface BatchLayoutChanges {
  widthMode?: SizeMode;
  heightMode?: SizeMode;
  width?: number;
  height?: number;
}

/** 批量文字样式改动。只列出要改的字段，未列出的字段保持节点自己的值。 */
export interface BatchTextChanges {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: number;
  fontStyle?: FontStyle;
  textAlign?: TextAlign;
  letterSpacing?: number;
}

/**
 * Reads the value a field has across a selection.
 *
 * When the selected nodes disagree the field reports `mixed`, so the inspector can
 * leave it blank instead of pretending that one of the values is the truth.
 */
export function sharedField<T, N extends DesignNode = DesignNode>(nodes: readonly N[], pick: (node: N) => T): BatchField<T> {
  if (!nodes.length) return { value: undefined as unknown as T, mixed: false };
  const first = pick(nodes[0]!);
  return { value: first, mixed: nodes.some(node => !Object.is(pick(node), first)) };
}

/**
 * Merges appearance changes into one node's appearance.
 *
 * The runtime replaces the whole appearance block on a patch, so every field the
 * user did not touch has to be carried over from the node itself.
 */
export function mergedAppearance(node: DesignNode, changes: BatchAppearanceChanges): AppearanceSpec {
  const appearance: AppearanceSpec = { ...node.appearance };
  // 批量填色始终写成单一实色层；空字符串表示清空填充。
  if (changes.fill !== undefined) appearance.fills = changes.fill ? [{ type: "solid", color: changes.fill }] : undefined;
  if (changes.stroke !== undefined) appearance.stroke = changes.stroke || undefined;
  if (changes.cornerRadius !== undefined) appearance.cornerRadius = changes.cornerRadius;
  if (changes.opacity !== undefined) appearance.opacity = changes.opacity;
  return appearance;
}

/**
 * Merges layout changes into one node's layout.
 *
 * Setting a width or a height also switches that axis to `fixed`: the layout engine
 * only reads the stored size when the size mode is `fixed`, so typing a size would
 * otherwise be silently ignored on `hug` and `fill` nodes.
 */
export function mergedLayout(node: DesignNode, changes: BatchLayoutChanges): LayoutSpec {
  const layout: LayoutSpec = { ...node.layout };
  if (changes.widthMode !== undefined) layout.widthMode = changes.widthMode;
  if (changes.heightMode !== undefined) layout.heightMode = changes.heightMode;
  if (changes.width !== undefined) { layout.width = changes.width; layout.widthMode = "fixed"; }
  if (changes.height !== undefined) { layout.height = changes.height; layout.heightMode = "fixed"; }
  return layout;
}

/** 一个节点的外观批量改动。`bindings` 只在需要解除 token 绑定时出现。 */
export interface AppearancePatch {
  id: string;
  appearance: AppearanceSpec;
  bindings?: PropertyBindings;
}

/**
 * Plans the appearance patches for a selection.
 *
 * Nodes whose appearance would not change are skipped so the edit does not bump the
 * document revision for nothing.
 */
export function planAppearancePatches(nodes: readonly DesignNode[], changes: BatchAppearanceChanges): AppearancePatch[] {
  return nodes.flatMap(node => {
    const appearance = mergedAppearance(node, changes);
    // A new fill only shows up when the node is not driven by a fill token.
    const releasesFill = changes.fill !== undefined && Boolean(node.bindings?.fill);
    if (sameAppearance(node.appearance, appearance) && !releasesFill) return [];
    return [{ id: node.id, appearance, bindings: releasesFill ? withoutFillBinding(node.bindings!) : undefined }];
  });
}

/** 一个节点的布局批量改动。 */
export interface LayoutPatch {
  id: string;
  layout: LayoutSpec;
}

/**
 * Plans the layout patches for a selection, skipping the nodes that would not change.
 */
export function planLayoutPatches(nodes: readonly DesignNode[], changes: BatchLayoutChanges): LayoutPatch[] {
  return nodes.flatMap(node => {
    const layout = mergedLayout(node, changes);
    return sameLayout(node.layout, layout) ? [] : [{ id: node.id, layout }];
  });
}

/** 一个节点的文字样式批量改动。 */
export interface TextStylePatch {
  id: string;
  patch: TextPatch;
}

/**
 * Plans the text style patches for a selection.
 *
 * Only text nodes take part: the other nodes in the selection are skipped instead of
 * failing the command. Nodes whose style would not change are skipped too, so the
 * edit does not bump the document revision for nothing.
 */
export function planTextPatches(nodes: readonly DesignNode[], changes: BatchTextChanges): TextStylePatch[] {
  return nodes.flatMap(node => {
    if (node.type !== "text") return [];
    const patch: TextPatch = {};
    if (changes.fontFamily !== undefined && node.fontFamily !== changes.fontFamily) patch.fontFamily = changes.fontFamily;
    if (changes.fontSize !== undefined && node.fontSize !== changes.fontSize) patch.fontSize = changes.fontSize;
    if (changes.lineHeight !== undefined && node.lineHeight !== changes.lineHeight) patch.lineHeight = changes.lineHeight;
    if (changes.fontWeight !== undefined && (node.fontWeight ?? TEXT_DEFAULTS.fontWeight) !== changes.fontWeight) patch.fontWeight = changes.fontWeight;
    if (changes.fontStyle !== undefined && (node.fontStyle ?? TEXT_DEFAULTS.fontStyle) !== changes.fontStyle) patch.fontStyle = changes.fontStyle;
    if (changes.textAlign !== undefined && (node.textAlign ?? TEXT_DEFAULTS.textAlign) !== changes.textAlign) patch.textAlign = changes.textAlign;
    if (changes.letterSpacing !== undefined && (node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing) !== changes.letterSpacing) patch.letterSpacing = changes.letterSpacing;
    return Object.keys(patch).length ? [{ id: node.id, patch }] : [];
  });
}

/**
 * Collects the ids of the objects that "select all" picks on a page.
 *
 * Only the top level objects are returned: selecting a parent already covers its
 * children, which is the same rule the clipboard follows to avoid handling a child twice.
 */
export function selectAllIds(document: DesignDocument, pageId: string): string[] {
  const page = document.pages[pageId];
  if (!page) return [];
  return page.childIds.filter(id => Boolean(document.nodes[id]));
}

function withoutFillBinding(bindings: PropertyBindings): PropertyBindings {
  const next = { ...bindings };
  delete next.fill;
  return next;
}

function sameAppearance(left: AppearanceSpec, right: AppearanceSpec): boolean {
  return left.opacity === right.opacity && sameFills(left, right) && left.stroke === right.stroke && left.cornerRadius === right.cornerRadius;
}

/** 填充是数组，逐层比较；纯色与渐变不能混为一谈。 */
function sameFills(left: AppearanceSpec, right: AppearanceSpec): boolean {
  return JSON.stringify(left.fills ?? []) === JSON.stringify(right.fills ?? []);
}

function sameLayout(left: LayoutSpec, right: LayoutSpec): boolean {
  return left.mode === right.mode
    && left.direction === right.direction
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.widthMode === right.widthMode
    && left.heightMode === right.heightMode
    && left.gap === right.gap
    && left.align === right.align
    && samePadding(left.padding, right.padding);
}

function samePadding(left: LayoutSpec["padding"], right: LayoutSpec["padding"]): boolean {
  if (!left || !right) return left === right;
  return left.top === right.top && left.right === right.right && left.bottom === right.bottom && left.left === right.left;
}
