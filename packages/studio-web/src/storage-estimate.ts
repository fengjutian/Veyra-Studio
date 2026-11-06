import { formatBytes } from "./asset-relink";

/**
 * 存储用量估算。
 *
 * `navigator.storage.estimate()` 给的是整个源（origin）的用量，不是单个项目的
 * 大小，所以界面文案必须说清楚"这是浏览器分配给本站的额度"，否则用户会以为
 * 是当前项目的体积。
 */

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export type StorageLevel = "normal" | "warning" | "critical";

/** 已用百分比，四舍五入到整数；额度未知时返回 0。 */
export function storagePercent(estimate: StorageEstimate): number {
  if (!Number.isFinite(estimate.quota) || estimate.quota <= 0) return 0;
  const ratio = (estimate.usage / estimate.quota) * 100;
  return Math.min(100, Math.max(0, Math.round(ratio)));
}

/** 70% 提醒、90% 告警；阈值放在这里，面板和状态提示共用一套口径。 */
export function storageLevel(percent: number): StorageLevel {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}

/** 一行可读的用量摘要，例如 "12.3 MB / 2.0 GB（1%）"。 */
export function storageSummary(estimate: StorageEstimate): string {
  return `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}（${storagePercent(estimate)}%）`;
}

/** 按告警级别给一句下一步建议。 */
export function storageAdvice(level: StorageLevel): string {
  if (level === "critical") return "存储快满了：先导出项目 JSON 备份，再删除不再需要的旧项目。";
  if (level === "warning") return "存储用量偏高：可以清理旧项目，或导出 JSON 后删掉本地副本。";
  return "存储空间充足。改动会自动保存，重要项目建议另外导出 JSON 备份。";
}

/**
 * 读取浏览器的存储估算。
 *
 * 不是所有环境都支持（隐私模式、旧浏览器、node 测试环境），拿不到就返回
 * undefined，界面显示"无法获取"而不是报错。
 */
export async function readStorageEstimate(): Promise<StorageEstimate | undefined> {
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } } }).navigator?.storage;
  if (!storage?.estimate) return undefined;
  try {
    const estimate = await storage.estimate();
    if (typeof estimate.quota !== "number" || estimate.quota <= 0) return undefined;
    return { usage: Math.max(0, estimate.usage ?? 0), quota: estimate.quota };
  } catch {
    return undefined;
  }
}
