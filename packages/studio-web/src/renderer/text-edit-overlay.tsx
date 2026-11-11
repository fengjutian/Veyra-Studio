import { useEffect, useRef, useState } from "react";
import { TEXT_DEFAULTS, remapParagraphStyles, remapTextRuns, runStyleAt, type DesignNode, type ParagraphStyleRun, type TextNode, type TextRun, type TextRunStyle } from "@ufira/design-schema";
import type { SceneBox } from "./scene";
import { textEditAction, textEditBoldShortcut } from "../text-edit";
import {
  editorParagraphs,
  editorSelectionOffsets,
  mergeEditorRunStyle,
  readEditorRuns,
  readEditorText,
  renderEditorParagraphs,
  restoreEditorSelection,
  sameParagraphLayout,
  sameRunLayout,
  updateEditorRunStyles,
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
 * 否则每键都会重建 DOM、光标随之丢失。提交时直接从 DOM 还原文本与段内样式，
 * 不依赖 React 状态（避免「最后一次输入还没进 state 就提交」的时序问题）。
 *
 * 规格见 `docs/inline-text-editing.md`。
 */
export interface TextEditOverlayProps {
  node: DesignNode;
  box: SceneBox;
  onCommit(value: string): void;
  onCancel(): void;
  /**
   * 可选：富文本提交（带段内样式与段落样式）。
   *
   * 给了就用它，`onCommit` 不再被调用——调用方可以只接一种。
   */
  onCommitRich?(value: string, runs: TextRun[], paragraphStyles: ParagraphStyleRun[]): void;
}

/** 编辑器当前承载的模型：DOM 就是按它渲染出来的。 */
interface EditorState {
  /** 渲染时的文本。 */
  text: string;
  /** 渲染时的段内样式区间。 */
  runs: TextRun[];
  /** 渲染时的段落样式区间。 */
  paragraphStyles: ParagraphStyleRun[];
}

export function TextEditOverlay({ node, box, onCommit, onCancel, onCommitRich }: TextEditOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const builtFor = useRef<string | undefined>(undefined);
  const stateRef = useRef<EditorState>({ text: "", runs: [], paragraphStyles: [] });
  /** 当前选区（UTF-16 偏移）；折叠或不在编辑器里时是 undefined。 */
  const [selection, setSelection] = useState<{ from: number; to: number } | undefined>(undefined);
  /**
   * 用户是否已经动过编辑器。
   *
   * 进入编辑时会全选一遍（与旧的 textarea 行为一致），那不是「用户选了这段」，
   * 不该弹出工具条——只有用户自己拉出来的选区才算。
   */
  const interacted = useRef(false);

  const base = node.type === "text" ? baseStyleOf(node) : undefined;

  // 挂载时构建一次 DOM：段落块 + 段内 run + 列表标记。
  // 换了一个文本节点必须重建——否则显示的还是上一个节点的内容。
  // 同一个节点但属性变了：**结构**变了（run 区间或段落结构）就重建，
  // 只是**样式**变了就地更新 run 元素的行内样式——光标与选区因此保住。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || node.type !== "text") return;
    if (builtFor.current !== node.id) {
      builtFor.current = node.id;
      finished.current = false;
      const runs = node.runs ?? [];
      const paragraphStyles = node.paragraphStyles ?? [];
      stateRef.current = { text: node.text, runs, paragraphStyles };
      renderEditorParagraphs(root, editorParagraphs(node.text, runs, paragraphStyles), baseStyleOf(node));
      // 进入编辑时全选（与旧的 textarea 行为一致）。
      selectAll(root);
      root.focus();
      return;
    }
    syncEditorModel(root, node, baseStyleOf(node), stateRef);
  }, [node.id, node]);

  // 选区变化时刷新工具栏的状态（按钮是否高亮、当前颜色与字号）。
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const handler = () => {
      if (!interacted.current) return;
      refreshSelection(rootRef.current, setSelection);
    };
    doc.addEventListener("selectionchange", handler);
    return () => doc.removeEventListener("selectionchange", handler);
  }, []);

  /** 选区起点的样式：工具栏用它回显按钮状态。 */
  const selectionStyle = (() => {
    if (!selection || !base) return {} as TextRunStyle;
    const root = rootRef.current;
    if (!root) return {} as TextRunStyle;
    return runStyleAt(readEditorText(root), readEditorRuns(root, base), selection.from);
  })();
  const selectionWeight = selectionStyle.fontWeight ?? base?.fontWeight ?? 400;
  const selectionColor = selectionStyle.color ?? base?.color ?? "#111111";
  const selectionFontSize = selectionStyle.fontSize ?? base?.fontSize ?? 16;

  /** 把样式应用到当前选区：重建 DOM 并把选区放回去。 */
  const applySelectionStyle = (style: TextRunStyle, clear: (keyof TextRunStyle)[] = []) => {
    const root = rootRef.current;
    if (!root || !selection || node.type !== "text") return;
    const currentBase = baseStyleOf(node);
    const text = readEditorText(root);
    const runs = readEditorRuns(root, currentBase);
    const nextRuns = mergeEditorRunStyle(text, runs, selection.from, selection.to, style, clear);
    const paragraphStyles = remapParagraphStyles(stateRef.current.text, text, stateRef.current.paragraphStyles);
    renderEditorParagraphs(root, editorParagraphs(text, nextRuns, paragraphStyles), currentBase);
    stateRef.current = { text, runs: nextRuns, paragraphStyles };
    restoreEditorSelection(root, selection.from, selection.to);
    // 重新渲染，工具栏的回显才跟得上（选区偏移没变，但样式变了）。
    setSelection({ ...selection });
  };

  const toggleBold = () => {
    if (!selection) return;
    if (selectionWeight >= 600) applySelectionStyle({}, ["fontWeight"]);
    else applySelectionStyle({ fontWeight: 700 });
  };

  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const root = rootRef.current;
    if (!commit) {
      onCancel();
      return;
    }
    const text = root ? readEditorText(root) : "";
    if (!onCommitRich) {
      onCommit(text);
      return;
    }
    // 富文本提交：段内样式从 DOM 读回来，段落样式按当前文本重新吸附。
    const currentBase = node.type === "text" ? baseStyleOf(node) : undefined;
    const runs = root && currentBase ? readEditorRuns(root, currentBase) : [];
    const paragraphStyles = remapParagraphStyles(stateRef.current.text, text, stateRef.current.paragraphStyles);
    onCommitRich(text, runs, paragraphStyles);
  };

  return (
    <>
      {selection && (
        <div
          ref={toolbarRef}
          className="rte-toolbar"
          style={{ left: box.x, top: Math.max(0, box.y - 36) }}
        >
          <button
            type="button"
            className="rte-tool"
            style={selectionWeight >= 600 ? { fontWeight: 700, color: "#8b5cf6" } : undefined}
            onMouseDown={event => event.preventDefault()}
            onClick={toggleBold}
          >
            B
          </button>
          <input
            type="color"
            className="rte-tool-color"
            value={selectionColor}
            onChange={event => applySelectionStyle({ color: event.target.value })}
          />
          <input
            type="number"
            className="rte-tool-size"
            value={selectionFontSize}
            min={1}
            onChange={event => {
              const size = Number(event.target.value);
              if (Number.isFinite(size) && size > 0) applySelectionStyle({ fontSize: size });
            }}
          />
        </div>
      )}
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
            return;
          }
          // Ctrl/Cmd+B：给选区加粗（与 Figma 一致）。
          if (textEditBoldShortcut(event.key, event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            toggleBold();
          }
          // Shift+Enter：浏览器插入 `<br>`，提交时还原成换行。
        }}
        onKeyUp={() => {
          interacted.current = true;
          refreshSelection(rootRef.current, setSelection);
        }}
        onMouseDown={() => { interacted.current = true; }}
        onMouseUp={() => {
          interacted.current = true;
          refreshSelection(rootRef.current, setSelection);
        }}
        onBlur={event => {
          // 焦点去了工具栏：那不是提交，是继续编辑。
          const next = event.relatedTarget as Node | null;
          if (next && toolbarRef.current?.contains(next)) return;
          finish(true);
        }}
      />
    </>
  );
}

