/**
 * 内联文本编辑器的浏览器 harness。
 *
 * 只在探针里用：渲染一个 `TextEditOverlay`，把**计算样式**写进 `#report`，
 * 让外部脚本用 `--dump-dom` 读回来断言。
 *
 * 为什么不在 Node 里断言：jsdom 没有排版引擎，算不出字号、宽度与行高；
 * 「编辑态的加粗是不是真的粗」「列表标记占位是不是和画布一致」
 * 必须在真实浏览器里量。
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { TextEditOverlay } from "../src/renderer/text-edit-overlay";
import { readEditorText } from "../src/renderer/rich-text-editor-model";
import "../src/renderer/rich-text-editor.css";

const node = {
  id: "text:1",
  type: "text",
  name: "text:1",
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), x: 0, y: 0, width: 320, height: 120 },
  appearance: defaultAppearance(),
  text: "第一段\n第二段",
  fontFamily: "Inter, sans-serif",
  fontSize: 16,
  lineHeight: 24,
  fontWeight: 400,
  fontStyle: "normal",
  textAlign: "left",
  letterSpacing: 0,
  color: "#111111",
  runs: [{ from: 0, to: 3, style: { fontWeight: 700, color: "#ef4444" } }],
  paragraphStyles: [{ from: 0, to: 3, style: { listType: "bullet", indent: 1 } }],
} as unknown as DesignNode;

// 同步渲染：并发模式下 render 可能被推迟到调度器里，
// 探针在下一帧读 DOM 会读到空内容。
const root = createRoot(document.getElementById("root")!);
flushSync(() => {
  root.render(
    <TextEditOverlay
      node={node}
      box={{ x: 0, y: 0, width: 320, height: 120 }}
      onCommit={() => undefined}
      onCancel={() => undefined}
    />,
  );
});

interface RunReport {
  text: string;
  fontWeight: string;
  fontStyle: string;
  fontSize: string;
  color: string;
}

interface ParagraphReport {
  /** 段落正文（不含标记）。 */
  text: string;
  paddingLeft: string;
  runs: RunReport[];
  marker: { text: string; width: string; marginRight: string; textAlign: string; display: string } | null;
  /** 正文起点相对编辑器左边缘的偏移（px）。 */
  bodyLeft: number;
}

function report(): string {
  const editor = document.querySelector(".rich-text-editor") as HTMLElement;
  const editorStyle = getComputedStyle(editor);
  // 基准是编辑器的**内容盒**左边缘：编辑框自身的边框与内边距（1px + 2px）
  // 是「正在编辑」的装饰，不算排版偏移。
  const editorContentLeft =
    editor.getBoundingClientRect().left +
    Number.parseFloat(editorStyle.borderLeftWidth) +
    Number.parseFloat(editorStyle.paddingLeft);
  const paragraphs: ParagraphReport[] = Array.from(editor.querySelectorAll("[data-editor-paragraph]")).map(block => {
    const element = block as HTMLElement;
    const marker = element.querySelector("[data-editor-marker]") as HTMLElement | null;
    const markerStyle = marker ? getComputedStyle(marker) : null;
    const style = getComputedStyle(element);
    const runs: RunReport[] = Array.from(element.querySelectorAll("[data-editor-run]")).map(run => {
      const runStyle = getComputedStyle(run as Element);
      return {
        text: run.textContent ?? "",
        fontWeight: runStyle.fontWeight,
        fontStyle: runStyle.fontStyle,
        fontSize: runStyle.fontSize,
        color: runStyle.color,
      };
    });
    const bodyLeft =
      element.getBoundingClientRect().left +
      Number.parseFloat(style.paddingLeft) +
      (marker ? marker.getBoundingClientRect().width + Number.parseFloat(markerStyle!.marginRight) : 0) -
      editorContentLeft;
    return {
      text: element.textContent ?? "",
      paddingLeft: style.paddingLeft,
      runs,
      marker: marker
        ? {
          text: marker.textContent ?? "",
          width: markerStyle!.width,
          marginRight: markerStyle!.marginRight,
          textAlign: markerStyle!.textAlign,
          display: markerStyle!.display,
        }
        : null,
      bodyLeft,
    };
  });

  // 模拟一次真实输入：光标移到末尾，插入一个字符，再从 DOM 还原文本。
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, "!");
  const afterInsert = readEditorText(editor);

  return JSON.stringify({
    contentEditable: editor.isContentEditable,
    paragraphs,
    afterInsert,
  });
}

// 采集延后到下一轮任务：布局与字体度量都要等浏览器算完。
setTimeout(() => {
  const target = document.getElementById("report")!;
  try {
    target.textContent = report();
  } catch (error) {
    target.textContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}, 50);
