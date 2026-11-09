import { LINT_RULE_TITLES, lintSummary, type LintIssue } from "@ufira/design-schema";

export interface LintPanelProps {
  issues: LintIssue[];
  disabled?: boolean;
  /** 点击一行选中对应节点。 */
  onSelect(nodeId: string): void;
}

/**
 * 设计检查面板。
 *
 * 只做提示：不阻止保存、不进事务、不改文档。每条结论都带节点 id，
 * 点一下就能定位——否则「有 37 个硬编码颜色」这种提示没法用。
 */
export function LintPanel({ issues, disabled, onSelect }: LintPanelProps) {
  const summary = lintSummary(issues);
  if (!issues.length) {
    return <p className="empty-hint">没有发现问题。栅格、token 绑定与命名都符合当前规则。</p>;
  }
  return (
    <div className="lint-panel">
      <div className="lint-summary">
        <span className="lint-count lint-warning">{summary.warnings} 警告</span>
        <span className="lint-count">{summary.infos} 提示</span>
      </div>
      <div className="lint-list">
        {issues.map(issue => (
          <button
            key={`${issue.code}-${issue.nodeId ?? "doc"}-${issue.detail ?? ""}`}
            type="button"
            className={`lint-row lint-${issue.severity}`}
            disabled={disabled || !issue.nodeId}
            onClick={() => { if (issue.nodeId) onSelect(issue.nodeId); }}
            title={issue.detail}
          >
            <span className="lint-rule">{LINT_RULE_TITLES[issue.code] ?? issue.code}</span>
            <span className="lint-message">{issue.message}</span>
            {issue.detail ? <span className="lint-detail">{issue.detail}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
