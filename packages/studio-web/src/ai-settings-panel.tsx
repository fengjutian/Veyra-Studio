import { useEffect, useState } from "react";
import { PROVIDER_PRESETS, capabilityLabels, capabilitySourceLabel, describeProvider } from "@ufira/ai-orchestrator";
import { maskApiKey, type AiSettings } from "./ai-settings";

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
 *
 * 密钥是**环**而不是一把：服务端轮换密钥时，客户端手里还有旧的那把。这里能
 * 加多把、删掉某把、手动切到下一把；自动换钥（鉴权失败时）由规划器负责，
 * 换完会回调上来，界面跟着显示当前用的是哪一把。
 */
export function AiSettingsPanel({ settings, active, disabled, onSave, onClear }: AiSettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [newKey, setNewKey] = useState("");
  useEffect(() => setDraft(settings), [settings]);
  const update = (patch: Partial<AiSettings>) => setDraft(current => ({ ...current, ...patch }));
  // 只在这个会话里配过密钥才提示会失效；本地免鉴权网关不需要吓用户。
  const keyInSession = settings.apiKeys.length > 0;
  const provider = describeProvider(draft.baseUrl);

  const addKey = () => {
    const value = newKey.trim();
    if (!value) return;
    if (draft.apiKeys.includes(value)) { setNewKey(""); return; }
    update({ apiKeys: [...draft.apiKeys, value], activeKeyIndex: draft.apiKeys.length });
    setNewKey("");
  };
  const removeKey = (key: string) => {
    const remaining = draft.apiKeys.filter(item => item !== key);
    update({ apiKeys: remaining, activeKeyIndex: Math.min(draft.activeKeyIndex, Math.max(0, remaining.length - 1)) });
  };
  const useKey = (index: number) => update({ activeKeyIndex: index });
  /** 手动轮换：切到下一把。 */
  const rotateKey = () => {
    if (draft.apiKeys.length < 2) return;
    update({ activeKeyIndex: (draft.activeKeyIndex + 1) % draft.apiKeys.length });
  };

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
        {provider.label} · {capabilityLabels(provider.capabilities).join(" · ")} · {capabilitySourceLabel(provider)}
      </p>
      <p className="ai-settings-hint">{provider.note}</p>
      {provider.verified && provider.acceptance && (
        <p className="ai-settings-hint">
          实测于 {provider.acceptance.verifiedAt}（{provider.acceptance.model}）：规划器往返与编排循环均通过。
        </p>
      )}
      <label className="field">
        <span className="field-label">模型</span>
        <input type="text" value={draft.model} placeholder="gpt-4o-mini" onChange={event => update({ model: event.target.value })} />
      </label>
      <div className="field">
        <span className="field-label">API Key（可多把，用于轮换）</span>
        {draft.apiKeys.length > 0 && (
          <ul className="ai-keyring">
            {draft.apiKeys.map((key, index) => (
              <li className={index === draft.activeKeyIndex ? "ai-key ai-key-active" : "ai-key"} key={`${key}-${index}`}>
                <code className="ai-key-masked">{maskApiKey(key)}</code>
                {index === draft.activeKeyIndex && <span className="ai-key-badge">使用中</span>}
                <button type="button" disabled={disabled || index === draft.activeKeyIndex} onClick={() => useKey(index)}>使用</button>
                <button type="button" disabled={disabled} onClick={() => removeKey(key)}>删除</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ai-key-add">
          <input type="password" value={newKey} placeholder="粘贴新的 API Key" onChange={event => setNewKey(event.target.value)} onKeyDown={event => { if (event.key === "Enter") addKey(); }} />
          <button type="button" disabled={disabled || !newKey.trim()} onClick={addKey}>添加</button>
          <button type="button" disabled={disabled || draft.apiKeys.length < 2} title="切到下一把密钥" onClick={rotateKey}>轮换</button>
        </div>
      </div>
      <div className="ai-settings-actions">
        <button disabled={disabled} onClick={() => onSave(draft)}>保存设置</button>
        <button disabled={disabled} onClick={onClear}>清除</button>
      </div>
      <p className="ai-settings-hint">API Key 只保存在当前标签页的会话存储里，关闭标签页即失效；不会写入 localStorage、设计文档、事务日志或导出文件。地址和模型名会记住，下次只需重新填密钥。</p>
      <p className="ai-settings-hint">密钥可以放多把：鉴权失败（401/403）时会自动换下一把重试；「轮换」按钮是手动切到下一把。</p>
      {keyInSession && <p className="ai-settings-hint">本次会话已配置 {settings.apiKeys.length} 把密钥，关闭标签页后需要重新输入。</p>}
    </div>
  );
}
