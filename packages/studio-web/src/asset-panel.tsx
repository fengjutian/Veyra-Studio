import type { AssetMetadata } from "@ufira/design-schema";
import type { AssetUsage } from "@ufira/studio-application";
import { assetLabel, formatBytes } from "./asset-relink";
import { Icon } from "./icons";
import { Tooltip } from "./ui/tooltip";

export interface AssetPanelProps {
  usage: AssetUsage[];
  /** 仓库里读不到字节的资源 id。 */
  missingIds: Set<string>;
  disabled?: boolean;
  onRelink(asset: AssetMetadata): void;
  onDelete(asset: AssetMetadata): void;
}

/**
 * 图片资源面板。
 *
 * 只做三件用户能看懂的事：这份资源有多大、被几个图片节点引用、要不要补文件或
 * 清理掉。资源缺失时给出「重新关联」，未引用时给出「清理」，两者不会同时出现。
 */
export function AssetPanel({ usage, missingIds, disabled, onRelink, onDelete }: AssetPanelProps) {
  if (!usage.length) return <p className="empty-hint">还没有图片资源。用左侧「图片」按钮插入一张。</p>;
  const rows = [...usage].sort((left, right) => assetLabel(left.asset).localeCompare(assetLabel(right.asset)));
  return (
    <div className="asset-list">
      {rows.map(({ asset, nodeIds }) => {
        const missing = missingIds.has(asset.id);
        return (
          <div className={missing ? "asset-row asset-missing" : "asset-row"} key={asset.id}>
            <span className="asset-name" title={`${assetLabel(asset)} · ${asset.mimeType}`}>{assetLabel(asset)}</span>
            <span className="asset-meta">{formatBytes(asset.byteLength)}</span>
            <span className="asset-refs">{nodeIds.length ? `引用 ${nodeIds.length}` : "未引用"}</span>
            {missing && (
              <Tooltip label="选择这张图的原文件，把字节补回项目">
                <button disabled={disabled} onClick={() => onRelink(asset)}><Icon name="import" />重新关联</button>
              </Tooltip>
            )}
            {!nodeIds.length && (
              <Tooltip label="清理没有被引用的资源元数据">
                <button className="icon-only" aria-label={`清理资源 ${assetLabel(asset)}`} disabled={disabled} onClick={() => onDelete(asset)}><Icon name="trash" /></button>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
}
