/**
 * 可访问性自动化的 harness 页面（正常样本）。
 *
 * 目的不是做一张好看的界面，而是给键盘遍历与读屏检查一个**稳定的被测对象**：
 * 结构固定、可访问名确定，改动只可能来自被测代码本身。
 *
 * 页面里用的是真组件：`CanvasA11yLayer` 就是画布给键盘/读屏用户的那条结构路径，
 * 工具按钮的可访问名也沿用 `TOOLS` 里的真实文案。改 harness 等于改被测对象，
 * 所以它保持最小。
 *
 * 探针读两个出口：
 *   - `document.body.dataset.auditReady`：渲染完成
 *   - `window.__auditSelectionLog`：焦点在画布结构里的移动记录
 */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CanvasA11yLayer } from "../src/renderer/a11y-layer";
import { TOOLS } from "../src/tools";
import { fixtureDocument } from "./fixture";
import "../src/styles.css";

const selectionLog: string[] = [];

function Workbench() {
  const document_ = useMemo(() => fixtureDocument(), []);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">A</span>
          <strong className="brand-name">AI Design Studio</strong>
        </div>
        <div className="toolbar-group" role="group" aria-label="画布工具">
          {TOOLS.filter(spec => spec.id !== "hand").map(spec => (
            <button
              key={spec.id}
              type="button"
              className="icon-only"
              data-audit-id={`tool.${spec.id}`}
              aria-label={spec.label}
              aria-pressed={spec.id === "select"}
            >
              {spec.label}
            </button>
          ))}
        </div>
        <div className="toolbar-group" role="group" aria-label="历史">
          <button type="button" className="icon-only" data-audit-id="history.undo" aria-label="撤销">撤销</button>
          <button type="button" className="icon-only" data-audit-id="history.redo" aria-label="重做">重做</button>
        </div>
      </header>

      <aside className="layers">
        <div className="panel-block">
          <div className="panel-head">
            <h2>页面</h2>
          </div>
          <div className="page-list" role="listbox" aria-label="页面列表">
            <button type="button" role="option" aria-selected="true" data-audit-id="page.1">画布渲染基线</button>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <div className="canvas">
          <CanvasA11yLayer
            document={document_}
            pageId="page:1"
            selectedIds={selectedIds}
            onSelect={ids => {
              setSelectedIds(ids);
              selectionLog.push(ids[0] ?? "");
            }}
            onDelete={() => undefined}
          />
        </div>
      </section>

      <aside className="inspector">
        <div className="inspector-body">
          <div className="dialog-field">
            <label className="dialog-field-label" htmlFor="prop-name">名称</label>
            <input className="dialog-input" id="prop-name" data-audit-id="prop.name" defaultValue="画布渲染基线" />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label" htmlFor="prop-width">宽度</label>
            <input className="dialog-input" id="prop-width" data-audit-id="prop.width" type="number" defaultValue={360} />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label" htmlFor="prop-align">对齐</label>
            <select className="dialog-input" id="prop-align" data-audit-id="prop.align" defaultValue="left">
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
            </select>
          </div>
          <div className="dialog-actions">
            <button type="button" className="dialog-primary" data-audit-id="inspector.apply">应用</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

// 同步渲染：并发模式下 render 可能被推迟到调度器里，探针会读到空内容。
const root = createRoot(document.getElementById("root")!);
flushSync(() => {
  root.render(<Workbench />);
});

(window as unknown as Record<string, unknown>).__auditSelectionLog = selectionLog;
document.body.dataset.auditReady = "1";