/**
 * 把节点的新属性同步到编辑器 DOM。
 *
 * - **结构变化**（run 的区间或段落结构改了）：重建 DOM；
 * - **样式变化**（节点级字重/字号/颜色变了）：只更新 run 元素的行内样式，
 *   DOM 结构不动——光标与选区因此保住。
 *
 * 节点上的偏移是按「构建时的文本」算的，用户在编辑器里打过的字会让它漂移，
 * 所以先按最长公共前缀/后缀对齐到当前 DOM 文本。
 */
function syncEditorModel(root: HTMLElement, node: TextNode, base: EditorBaseStyle, stateRef: { current: EditorState }): void {
  const state = stateRef.current;
  const domText = readEditorText(root);
  const nextRuns = remapTextRuns(state.text, domText, node.runs ?? []);
  const nextParagraphStyles = remapParagraphStyles(state.text, domText, node.paragraphStyles ?? []);
  // 与「当前 DOM 对应的区间」比较：只有真的变了才算结构变化。
  const alignedRuns = remapTextRuns(state.text, domText, state.runs);
  const alignedParagraphStyles = remapParagraphStyles(state.text, domText, state.paragraphStyles);
  const structureChanged = !sameRunLayout(alignedRuns, nextRuns)
    || !sameParagraphLayout(alignedParagraphStyles, nextParagraphStyles);

  if (!structureChanged && updateEditorRunStyles(root, nextRuns, base)) {
    // 样式变化：就地更新即可，光标不动。
    stateRef.current = { text: domText, runs: nextRuns, paragraphStyles: nextParagraphStyles };
    return;
  }
  // 结构变化（或区间对不上）：重建 DOM。
  stateRef.current = { text: domText, runs: nextRuns, paragraphStyles: nextParagraphStyles };
  renderEditorParagraphs(root, editorParagraphs(domText, nextRuns, nextParagraphStyles), base);
  root.focus();
}

/** 读当前选区；折叠或不在编辑器里时清掉工具栏。 */
function refreshSelection(root: HTMLElement | null, setSelection: (value: { from: number; to: number } | undefined) => void): void {
  if (!root) {
    setSelection(undefined);
    return;
  }
  const selection = root.ownerDocument.defaultView?.getSelection() ?? null;
  const offsets = editorSelectionOffsets(root, selection);
  setSelection(offsets && offsets.to > offsets.from ? offsets : undefined);
}

/** 节点级默认样式（段内 run 没覆盖的字段用它）。 */
function baseStyleOf(node: DesignNode): EditorBaseStyle {
  return {
    // 缺省值与画布一致（scene.ts 用的是同一套兜底），否则编辑器里的字重
    // 与画布上的不一样——「编辑时看到真实的样式」就破了。
    fontWeight: node.type === "text" ? node.fontWeight ?? TEXT_DEFAULTS.fontWeight : TEXT_DEFAULTS.fontWeight,
    fontStyle: node.type === "text" ? node.fontStyle ?? TEXT_DEFAULTS.fontStyle : TEXT_DEFAULTS.fontStyle,
    fontSize: node.type === "text" ? node.fontSize : 16,
    color: primaryFillColorOf(node) ?? "#111111",
    ...(node.type === "text" ? { lineHeight: node.lineHeight } : {}),
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
