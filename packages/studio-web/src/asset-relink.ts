import type { AssetMetadata } from "@ufira/design-schema";

/**
 * 图片资源面板的纯逻辑。
 *
 * 面板本身只负责摆放，判断「这张图能不能重新关联」「该显示多少 KB」这类规则
 * 都留在这里，方便直接测试。
 */

/** 人类可读的文件大小；资源面板和状态提示共用一套说法。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 资源在面板上的显示名：优先用户插入时的文件名。 */
export function assetLabel(asset: AssetMetadata): string {
  return asset.name?.trim() || asset.id;
}

/**
 * 重新关联时的内容校验。
 *
 * 重新关联补的是**同一份资源的字节**，所以只接受内容哈希一致的文件：允许随便
 * 挑一张图顶替，会让文档里的资源 id 和画面对不上，撤销和导出都失去可信度。
 */
export function relinkError(asset: AssetMetadata, hash: string): string | undefined {
  if (hash === asset.hash) return undefined;
  return `这张图和「${assetLabel(asset)}」记录的内容不一致，请选择原始文件`;
}

/** 缺失资源的 id 集合，用于面板和画布上的状态判断。 */
export function missingAssetIds(assets: AssetMetadata[]): Set<string> {
  return new Set(assets.map(asset => asset.id));
}

/** 重新关联成功后的状态文案，带上这份资源恢复了多少个图片节点。 */
export function relinkSuccessMessage(asset: AssetMetadata, restoredNodes: number): string {
  return restoredNodes > 0
    ? `资源「${assetLabel(asset)}」已恢复，${restoredNodes} 个图片节点重新显示`
    : `资源「${assetLabel(asset)}」已恢复`;
}
