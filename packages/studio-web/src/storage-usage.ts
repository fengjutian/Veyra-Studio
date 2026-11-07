import type { ProjectStorageUsage } from "@ufira/design-persistence";

/**
 * 按项目统计存储占用，并给出可执行的清理引导。
 *
 * 浏览器只告诉"整个站点用了多少"，用户真正想知道的是"哪个项目占了最多"和
 * "删掉它能回收多少"。这里把仓库给出的逐项目字节数整理成面板能直接渲染的
 * 行，并按可回收空间排出一份清理清单。
 *
 * 全部是纯函数，方便单测；真正的删除动作由调用方执行。
 */

/** 面板上一行：一个项目占了多少、其中多少是可以回收的。 */
export interface StorageUsageRow {
  projectId: string;
  projectName: string;
  /** 当前打开的项目排在最前。 */
  current: boolean;
  totalBytes: number;
  snapshotBytes: number;
  journalBytes: number;
  assetBytes: number;
  /** 保留的历史版本份数。 */
  historyCount: number;
  /** 历史版本之外、还能再裁掉多少份。 */
  reclaimableHistory: number;
  /** 裁掉这些历史版本大约能回收多少字节。 */
  reclaimableBytes: number;
  /** 资源份数。 */
  assetCount: number;
}

/** 清理清单里的一条建议。 */
export interface StorageCleanupSuggestion {
  id: string;
  projectId: string;
  projectName: string;
  /** 面向用户的一句话。 */
  label: string;
  /** 大约能回收多少字节。 */
  reclaimableBytes: number;
  /** 这条建议对应什么动作。 */
  action: "trim-history" | "delete-project";
}

/** 面板顶部的汇总。 */
export interface StorageUsageOverview {
  rows: StorageUsageRow[];
  /** 所有项目加起来大约占多少。 */
  totalBytes: number;
  /** 当前项目占多少。 */
  currentBytes: number;
  /** 清理清单，按可回收空间从多到少。 */
  suggestions: StorageCleanupSuggestion[];
  /** 全部建议加起来大约能回收多少。 */
  reclaimableBytes: number;
}

/**
 * 默认保留的历史版本份数。
 *
 * 留 3 份：当前版本 + 两个可以退回去的更早版本。操作历史面板靠这份基线做
 * 事务级回退，砍到 1 份会让"退回到任意一步"退化成"只能退到最新"。
 */
export const DEFAULT_HISTORY_KEEP = 3;

/**
 * 把逐项目用量整理成面板要显示的行。
 *
 * 当前项目排在最前，其余按占用从大到小——用户要清理的时候，先看的就是最大的。
 */
export function storageUsageRows(usages: ProjectStorageUsage[], options: { currentProjectId?: string; historyKeep?: number } = {}): StorageUsageRow[] {
  const historyKeep = options.historyKeep ?? DEFAULT_HISTORY_KEEP;
  return usages
    .map(usage => {
      // 当前版本占一份，历史版本里还能再砍掉 historyKeep - 1 份。
      const reclaimableHistory = Math.max(0, usage.historyCount - Math.max(0, historyKeep - 1));
      // 单份快照的大小按平均值估：总字节除以总份数，避免把字节全算在某一类上。
      const perSnapshot = usage.historyCount > 0 ? usage.snapshotBytes / (usage.historyCount + 1) : 0;
      return {
        projectId: usage.projectId,
        projectName: usage.projectName || usage.projectId,
        current: usage.projectId === options.currentProjectId,
        totalBytes: usage.totalBytes,
        snapshotBytes: usage.snapshotBytes,
        journalBytes: usage.journalBytes,
        assetBytes: usage.assetBytes,
        historyCount: usage.historyCount,
        reclaimableHistory,
        reclaimableBytes: Math.round(reclaimableHistory * perSnapshot),
        assetCount: usage.assetCount,
      };
    })
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      return right.totalBytes - left.totalBytes;
    });
}

/**
 * 生成清理引导清单。
 *
 * 只给"删掉不会丢当前内容"的建议：裁历史版本、删掉不再打开的旧项目。
 * 资源字节不单独提——清理由资源面板负责，这里重复一遍只会让用户多点一次。
 */
export function storageCleanupSuggestions(rows: StorageUsageRow[]): StorageCleanupSuggestion[] {
  const suggestions: StorageCleanupSuggestion[] = [];
  for (const row of rows) {
    if (row.reclaimableHistory > 0) {
      suggestions.push({
        id: `trim:${row.projectId}`,
        projectId: row.projectId,
        projectName: row.projectName,
        label: `「${row.projectName}」保留最近 ${row.historyCount + 1 - row.reclaimableHistory} 份版本，可回收约 ${formatReclaim(row.reclaimableBytes)}`,
        reclaimableBytes: row.reclaimableBytes,
        action: "trim-history",
      });
    }
  }
  const others = rows.filter(row => !row.current).sort((left, right) => right.totalBytes - left.totalBytes);
  const largest = others[0];
  if (largest && largest.totalBytes > 0) {
    suggestions.push({
      id: `delete:${largest.projectId}`,
      projectId: largest.projectId,
      projectName: largest.projectName,
      label: `「${largest.projectName}」占约 ${formatReclaim(largest.totalBytes)}，导出 JSON 后可以整个删掉`,
      reclaimableBytes: largest.totalBytes,
      action: "delete-project",
    });
  }
  return suggestions.sort((left, right) => right.reclaimableBytes - left.reclaimableBytes);
}

/**
 * 汇总面板要显示的全部内容。
 */
export function storageUsageOverview(
  usages: ProjectStorageUsage[],
  options: { currentProjectId?: string; historyKeep?: number } = {},
): StorageUsageOverview {
  const rows = storageUsageRows(usages, options);
  const suggestions = storageCleanupSuggestions(rows);
  return {
    rows,
    totalBytes: rows.reduce((sum, row) => sum + row.totalBytes, 0),
    currentBytes: rows.find(row => row.current)?.totalBytes ?? 0,
    suggestions,
    reclaimableBytes: suggestions.reduce((sum, suggestion) => sum + suggestion.reclaimableBytes, 0),
  };
}

/** 回收量的一句话摘要。字节数是估算，所以用"约"。 */
export function formatReclaim(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
