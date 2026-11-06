import { storageAdvice, storageLevel, storagePercent, storageSummary, type StorageEstimate } from "./storage-estimate";

export interface StoragePanelProps {
  estimate: StorageEstimate | undefined;
  disabled?: boolean;
  onRefresh(): void;
  onExportBackup(): void;
}

/**
 * 存储用量面板。
 *
 * 只读地展示浏览器给本站的额度用了多少，并给出两条能直接执行的出路：导出
 * JSON 备份、清理旧项目。这里不做"自动清理"，删除项目必须由用户决定。
 */
export function StoragePanel({ estimate, disabled, onRefresh, onExportBackup }: StoragePanelProps) {
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
      <div className="storage-actions">
        <button disabled={disabled} onClick={onRefresh}>刷新用量</button>
        <button disabled={disabled} onClick={onExportBackup}>导出 JSON 备份</button>
      </div>
    </div>
  );
}
