/**
 * 可访问性自动化的阴性对照页面。
 *
 * 这个页面**故意**有缺陷，用来证明检查脚本不是恒真的：
 *
 *   1. `defect.nameless`  —— 空按钮，没有可访问名（读屏只会念「按钮」）
 *   2. `defect.positive`  —— tabindex=3，会把 Tab 顺序打乱
 *   3. `defect.no-indicator` —— 可聚焦，但聚焦时没有可见的焦点指示
 *
 * 探针会断言这些缺陷**确实被报出来**。如果规则没生效（页面改了、采集断了、
 * 判定写错了），这里就会红——否则「检查通过」只是因为什么都没检查。
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "../src/styles.css";

function Defects() {
  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <strong className="brand-name">阴性对照</strong>
        </div>
        <div className="toolbar-group" role="group" aria-label="对照组">
          <button type="button" className="icon-only" data-audit-id="defect.clean" aria-label="正常按钮">正常</button>
          <button type="button" className="icon-only" data-audit-id="defect.nameless" />
          <button type="button" className="icon-only" data-audit-id="defect.positive" tabIndex={3}>提前</button>
          <div
            data-audit-id="defect.no-indicator"
            tabIndex={0}
            aria-label="没有焦点指示"
            style={{ outline: "none" }}
          >
            无指示
          </div>
        </div>
      </header>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
flushSync(() => {
  root.render(<Defects />);
});

document.body.dataset.auditReady = "1";
