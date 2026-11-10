import { useEffect, useState } from "react";
import { PROVIDER_PRESETS, capabilityLabels, capabilitySourceLabel, describeProvider } from "@ufira/ai-orchestrator";
import { maskApiKey, MAX_AI_MAX_TOKENS, MAX_AI_TIMEOUT_MS, MIN_AI_MAX_TOKENS, MIN_AI_TIMEOUT_MS, clampMaxTokens, clampThinkingMode, clampTimeoutMs, type AiSettings } from "./ai-settings";
import { clearStoredVault, hasStoredVault, openKeyRing, readStoredVault, sealKeyRing } from "./ai-key-vault";

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
  // 落盘（加密）的口令与状态。
  const [passphrase, setPassphrase] = useState("");
  const [vaultStored, setVaultStored] = useState(() => hasStoredVault());
  const [vaultNote, setVaultNote] = useState("");
  const [vaultBusy, setVaultBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const update = (patch: Partial<AiSettings>) => setDraft(current => ({ ...current, ...patch }));
  // 只在这个会话里配过密钥才提示会失效；本地免鉴权网关不需要吓用户。
  const keyInSession = settings.apiKeys.length > 0;
  const provider = describeProvider(draft.baseUrl);
  const featuredProviders = PROVIDER_PRESETS.filter(item => ["minimax", "deepseek"].includes(item.id));
  const selectProvider = (id: string) => {
    const preset = PROVIDER_PRESETS.find(item => item.id === id);
    if (preset) update({ enabled: true, baseUrl: preset.baseUrl, model: preset.defaultModel });
  };
  const saveEnabled = (value: AiSettings) => onSave({ ...value, enabled: true });

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

  /**
   * 把当前密钥环加密后落盘。
   *
   * 磁盘上只留密文；口令不落盘，也不进任何文档——关掉标签页后要重新输口令才能用。
   *
   * 顺带把这把密钥环应用到当前会话：用户加完密钥点「加密保存」，期待的是
   * 「这会儿就能用了」，而不是还要再点一次「保存设置」。
   */
  const sealToDisk = async () => {
    setVaultBusy(true);
    try {
      await sealKeyRing({ keys: draft.apiKeys, activeIndex: draft.activeKeyIndex }, passphrase);
      saveEnabled(draft);
      setVaultStored(true);
      setVaultNote("已加密保存到本机磁盘。下次开标签页时用同一个口令解锁。");
      setPassphrase("");
    } catch (error) {
      setVaultNote(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setVaultBusy(false);
    }
  };

  /** 用口令解开磁盘上的密文，把密钥并入会话。 */
  const unlockFromDisk = async () => {
    setVaultBusy(true);
    try {
      const vault = readStoredVault();
      if (!vault) {
        setVaultNote("磁盘上没有保存过密钥。");
        return;
      }
      const ring = await openKeyRing(vault, passphrase);
      if (!ring) {
        setVaultNote("口令不对（或密文已损坏）。");
        return;
      }
      saveEnabled({ ...draft, apiKeys: ring.keys, activeKeyIndex: ring.activeIndex });
      setVaultNote(`已解锁，载入 ${ring.keys.length} 把密钥。`);
      setPassphrase("");
    } finally {
      setVaultBusy(false);
    }
  };

  /** 删掉磁盘上的密文。 */
  const removeFromDisk = () => {
    clearStoredVault();
    setVaultStored(false);
    setVaultNote("磁盘上的密文已删除。");
  };

  return (
    <div className="ai-settings">
      <h2>AI 模型</h2>
      <p className="ai-settings-status">{active
        ? `当前规划器：真实模型 ${settings.model} @ ${settings.baseUrl}`
        : "当前规划器：演示规划器（未配置真实模型，需求不会被理解）"}</p>
      <div className="field ai-provider-featured">
        <span className="field-label">选择模型服务</span>
        <div className="ai-provider-cards" role="group" aria-label="推荐模型服务">
          {featuredProviders.map(preset => {
            const selected = provider.matched && provider.id === preset.id;
            const verified = describeProvider(preset.baseUrl).verified;
            return (
              <button
                key={preset.id}
                type="button"
                className={`ai-provider-card${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => selectProvider(preset.id)}
              >
                <span className="ai-provider-card-mark">{preset.id === "minimax" ? "M" : "D"}</span>
                <span className="ai-provider-card-copy">
                  <strong>{preset.label}</strong>
                  <small>{preset.defaultModel}</small>
                </span>
                <span className={`ai-provider-card-badge${verified ? " is-verified" : ""}`}>{verified ? "已实测" : "兼容"}</span>
              </button>
            );
          })}
        </div>
      </div>
      <label className="field">
        <span className="field-label">服务地址</span>
        <input type="text" value={draft.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => update({ baseUrl: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">其他服务 / 接入点</span>
        <select
          value={provider.matched ? provider.id : ""}
          onChange={event => {
            selectProvider(event.target.value);
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
      <label className="field">
        <span className="field-label">请求超时（秒）</span>
        <input
          type="number"
          min={Math.floor(MIN_AI_TIMEOUT_MS / 1000)}
          max={Math.floor(MAX_AI_TIMEOUT_MS / 1000)}
          value={Math.round(draft.timeoutMs / 1000)}
          onChange={event => update({ timeoutMs: clampTimeoutMs(Number(event.target.value) * 1000) })}
        />
        <p className="ai-settings-hint">
          带推理的模型出一份整页计划常要两三分钟，超时给短了会中途掐断；
          调长不会让快端点变慢，只是不再提前放弃。
        </p>
      </label>
      <label className="field">
        <span className="field-label">回复 token 上限</span>
        <input
          type="number"
          min={MIN_AI_MAX_TOKENS}
          max={MAX_AI_MAX_TOKENS}
          step={1024}
          value={draft.maxTokens}
          onChange={event => update({ maxTokens: clampMaxTokens(Number(event.target.value)) })}
        />
        <p className="ai-settings-hint">
          一整页计划本身就要上万 token（每条 node.create 都带完整节点对象），推理模型还要再烧一截在思考上。
          给小了回复会被截断在半个 JSON 上，看起来就像「模型不会设计」。
        </p>
      </label>
      <label className="field">
        <span className="field-label">让模型先思考</span>
        <select
          value={draft.thinkingMode}
          onChange={event => update({ thinkingMode: clampThinkingMode(event.target.value) })}
        >
          <option value="auto">跟随端点默认（多数推理模型会思考）</option>
          <option value="off">关闭思考（快很多，适合整页计划）</option>
        </select>
        <p className="ai-settings-hint">
          带推理的模型思考本身就要吃掉大量 token 与时间：实测 MiniMax-M3 出一份整页计划，
          思考开着 338 秒还没写完 JSON，关掉之后 12 秒写完。
          强制推理的模型（如 M3.1-Flash）会拒绝关闭，遇到报错就改回「跟随端点默认」。
        </p>
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
        <button disabled={disabled} onClick={() => saveEnabled(draft)}>保存并启用</button>
        <button disabled={disabled} onClick={onClear}>清除</button>
      </div>
      <div className="field">
        <span className="field-label">密钥落盘（口令加密）</span>
        <p className="ai-settings-hint">
          默认只存在当前标签页的会话存储里，关掉即失效。落盘后磁盘上只有 AES-GCM 密文，
          口令不保存——换设备时用同一个口令解锁即可。
        </p>
        <div className="ai-key-add">
          <input
            type="password"
            aria-label="落盘口令"
            value={passphrase}
            placeholder="设置一个落盘口令"
            autoComplete="off"
            onChange={event => setPassphrase(event.target.value)}
          />
          <button type="button" disabled={disabled || vaultBusy || !passphrase.trim() || draft.apiKeys.length === 0} onClick={() => void sealToDisk()}>加密保存</button>
          <button type="button" disabled={disabled || vaultBusy || !passphrase.trim() || !vaultStored} onClick={() => void unlockFromDisk()}>解锁载入</button>
          {vaultStored && <button type="button" disabled={disabled || vaultBusy} onClick={removeFromDisk}>删除密文</button>}
        </div>
        {vaultNote && <p className="ai-settings-hint" aria-live="polite">{vaultNote}</p>}
      </div>
      <p className="ai-settings-hint">API Key 默认只保存在当前标签页的会话存储里，关闭标签页即失效；不会写入设计文档、事务日志或导出文件。地址和模型名会记住，下次只需重新填密钥。</p>
      <p className="ai-settings-hint">密钥可以放多把：鉴权失败（401/403）时会自动换下一把重试；「轮换」按钮是手动切到下一把。</p>
      {keyInSession && <p className="ai-settings-hint">本次会话已配置 {settings.apiKeys.length} 把密钥，关闭标签页后需要重新输入。</p>}
    </div>
  );
}
