import { useEffect, useState } from "react";
import type { AiSettings } from "./ai-settings";

export interface AiSettingsPanelProps {
  settings: AiSettings;
  /** 当前是否真的在用真实模型；否则退回演示规划器 */
  active: boolean;
  disabled?: boolean;
  onSave(settings: AiSettings): void;
  onClear(): void;
}

/**
 * AI 模型设置面板。
 *
 * 只负责收集输入和展示当前规划器，密钥落盘由调用方决定（studio-web 存 localStorage）。
 */
export function AiSettingsPanel({ settings, active, disabled, onSave, onClear }: AiSettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const update = (patch: Partial<AiSettings>) => setDraft(current => ({ ...current, ...patch }));

  return (
    <div className="ai-settings">
      <h2>AI 模型</h2>
      <p className="ai-settings-status">{active
        ? `当前规划器：真实模型 ${settings.model} @ ${settings.baseUrl}`
        : "当前规划器：演示规划器（未配置真实模型，需求不会被理解）"}</p>
      <label className="field field-inline">
        <span className="field-label">启用真实模型</span>
        <input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />
      </label>
      <label className="field">
        <span className="field-label">服务地址</span>
        <input type="text" value={draft.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => update({ baseUrl: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">模型</span>
        <input type="text" value={draft.model} placeholder="gpt-4o-mini" onChange={event => update({ model: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">API Key</span>
        <input type="password" value={draft.apiKey} placeholder="本地模型可留空" onChange={event => update({ apiKey: event.target.value })} />
      </label>
      <div className="ai-settings-actions">
        <button disabled={disabled} onClick={() => onSave(draft)}>保存设置</button>
        <button disabled={disabled} onClick={onClear}>清除</button>
      </div>
      <p className="ai-settings-hint">密钥只保存在本浏览器的 localStorage，不写入设计文档、事务日志或导出文件。</p>
    </div>
  );
}
