import type { TransactionEntry } from "@ufira/design-runtime";
import { canRestoreRevision } from "@ufira/studio-application";

/**
 * 操作历史面板的展示层。
 *
 * 事务日志里存的是命令数组，直接显示 `node.create` 这种类型名对用户没有意义，
 * 所以这里把命令翻译成一句话，并标出哪些版本还能回退。
 */

export interface HistoryRow {
  revision: number;
  label: string;
  committedAt: string;
  /** 这次事务做了什么，例如 "新建节点 ×2、修改文本"。 */
  summary: string;
  /** 还原类事务单独标出来，避免和普通编辑混在一起。 */
  kind: "edit" | "restore";
  actor: string;
  /** 已经是最新版本、或者早于保留快照时没有可回退的基线。 */
  restorable: boolean;
  /** 是不是当前正在使用的版本。 */
  current: boolean;
}

const COMMAND_LABELS: Record<string, string> = {
  "document.rename": "重命名项目",
  "node.create": "新建节点",
  "node.patch": "修改节点",
  "text.patch": "修改文本",
  "node.delete": "删除节点",
  "node.reparent": "调整层级",
  "asset.upsert": "登记图片",
  "asset.delete": "清理图片",
  "image.patch": "修改图片",
  "token.upsert": "修改 Token",
  "token.delete": "删除 Token",
  "page.create": "新建页面",
  "page.rename": "重命名页面",
  "page.delete": "删除页面",
  "component.define": "定义组件",
  "component.create": "创建组件",
  "component.remove": "删除组件",
  "component.instantiate": "实例化组件",
  "history.restore": "还原历史",
};

const ACTOR_LABELS: Record<string, string> = { human: "本地用户", ai: "AI", integration: "外部集成" };

/** 把一组命令翻译成一句人话；同名命令合并计数，最多列三种。 */
export function commandSummary(commands: Array<{ type: string }>): string {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const label = COMMAND_LABELS[command.type] ?? command.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!counts.size) return "空事务";
  const parts = [...counts.entries()].map(([label, count]) => count > 1 ? `${label} ×${count}` : label);
  return parts.length <= 3 ? parts.join("、") : `${parts.slice(0, 3).join("、")} 等 ${parts.length} 项`;
}

export interface HistoryRowOptions {
  limit?: number;
  /**
   * 可以当重放起点的版本号：保留的历史版本 + 重建基线。
   *
   * 回退要一份"不晚于目标版本"的起点，加上从起点到目标之间完整的事务日志，
   * 两者缺一不可。所以这里按真实可达性判断，而不是简单比大小——日志被裁过的
   * 那一段没有日志，回退按钮就不该出现。
   */
  baseRevisions?: number[];
}

/** 事务日志 → 面板行；按 revision 从新到旧，只取最近 `options.limit` 条。 */
export function historyRows(entries: TransactionEntry[], currentRevision: number, options: HistoryRowOptions = {}): HistoryRow[] {
  const limit = options.limit ?? 20;
  const journalRevisions = entries.map(entry => entry.revision);
  return [...entries]
    .sort((left, right) => right.revision - left.revision)
    .slice(0, Math.max(0, limit))
    .map(entry => ({
      revision: entry.revision,
      label: `r${entry.revision}`,
      committedAt: entry.committedAt,
      summary: commandSummary(entry.commands),
      kind: entry.commands.some(command => command.type === "history.restore") ? "restore" : "edit",
      actor: ACTOR_LABELS[entry.actor.type] ?? entry.actor.id,
      restorable: entry.revision < currentRevision
        && (options.baseRevisions === undefined || canRestoreRevision(entry.revision, options.baseRevisions, journalRevisions)),
      current: entry.revision === currentRevision,
    }));
}
