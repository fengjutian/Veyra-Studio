import { validateDocument, type DesignDocument, type DesignNode, type NodeId, type TextNode } from "@ufira/design-schema";
import type { ComputedBox, LayoutOptions, LayoutResult, LayoutWarning, Size, TextMeasurer } from "./types";

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

const defaultTextMeasurer: TextMeasurer = {
  measure(node: TextNode, availableWidth?: number): Size {
    const rawWidth = Math.max(1, node.text.length) * node.fontSize * 0.6;
    if (!availableWidth || availableWidth <= 0 || rawWidth <= availableWidth) {
      return { width: rawWidth, height: node.lineHeight };
    }
    const lines = Math.ceil(rawWidth / availableWidth);
    return { width: availableWidth, height: lines * node.lineHeight };
  },
};

export function computePageLayout(documentInput: DesignDocument, pageId: string, options: LayoutOptions): LayoutResult {
  const document = validateDocument(documentInput);
  const page = document.pages[pageId];
  if (!page) throw new Error(`Page ${pageId} does not exist`);
  if (!Number.isFinite(options.viewport.width) || !Number.isFinite(options.viewport.height) || options.viewport.width < 0 || options.viewport.height < 0) {
    throw new Error("Viewport dimensions must be finite non-negative numbers");
  }

  const boxes: Record<NodeId, ComputedBox> = {};
  const warnings: LayoutWarning[] = [];
  const measurer = options.textMeasurer ?? defaultTextMeasurer;
  const intrinsicCache = new Map<NodeId, Size>();

  const intrinsic = (nodeId: NodeId): Size => {
    const cached = intrinsicCache.get(nodeId);
    if (cached) return cached;
    const node = document.nodes[nodeId];
    if (!node) return { width: 0, height: 0 };
    let content: Size;
    if (node.type === "text") content = measurer.measure(node);
    else if (node.childIds.length) content = intrinsicContainer(node);
    else content = { width: node.layout.width, height: node.layout.height };
    const result = {
      width: node.layout.widthMode === "hug" ? content.width : node.layout.width,
      height: node.layout.heightMode === "hug" ? content.height : node.layout.height,
    };
    intrinsicCache.set(nodeId, result);
    return result;
  };

  const intrinsicContainer = (node: DesignNode): Size => {
    const padding = node.layout.padding ?? ZERO_PADDING;
    const children = node.childIds.map(id => ({ node: document.nodes[id], size: intrinsic(id) }));
    for (const child of children) {
      if (child.node.layout.widthMode === "fill" || child.node.layout.heightMode === "fill") {
        warnings.push({ nodeId: child.node.id, code: "fill-in-hug", message: `Fill sizing inside hug container ${node.id} uses the child's fallback size` });
      }
    }
    if (node.layout.mode === "stack") {
      const horizontal = node.layout.direction === "horizontal";
      const gap = node.layout.gap ?? 0;
      const main = children.reduce((sum, child) => sum + (horizontal ? child.size.width : child.size.height), 0)
        + Math.max(0, children.length - 1) * gap;
      const cross = children.reduce((max, child) => Math.max(max, horizontal ? child.size.height : child.size.width), 0);
      return horizontal
        ? { width: padding.left + main + padding.right, height: padding.top + cross + padding.bottom }
        : { width: padding.left + cross + padding.right, height: padding.top + main + padding.bottom };
    }
    const width = children.reduce((max, child) => Math.max(max, child.node.layout.x + child.size.width), 0);
    const height = children.reduce((max, child) => Math.max(max, child.node.layout.y + child.size.height), 0);
    return { width: padding.left + width + padding.right, height: padding.top + height + padding.bottom };
  };

  const resolveDimension = (node: DesignNode, axis: "width" | "height", available: number): number => {
    const mode = axis === "width" ? node.layout.widthMode : node.layout.heightMode;
    if (mode === "fill") return Math.max(0, available);
    if (mode === "hug") return intrinsic(node.id)[axis];
    return node.layout[axis];
  };

  const layoutNode = (nodeId: NodeId, x: number, y: number, availableWidth: number, availableHeight: number, forced?: Partial<Size>): void => {
    const node = document.nodes[nodeId];
    const width = forced?.width ?? resolveDimension(node, "width", availableWidth);
    const height = forced?.height ?? resolveDimension(node, "height", availableHeight);
    boxes[nodeId] = { x, y, width, height };
    if (!node.childIds.length) return;

    const padding = node.layout.padding ?? ZERO_PADDING;
    const contentX = x + padding.left;
    const contentY = y + padding.top;
    const contentWidth = Math.max(0, width - padding.left - padding.right);
    const contentHeight = Math.max(0, height - padding.top - padding.bottom);

    if (node.layout.mode === "absolute") {
      for (const childId of node.childIds) {
        const child = document.nodes[childId];
        layoutNode(childId, contentX + child.layout.x, contentY + child.layout.y, contentWidth, contentHeight);
      }
      return;
    }

    const horizontal = node.layout.direction === "horizontal";
    const mainAvailable = horizontal ? contentWidth : contentHeight;
    const crossAvailable = horizontal ? contentHeight : contentWidth;
    const gap = node.layout.gap ?? 0;
    const children = node.childIds.map(id => document.nodes[id]);
    const fillChildren = children.filter(child => (horizontal ? child.layout.widthMode : child.layout.heightMode) === "fill");
    const fixedMain = children
      .filter(child => !fillChildren.includes(child))
      .reduce((sum, child) => sum + (horizontal ? resolveDimension(child, "width", mainAvailable) : resolveDimension(child, "height", mainAvailable)), 0);
    const gaps = Math.max(0, children.length - 1) * gap;
    const remainder = Math.max(0, mainAvailable - fixedMain - gaps);
    if (fixedMain + gaps > mainAvailable) {
      warnings.push({ nodeId: node.id, code: "overflow", message: `Children exceed ${node.id}'s ${horizontal ? "width" : "height"} by ${fixedMain + gaps - mainAvailable}px` });
    }
    const fillMain = fillChildren.length ? remainder / fillChildren.length : 0;
    let cursor = horizontal ? contentX : contentY;

    for (const child of children) {
      const mainMode = horizontal ? child.layout.widthMode : child.layout.heightMode;
      const main = mainMode === "fill" ? fillMain : horizontal
        ? resolveDimension(child, "width", mainAvailable)
        : resolveDimension(child, "height", mainAvailable);
      const crossMode = horizontal ? child.layout.heightMode : child.layout.widthMode;
      const cross = crossMode === "fill" || node.layout.align === "stretch" ? crossAvailable : horizontal
        ? resolveDimension(child, "height", crossAvailable)
        : resolveDimension(child, "width", crossAvailable);
      const crossOffset = alignmentOffset(node.layout.align ?? "start", crossAvailable, cross);
      const childX = horizontal ? cursor : contentX + crossOffset;
      const childY = horizontal ? contentY + crossOffset : cursor;
      layoutNode(child.id, childX, childY, crossAvailable, mainAvailable, horizontal
        ? { width: main, height: cross }
        : { width: cross, height: main });
      cursor += main + gap;
    }
  };

  for (const nodeId of page.childIds) {
    const node = document.nodes[nodeId];
    layoutNode(nodeId, node.layout.x, node.layout.y, options.viewport.width, options.viewport.height);
  }

  return { pageId, viewport: { ...options.viewport }, boxes, warnings: dedupeWarnings(warnings) };
}

function alignmentOffset(align: "start" | "center" | "end" | "stretch", available: number, size: number): number {
  if (align === "center") return (available - size) / 2;
  if (align === "end") return available - size;
  return 0;
}

function dedupeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    const key = `${warning.nodeId}:${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
