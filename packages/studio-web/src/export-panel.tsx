import type { ExportDiagnostic } from "@ufira/design-export";
import { diagnosticRows, diagnosticSummary, supportRows, type ExportFormat } from "./export-report";
import { Icon } from "./icons";
import { Tooltip } from "./ui/tooltip";

export interface ExportDiagnosticsPanelProps {
  format?: ExportFormat;
  diagnostics: ExportDiagnostic[];
  onSelect(nodeId: string): void;
}

/**
 * 导出诊断面板。
 *
 * 上半部分列出最近一次导出的诊断，点一行可以定位到对应节点；下半部分是支持
 * 矩阵，说明某种格式对某个特性到底是什么水平——诊断里的每一条都能在这里找到
 * 对应行，不会出现"看不懂的警告"。
 */
export function ExportDiagnosticsPanel({ format, diagnostics, onSelect }: ExportDiagnosticsPanelProps) {
  const rows = diagnosticRows(diagnostics);
  const matrix = supportRows();
  return (
    <div className="export-report">
      <p className="export-summary">{diagnosticSummary(diagnostics, format)}</p>
      {rows.length > 0 && (
        <div className="diagnostic-list">
          {rows.map(row => (
            <div className={`diagnostic-row diagnostic-${row.support}`} key={row.key}>
              <span className={`diagnostic-badge diagnostic-badge-${row.support}`}>{row.supportLabel}</span>
              <span className="diagnostic-feature">{row.label}</span>
              <span className="diagnostic-message" title={row.message}>{row.message}</span>
              {row.nodeId && (
                <Tooltip label={`选中 ${row.nodeId}`}>
                  <button className="icon-only" aria-label={`选中 ${row.nodeId}`} onClick={() => row.nodeId && onSelect(row.nodeId)}>
                    <Icon name="search" />
                  </button>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      )}
      <details className="support-matrix">
        <summary>支持矩阵（{matrix.length} 项）</summary>
        <table>
          <thead>
            <tr><th>特性</th><th>HTML</th><th>SVG</th><th>PNG</th></tr>
          </thead>
          <tbody>
            {matrix.map(row => (
              <tr key={row.feature} title={row.note}>
                <td>{row.label}</td>
                <td>{row.html}</td>
                <td>{row.svg}</td>
                <td>{row.png}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
