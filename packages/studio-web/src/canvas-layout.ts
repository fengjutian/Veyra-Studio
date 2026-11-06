import { useMemo } from "react";
import { computePageLayout, type ComputedBox, type LayoutResult } from "@ufira/design-layout";
import type { DesignDocument } from "@ufira/design-schema";
import { createBrowserTextMeasurer } from "./browser-text-measurer";

export interface CanvasLayout {
  boxes: Record<string, ComputedBox>;
  warnings: LayoutResult["warnings"];
}

/**
 * Resolves the laid-out geometry of a page.
 *
 * The canvas renders these boxes instead of the raw `layout` values so that
 * `hug`, `fill` and `stack` sizing behave the same way in the editor and in
 * the HTML/SVG exporters.
 */
export function useCanvasLayout(document: DesignDocument, pageId: string, viewport: { width: number; height: number }): CanvasLayout {
  const measurer = useMemo(() => createBrowserTextMeasurer(), []);
  return useMemo(() => {
    try {
      const result = computePageLayout(document, pageId, { viewport, textMeasurer: measurer });
      return { boxes: result.boxes, warnings: result.warnings };
    } catch {
      // A malformed document must not blank the canvas; fall back to raw layout values.
      return { boxes: {}, warnings: [] };
    }
  }, [document, pageId, viewport.width, viewport.height, measurer]);
}

/**
 * Returns the box for a node, falling back to the node's declared layout.
 */
export function resolveBox(layout: CanvasLayout, node: { id: string; layout: { x: number; y: number; width: number; height: number } }): ComputedBox {
  return layout.boxes[node.id] ?? { x: node.layout.x, y: node.layout.y, width: node.layout.width, height: node.layout.height };
}
