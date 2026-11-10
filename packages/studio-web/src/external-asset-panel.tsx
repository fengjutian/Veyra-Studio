import type { ExternalAttributionEntry } from "@ufira/studio-application";
import type { ExternalAssetSettings } from "./external-asset-settings";

export interface ExternalAssetPanelProps {
  settings: ExternalAssetSettings;
  /** 文档里来自外部服务的素材归因清单。 */
  attributions: ExternalAttributionEntry[];
  disabled?: boolean;
  /** 移除一个服务的登记。 */
  onRemoveProvider(providerId: string): void;
  /** 退出（或重新加入）一个服务。 */
  onToggleProvider(providerId: string, disabled: boolean): void;
  /** 清掉某个服务下没被引用的缓存素材。 */
  onPurgeProvider(providerId: string): void;
  /** 从某个服务取一份素材。 */
  onPickFromProvider(providerId: string): void;
  /** 导出归因清单（Markdown）。 */
  onExportAttribution(): void;
}

/**
 * 外部素材服务面板。
 *
 * 三件事对应三个需求：
 * - **缓存**：列出每个服务缓存了多少素材、缓存是否已过期。
 * - **归因**：列出每份外部素材的作者与许可证，缺归因的标出来。
 * - **退出策略**：每个服务一个「退出」开关；退出后不再请求该服务，但已缓存的素材
 *   继续可用，并在这里标出来——退出不该让已有设计裂开。
 */
export function ExternalAssetPanel({ settings, attributions, disabled, onRemoveProvider, onToggleProvider, onPurgeProvider, onPickFromProvider, onExportAttribution }: ExternalAssetPanelProps) {
  const providers = settings.providers;
  return (
    <div className="external-asset-panel">
      <p className="field-hint">
        外部素材服务（比如图标库、图库）里的素材取回后缓存在项目里：同一个素材只取一次，服务不可达时也能继续用。
        素材的作者与许可证会跟着文档走，交付时能附上一份归因清单。
      </p>

      {providers.length === 0 ? (
        <p className="empty-hint">还没有登记外部素材服务。用下面的表单登记一个，之后就能从它取素材。</p>
      ) : (
        <div className="external-provider-list">
          {providers.map(provider => {
            const exited = settings.disabledProviders.includes(provider.id);
            const rows = attributions.filter(entry => entry.providerId === provider.id);
            const expired = rows.filter(entry => entry.expired).length;
            return (
              <div className={`external-provider-row${exited ? " external-provider-exited" : ""}`} key={provider.id}>
                <div className="external-provider-head">
                  <span className="external-provider-label" title={provider.urlTemplate}>{provider.label}</span>
                  <span className="external-provider-meta">{rows.length} 份{expired ? ` · ${expired} 份已过期` : ""}</span>
                </div>
                <div className="external-provider-actions">
                  <button disabled={disabled} onClick={() => onPickFromProvider(provider.id)}>取素材</button>
                  <button disabled={disabled} onClick={() => onToggleProvider(provider.id, !exited)}>
                    {exited ? "重新加入" : "退出该服务"}
                  </button>
                  <button disabled={disabled || rows.length === 0} onClick={() => onPurgeProvider(provider.id)}>清理缓存</button>
                  <button className="icon-only" aria-label={`移除服务 ${provider.label}`} disabled={disabled} onClick={() => onRemoveProvider(provider.id)}>移除</button>
                </div>
                {exited ? <p className="external-provider-note">已退出：不再向它发请求，已缓存的素材仍然可用。</p> : null}
              </div>
            );
          })}
        </div>
      )}

      {attributions.length > 0 ? (
        <div className="external-attribution">
          <h3 className="storage-subtitle">归因清单</h3>
          <div className="external-attribution-list">
            {attributions.map(entry => (
              <div className="external-attribution-row" key={entry.assetId}>
                <span className="external-attribution-name" title={entry.externalId}>{entry.assetName ?? entry.assetId}</span>
                <span className="external-attribution-detail">
                  {entry.author ?? "作者未登记"} · {entry.license ?? "许可证未登记"}
                </span>
                {entry.complete ? null : <span className="external-attribution-flag">缺归因</span>}
                {entry.providerDisabled ? <span className="external-attribution-flag">服务已退出</span> : null}
                {entry.expired ? <span className="external-attribution-flag">缓存已过期</span> : null}
              </div>
            ))}
          </div>
          <button disabled={disabled} onClick={onExportAttribution}>导出归因清单</button>
        </div>
      ) : null}
    </div>
  );
}
