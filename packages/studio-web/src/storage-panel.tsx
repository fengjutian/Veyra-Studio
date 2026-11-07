import { storageAdvice, storageLevel, storagePercent, storageSummary, type StorageEstimate } from "./storage-estimate";
import { formatReclaim, type StorageUsageOverview } from "./storage-usage";

export interface StoragePanelProps {
  estimate: StorageEstimate | undefined;
  /** 逐项目占用与清理清单；仓库不支持统计时为 undefined。 */
  usage?: StorageUsageOverview;
  disabled?: boolean;
  onRefresh(): void;
  onExportBackup(): void;
  /** 裁掉某个项目多余的历史版本。 */
  onTrimHistory?(projectId: string): void;
  /** 删掉整个项目。 */
  onDeleteProject?(projectId: string): void;
}

/**
 * 存储用量面板。
 *
 * 上半部分是浏览器给本站的总额度，下半部分按项目拆开——用户真正要清理的时候，
 * 想知道的是"哪个项目占了最多"，不是"整个站点用了多少"。下面再给一份可直接
 * 执行的清理清单：裁历史版本、删掉不再打开的旧项目。
 *
 * 这里不做"自动清理"：删除项目和裁版本都会丢东西，必须由用户决定。
 */
export function StoragePanel({ estimate, usage, disabled, onRefresh, onExportBackup, onTrimHistory, onDeleteProject }: StoragePanelProps) {
  if (!estimate) {
    return (
      <div className="storage-panel">
        <p className="empty-hint">当前环境无法读取存储用量。</p>
        <button disabled={disabled} onClick={onRefresh}>重新检测</button>
      </div>
    );
  }
  const percent = storagePercent(estimate);
  const level = storageLevel(percent);
  return (
    <div className="storage-panel">
      <div className={`storage-bar storage-${level}`} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="存储用量">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="storage-row"><span className="storage-label">已用</span><span className="storage-value">{storageSummary(estimate)}</span></div>
      <p className={`storage-advice storage-advice-${level}`}>{storageAdvice(level)}</p>

      {usage && usage.rows.length > 0 ? (
        <>
          <h3 className="storage-subtitle">按项目</h3>
          <div className="storage-project-list">
            {usage.rows.map(row => (
              <div className={`storage-project${row.current ? " storage-project-current" : ""}`} key={row.projectId}>
                <div className="storage-project-head">
                  <span className="storage-project-name">{row.projectName}</span>
                  <span className="storage-project-total">{formatReclaim(row.totalBytes)}</span>
                </div>
                <div className="storage-project-breakdown">
                  <span>版本 {formatReclaim(row.snapshotBytes)}</span>
                  <span>日志 {formatReclaim(row.journalBytes)}</span>
                  <span>资源 {formatReclaim(row.assetBytes)}</span>
                  {row.historyCount > 0 ? <span>历史 {row.historyCount} 份</span> : null}
                </div>
                {row.reclaimableHistory > 0 && onTrimHistory ? (
                  <button className="storage-project-action" disabled={disabled} onClick={() => onTrimHistory(row.projectId)}>
                    裁掉 {row.reclaimableHistory} 份旧版本（回收约 {formatReclaim(row.reclaimableBytes)}）
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          {usage.suggestions.length > 0 ? (
            <>
              <h3 className="storage-subtitle">清理建议</h3>
              <ul className="storage-cleanup-list">
                {usage.suggestions.map(suggestion => (
                  <li className="storage-cleanup-item" key={suggestion.id}>
                    <span className="storage-cleanup-label">{suggestion.label}</span>
                    {suggestion.action === "trim-history" && onTrimHistory ? (
                      <button className="storage-project-action" disabled={disabled} onClick={() => onTrimHistory(suggestion.projectId)}>裁版本</button>
                    ) : null}
                    {suggestion.action === "delete-project" && onDeleteProject ? (
                      <button className="storage-project-action" disabled={disabled} onClick={() => onDeleteProject(suggestion.projectId)}>删除项目</button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}

      <div className="storage-actions">
        <button disabled={disabled} onClick={onRefresh}>刷新用量</button>
        <button disabled={disabled} onClick={onExportBackup}>导出 JSON 备份</button>
      </div>
    </div>
  );
}
