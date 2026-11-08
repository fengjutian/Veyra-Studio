import { useEffect, useRef } from "react";
import type { DesignNode } from "@ufira/design-schema";
import type { SceneBox } from "./scene";
import { textEditAction } from "../text-edit";
import {
  editorParagraphs,
  readEditorText,
  renderEditorParagraphs,
  type EditorBaseStyle,
} from "./rich-text-editor-model";

/**
 * 文本编辑覆盖层。
 *
 * 画布本身是 Canvas，没法原生编辑文字，所以双击文本节点时在节点位置盖一层
 * `contenteditable` 区域：段落是 DOM 里的块，段内样式与列表标记按文档渲染，
 * 因此**编辑时能看到真实的样式**（加粗、变色、列表标记与缩进）。
 *
 * 之前这里是一个纯 `<textarea>`：只能显示节点级样式，段内样式与列表全看不见。
 *
 * DOM 是**不受控**的——内容被用户直接改写，React 不再回写 children，
 * 否则每键都会重建 DOM、光标随之丢失。提交时直接从 DOM 还原文本，
 * 不依赖 React 状态（避免「最后一次输入还没进 state 就提交」的时序问题）。
 *
 * 规格见 `docs/inline-text-editing.md`。
 */
export interface TextEditOverlayProps {
  node: DesignNode;
  box: SceneBox;
  onCommit(value: string): void;
  onCancel(): void;
}

export function TextEditOverlay({ node, box, onCommit, onCancel }: TextEditOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const builtFor = useRef<string | undefined>(undefined);

  // 挂载时构建一次 DOM：段落块 + 段内 run + 列表标记。
  // 只构建一次：重建会把用户的光标与选区一起丢掉。
  // 但换了一个文本节点就必须重建——否则显示的还是上一个节点的内容。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || node.type !== "text" || builtFor.current === node.id) return;
    builtFor.current = node.id;
    finished.current = false;
    renderEditorParagraphs(root, editorParagraphs(node.text, node.runs, node.paragraphStyles), baseStyleOf(node));
    // 进入编辑时全选（与旧的 textarea 行为一致）。
    selectAll(root);
    root.focus();
  }, [node.id, node]);

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const root = rootRef.current;
    if (commit) onCommit(root ? readEditorText(root) : "");
    else onCancel();
  };

  const base = node.type === "text" ? baseStyleOf(node) : undefined;

  return (
    <div
      ref={rootRef}
      className="rich-text-editor"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        minHeight: Math.max(box.height, 24),
        fontFamily: node.type === "text" ? node.fontFamily : undefined,
        fontSize: node.type === "text" ? node.fontSize : undefined,
        lineHeight: node.type === "text" ? `${node.lineHeight}px` : undefined,
        fontWeight: node.type === "text" ? node.fontWeight : undefined,
        color: base?.color,
        textAlign: node.type === "text" ? node.textAlign : undefined,
      }}
      onKeyDown={event => {
        const action = textEditAction(event.key, event.shiftKey);
        if (action === "cancel") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
          return;
        }
        if (action === "commit") {
          // Enter 提交编辑：不让浏览器拆段落（拆段落会打乱段落样式）。
          event.preventDefault();
          finish(true);
        }
        // Shift+Enter：浏览器插入 `<br>`，提交时还原成换行。
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** 节点级默认样式（段内 run 没覆盖的字段用它）。 */
function baseStyleOf(node: DesignNode): EditorBaseStyle {
  return {
    fontWeight: node.type === "text" ? node.fontWeight : 400,
    fontStyle: node.type === "text" ? node.fontStyle : "normal",
    fontSize: node.type === "text" ? node.fontSize : 16,
    color: primaryFillColorOf(node) ?? "#111111",
  };
}

/** 文本节点的填充主色：实色取自身、渐变取首个色标。 */
function primaryFillColorOf(node: DesignNode): string | undefined {
  const paint = node.appearance.fills?.[0];
  if (!paint) return undefined;
  return paint.type === "solid" ? paint.color : paint.stops[0]?.color;
}

/** 全选编辑器里的内容。 */
function selectAll(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
}
