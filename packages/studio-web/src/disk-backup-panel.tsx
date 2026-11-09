import type { DiskBackupStatus } from "./disk-backup";

export interface DiskBackupPanelProps {
  /** 当前浏览器是否支持选择目录（File System Access API）。 */
  supported: boolean;
  /** 已经接上的目录名；未启用时为 undefined。 */
  directoryName?: string;
  status: DiskBackupStatus;
  disabled?: boolean;
  onEnable(): void;
  onDisable(): void;
  onBackupNow(): void;
}

/**
 * 磁盘备份面板。
 *
 * 界面只回答三个问题：备份到哪、上次什么时候写的、现在能不能立刻写一份。
 * 不支持的环境明确说明原因，并指向「导出 JSON 备份」这条退路。
 */
export function DiskBackupPanel({ supported, directoryName, status, disabled, onEnable, onDisable, onBackupNow }: DiskBackupPanelProps) {
  if (!supported) {
    return (
      <p className="empty-hint">
        当前浏览器不支持选择备份目录（需要 Chromium 系的 File System Access API）。
        可以用上面的「导出 JSON 备份」手动保存。
      </p>
    );
  }

  if (!directoryName) {
    return (
      <div className="disk-backup-panel">
        <p className="empty-hint">
          自动保存只落在浏览器存储里，清空站点数据就会一起消失。
          选一个本地目录，编辑器会按节流把完整文档另存成 JSON（保留最近 10 份）。
        </p>
        <div className="storage-actions">
          <button disabled={disabled} onClick={onEnable}>选择备份目录</button>
        </div>
      </div>
    );
  }

  return (
    <div className="disk-backup-panel">
      <div className="storage-row">
        <span className="storage-label">备份目录</span>
        <span className="storage-value">{directoryName}</span>
      </div>
      <div className="storage-row">
        <span className="storage-label">上次备份</span>
        <span className="storage-value">
          {status.lastSavedAt ? new Date(status.lastSavedAt).toLocaleString() : "还没有写过"}
        </span>
      </div>
      {status.files ? (
        <div className="storage-row">
          <span className="storage-label">保留</span>
          <span className="storage-value">{status.files} 份（最多 10 份）</span>
        </div>
      ) : null}
      {status.state === "error" ? (
        <p className="storage-advice storage-advice-critical">写入失败：{status.error}</p>
      ) : null}
      <p className="empty-hint">备份保存到所选目录，不会上传；文件是本项目完整文档的 JSON，可直接拖回来导入。</p>
      <div className="storage-actions">
        <button disabled={disabled} onClick={onBackupNow}>立即备份</button>
        <button disabled={disabled} onClick={onDisable}>断开目录</button>
      </div>
    </div>
  );
}
