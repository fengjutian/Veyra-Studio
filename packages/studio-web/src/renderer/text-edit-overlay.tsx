import { useEffect, useRef, useState } from "react";
import type { DesignNode } from "@ufira/design-schema";
import type { SceneBox } from "./scene";

/**
 * 文本编辑覆盖层。
 *
 * 画布本身是 Canvas，没法原生编辑文字，所以双击文本节点时在节点位置盖一个
 * `<textarea>`（tldraw 也是这么做的）：输入法、选择、撤销都交给浏览器。
 * 提交/取消后移除覆盖层，改动仍走 `text.patch` 事务。
 */
export interface TextEditOverlayProps {
  node: DesignNode;
  box: SceneBox;
  onCommit(value: string): void;
  onCancel(): void;
}

export function TextEditOverlay({ node, box, onCommit, onCancel }: TextEditOverlayProps) {
  const [value, setValue] = useState(node.type === "text" ? node.text : "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <textarea
      ref={ref}
      className="canvas-text-edit"
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: Math.max(box.height, 24),
        fontFamily: node.type === "text" ? node.fontFamily : undefined,
        fontSize: node.type === "text" ? node.fontSize : undefined,
        lineHeight: node.type === "text" ? `${node.lineHeight}px` : undefined,
        fontWeight: node.type === "text" ? node.fontWeight : undefined,
        color: primaryFillColorOf(node) ?? "#111111",
      }}
      value={value}
      onChange={event => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          finish(true);
        }
      }}
    />
  );
}

/** 文本节点的填充主色：实色取自身、渐变取首个色标。 */
function primaryFillColorOf(node: DesignNode): string | undefined {
  const paint = node.appearance.fills?.[0];
  if (!paint) return undefined;
  return paint.type === "solid" ? paint.color : paint.stops[0]?.color;
}