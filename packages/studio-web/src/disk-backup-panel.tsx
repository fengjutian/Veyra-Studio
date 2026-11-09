import { useState } from "react";
import type { DiskBackupStatus } from "./disk-backup";

export interface DiskBackupPanelProps {
  /** 当前浏览器是否支持选择目录（File System Access API）。 */
  supported: boolean;
  /** 已经接上的目录名；未启用时为 undefined。 */
  directoryName?: string;
  status: DiskBackupStatus;
  disabled?: boolean;
  /** 当前是否启用加密备份。 */
  encrypted?: boolean;
  /** 环境是否支持加密（WebCrypto）。 */
  encryptionSupported?: boolean;
  onEnable(): void;
  onDisable(): void;
  onBackupNow(): void;
  /** 开启加密：回调密码；用户取消时不调用。 */
  onEnableEncryption?(password: string): void;
  /** 关闭加密。 */
  onDisableEncryption?(): void;
}

/**
 * 磁盘备份面板。
 *
 * 界面只回答三个问题：备份到哪、上次什么时候写的、现在能不能立刻写一份。
 * 不支持的环境明确说明原因，并指向「导出 JSON 备份」这条退路。
 *
 * 加密这一块是**显式开关 + 明示风险**：密码不落盘，因此忘记密码就永久丢失，
 * 这句话必须出现在界面上，不能只写在文档里。
 */
export function DiskBackupPanel({
  supported,
  directoryName,
  status,
  disabled,
  encrypted = false,
  encryptionSupported = true,
  onEnable,
  onDisable,
  onBackupNow,
  onEnableEncryption,
  onDisableEncryption,
}: DiskBackupPanelProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string>();

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

  const submitPassword = () => {
    setLocalError(undefined);
    if (!password) {
      setLocalError("请输入密码");
      return;
    }
    if (password !== confirm) {
      setLocalError("两次输入的密码不一致");
      return;
    }
    onEnableEncryption?.(password);
    setPassword("");
    setConfirm("");
  };

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
      <p className="empty-hint">
        {encrypted
          ? "备份已加密：文件里是密文，拖回编辑器导入时需要同一个密码。"
          : "备份保存到所选目录，不会上传；文件是本项目完整文档的 JSON，可直接拖回来导入。"}
      </p>
      <div className="storage-actions">
        <button disabled={disabled} onClick={onBackupNow}>立即备份</button>
        <button disabled={disabled} onClick={onDisable}>断开目录</button>
      </div>

      <div className="storage-row">
        <span className="storage-label">加密</span>
        <span className="storage-value">{encrypted ? "已启用（AES-GCM）" : "未启用（明文 JSON）"}</span>
      </div>

      {encrypted ? (
        <>
          <p className="empty-hint">
            密码只保存在这次会话的内存里，不写入磁盘、浏览器存储或备份文件。
            <strong>忘记密码就无法再打开这些备份</strong>——没有找回通道。
            关闭加密不会改动已经写出的文件，目录里旧的明文备份仍在。
          </p>
          <div className="storage-actions">
            <button disabled={disabled} onClick={() => onDisableEncryption?.()}>关闭加密</button>
          </div>
        </>
      ) : (
        <>
          {!encryptionSupported ? (
            <p className="storage-advice storage-advice-critical">当前环境不支持加密（缺少 WebCrypto）。</p>
          ) : (
            <>
              <div className="storage-row">
                <span className="storage-label">密码</span>
                <input
                  type="password"
                  className="storage-input"
                  value={password}
                  placeholder="设置一个备份密码"
                  autoComplete="new-password"
                  onChange={event => setPassword(event.target.value)}
                />
              </div>
              <div className="storage-row">
                <span className="storage-label">确认密码</span>
                <input
                  type="password"
                  className="storage-input"
                  value={confirm}
                  placeholder="再输一次"
                  autoComplete="new-password"
                  onChange={event => setConfirm(event.target.value)}
                />
              </div>
              {localError ? <p className="storage-advice storage-advice-critical">{localError}</p> : null}
              <div className="storage-actions">
                <button disabled={disabled} onClick={submitPassword}>启用加密</button>
              </div>
              <p className="empty-hint">
                启用后新写出的备份是密文（AES-GCM，密码经 PBKDF2 派生密钥）。
                已经写出的明文备份不会被追溯加密。
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
