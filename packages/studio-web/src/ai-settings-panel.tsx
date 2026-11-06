import { useEffect, useState } from "react";
import { PROVIDER_PRESETS, capabilityLabels, describeProvider } from "@ufira/ai-orchestrator";
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
 * 只负责收集输入和展示当前规划器；密钥怎么存由 `ai-settings` 决定——目前只落
 * sessionStorage，关掉标签页就失效。
 */
export function AiSettingsPanel({ settings, active, disabled, onSave, onClear }: AiSettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const update = (patch: Partial<AiSettings>) => setDraft(current => ({ ...current, ...patch }));
  // 只在这个会话里配过密钥才提示会失效；本地免鉴权网关不需要吓用户。
  const keyInSession = Boolean(settings.apiKey);
  const provider = describeProvider(draft.baseUrl);

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
        <span className="field-label">快速填入</span>
        <select
          value={provider.matched ? provider.id : ""}
          onChange={event => {
            const preset = PROVIDER_PRESETS.find(item => item.id === event.target.value);
            if (preset) update({ baseUrl: preset.baseUrl, model: preset.defaultModel });
          }}
        >
          <option value="">自定义</option>
          {PROVIDER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <p className={provider.matched ? "ai-provider ai-provider-known" : "ai-provider"}>
        {provider.label} · {capabilityLabels(provider.capabilities).join(" · ")}
      </p>
      <p className="ai-settings-hint">{provider.note}</p>
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
      <p className="ai-settings-hint">API Key 只保存在当前标签页的会话存储里，关闭标签页即失效；不会写入 localStorage、设计文档、事务日志或导出文件。地址和模型名会记住，下次只需重新填密钥。</p>
      {keyInSession && <p className="ai-settings-hint">本次会话已配置密钥，关闭标签页后需要重新输入。</p>}
    </div>
  );
}
