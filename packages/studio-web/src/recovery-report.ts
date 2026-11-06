import type { AssetMetadata, DesignDocument } from "@ufira/design-schema";
import { safeFilename } from "./file-name";

/**
 * 恢复报告：项目从存储里恢复出来之后，"恢复到了哪一步"的可读记录。
 *
 * 恢复过程本身有数据（重放了几条事务、是不是降级、文档格式升没升级），但
 * 这些数据以前只出现在一句状态提示里。报告把它们固定下来，还能导出成文件，
 * 便于用户核对或反馈问题。
 */
export interface RecoveryReport {
  projectId: string;
  projectName: string;
  generatedAt: string;
  /** 当前文档格式版本。 */
  documentSchemaVersion: number;
  /** 恢复所依据的快照修订号。 */
  recoveredFromRevision: number;
  /** 从快照之后重放的已提交事务条数。 */
  replayedTransactions: number;
  /** 存储里已知的最新修订号。 */
  latestKnownRevision: number;
  /** 没能追到最新修订时为 true。 */
  degraded: boolean;
  /** 存储里的文档原本的格式版本；被迁移过才有。 */
  migratedFrom?: number;
  /** 文档引用了、但存储里读不到字节的图片资源。 */
  missingAssets?: AssetMetadata[];
}

export interface RecoveryReportInput {
  projectId: string;
  projectName: string;
  document: DesignDocument;
  recoveredFromRevision: number;
  replayedTransactions: number;
  latestKnownRevision: number;
  degraded: boolean;
  migratedFrom?: number;
  missingAssets?: AssetMetadata[];
  generatedAt?: string;
}

export function buildRecoveryReport(input: RecoveryReportInput): RecoveryReport {
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    documentSchemaVersion: input.document.schemaVersion,
    recoveredFromRevision: input.recoveredFromRevision,
    replayedTransactions: input.replayedTransactions,
    latestKnownRevision: input.latestKnownRevision,
    degraded: input.degraded,
    migratedFrom: input.migratedFrom,
    missingAssets: input.missingAssets,
  };
}

export interface RecoveryReportRow {
  label: string;
  value: string;
  tone?: "normal" | "warning";
}

/** 把报告转成界面上一行行能直接显示的内容。 */
export function recoveryReportRows(report: RecoveryReport): RecoveryReportRow[] {
  const rows: RecoveryReportRow[] = [
    { label: "恢复自修订", value: `r${report.recoveredFromRevision}` },
    { label: "重放事务", value: `${report.replayedTransactions} 条` },
    { label: "最新已知修订", value: `r${report.latestKnownRevision}` },
    {
      label: "文档格式版本",
      value: report.migratedFrom !== undefined
        ? `v${report.documentSchemaVersion}（由 v${report.migratedFrom} 升级）`
        : `v${report.documentSchemaVersion}`,
    },
  ];
  rows.push(report.degraded
    ? { label: "恢复状态", value: "降级恢复：未追到最新修订", tone: "warning" }
    : { label: "恢复状态", value: "正常" });
  // 图片资源缺失不是恢复失败，但会直接表现为画布上的空框，必须单独说出来。
  if (report.missingAssets?.length) {
    rows.push({
      label: "图片资源",
      value: `${report.missingAssets.length} 个缺失：${assetNames(report.missingAssets)}`,
      tone: "warning",
    });
  }
  return rows;
}

/** 资源名列表，最多列三个，其余用数量概括。 */
export function assetNames(assets: AssetMetadata[]): string {
  const names = assets.map(asset => asset.name ?? asset.id);
  return names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} 等`;
}

/** 导入或打开项目后，把缺失资源的后果讲清楚：画布上是空框，不是没有图片节点。 */
export function missingAssetNotice(assets: AssetMetadata[]): string {
  if (!assets.length) return "";
  return `；${assets.length} 个图片资源缺失（${assetNames(assets)}），画布上显示为空框，请重新添加图片`;
}

export function recoveryReportFileName(name: string): string {
  return `${safeFilename(name)}-恢复报告.json`;
}
