import type { HistoryRow } from "./history-rows";
import { formatSnapshotTime } from "./snapshot-history";
import { Icon } from "./icons";
import { Tooltip } from "./ui/tooltip";

export interface HistoryPanelProps {
  rows: HistoryRow[];
  disabled?: boolean;
  onRestore(row: HistoryRow): void;
}

/**
 * 操作历史面板。
 *
 * 和「历史版本」不同：那一栏只能回到保存过快照的几个版本，这里列出的是每一条
 * 已提交事务，可以精确退回到某一步之后的状态。
 */
export function HistoryPanel({ rows, disabled, onRestore }: HistoryPanelProps) {
  if (!rows.length) return <p className="empty-hint">还没有操作记录。每次提交都会记在这里。</p>;
  return (
    <div className="history-list">
      {rows.map(row => (
        <div className={`history-row${row.kind === "restore" ? " history-restore" : ""}`} key={row.revision}>
          <span className="history-label">{row.label}</span>
          <span className="history-summary" title={`${row.summary} · ${row.actor}`}>{row.summary}</span>
          <span className="history-time">{formatSnapshotTime(row.committedAt)}</span>
          {row.restorable
            ? (
              <Tooltip label={`把项目回退到 ${row.label} 之后的状态`}>
                <button className="icon-only" aria-label={`回退到 ${row.label}`} disabled={disabled} onClick={() => onRestore(row)}>
                  <Icon name="versionRestore" />
                </button>
              </Tooltip>
            )
            : <span className="history-current">当前</span>}
        </div>
      ))}
    </div>
  );
}
