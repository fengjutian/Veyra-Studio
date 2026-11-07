import { useMemo, useRef } from "react";
import type { DesignDocument } from "@ufira/design-schema";
import { buildA11yTree, deletionTarget, indexOfSelection, moveIndex } from "./a11y-tree";

/**
 * 视觉隐藏但可聚焦的节点列表。
 *
 * 纯 Canvas 画布下，键盘用户需要一条进入结构的路径：Tab 进入列表后，上下箭头移动
 * 并同步选中，Home/End 跳到首尾。列表用 `role="listbox"` + `option`，屏幕阅读器
 * 能读出名称、类型与锁定状态。
 */
export interface CanvasA11yLayerProps {
  document: DesignDocument;
  pageId: string;
  selectedIds: string[];
  onSelect(ids: string[]): void;
  /** Delete/Backspace 删除当前节点。 */
  onDelete?(id: string): void;
}

export function CanvasA11yLayer({ document, pageId, selectedIds, onSelect, onDelete }: CanvasA11yLayerProps) {
  const items = useMemo(() => buildA11yTree(document, pageId), [document, pageId]);
  const refs = useRef<Array<HTMLLIElement | null>>([]);
  const activeIndex = indexOfSelection(items, selectedIds);

  const focusIndex = (index: number, select = true) => {
    const item = items[index];
    const element = refs.current[index];
    if (!item) return;
    element?.focus();
    if (select) onSelect([item.id]);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = activeIndex;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusIndex(moveIndex(current, 1, items.length));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusIndex(moveIndex(current, -1, items.length));
        break;
      case "Home":
        event.preventDefault();
        focusIndex(0);
        break;
      case "End":
        event.preventDefault();
        focusIndex(items.length - 1);
        break;
      case "Delete":
      case "Backspace": {
        // 锁定节点标了 aria-disabled，就不能真的被删掉。
        const item = deletionTarget(items, current);
        if (item) {
          event.preventDefault();
          onDelete?.(item.id);
        }
        break;
      }
      default:
        break;
    }
  };

  if (!items.length) return null;
  return (
    <ul className="canvas-a11y" role="listbox" aria-label="画布节点" onKeyDown={handleKeyDown}>
      {items.map((item, index) => (
        <li
          key={item.id}
          ref={element => { refs.current[index] = element; }}
          role="option"
          aria-selected={selectedIds.includes(item.id)}
          aria-level={item.level + 1}
          aria-disabled={item.locked || undefined}
          tabIndex={index === (activeIndex >= 0 ? activeIndex : 0) ? 0 : -1}
          onFocus={() => onSelect([item.id])}
          onClick={() => onSelect([item.id])}
        >
          {item.label}
          <span className="canvas-a11y-kind"> · {item.kind}{item.locked ? " · 已锁定" : ""}</span>
        </li>
      ))}
    </ul>
  );
}
