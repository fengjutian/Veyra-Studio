import type { DesignCommand } from "@ufira/design-runtime";
import type { DesignDocument, NodeId } from "@ufira/design-schema";

/**
 * AI 计划的结构审查（Reviewer）。
 *
 * dry-run 只能证明"这些命令能跑通"，证明不了"模型给出的改动是合理的"。审查层
 * 在确认之前再看一遍语义：
 *
 * - 不该被 AI 碰的东西（锁定节点、整篇还原、删除页面）直接阻断；
 * - 高风险但不一定错的（大批量删除、大量新建、硬编码颜色）给出警告，用户仍可确认；
 * - 每条结论都带节点 id，界面上可以定位。
 *
 * 审查不做领域校验——那是运行时的职责；这里只看"改动的形状"。
 */

export type ReviewSeverity = "info" | "warning" | "blocking";

export interface ReviewFinding {
  code: string;
  severity: ReviewSeverity;
  message: string;
  nodeIds?: NodeId[];
}

export interface ReviewResult {
  findings: ReviewFinding[];
  /** 有任何 blocking 结论时为 true；确认入口会拒绝提交。 */
  blocking: boolean;
}

export interface ReviewInput {
  before: DesignDocument;
  after: DesignDocument;
  commands: DesignCommand[];
}

/** 一次改动里被删除的节点（含子树），用 before 与 after 的节点集合求差。 */
export function removedNodeIds(before: DesignDocument, after: DesignDocument): NodeId[] {
  return Object.keys(before.nodes).filter(id => !after.nodes[id]);
}

/** 审查一份已经 dry-run 过的 AI 计划。 */
export function reviewAiPlan({ before, after, commands }: ReviewInput): ReviewResult {
  const findings: ReviewFinding[] = [];
  const removed = removedNodeIds(before, after);

  // 1. 锁定节点：用户明确表达过"别动它"，AI 不得绕过。
  const lockedRemoved = removed.filter(id => before.nodes[id]?.locked);
  if (lockedRemoved.length) {
    findings.push({
      code: "locked-node-deleted",
      severity: "blocking",
      message: `计划会删除 ${lockedRemoved.length} 个锁定节点；锁定是用户的明确意图，AI 不能删除`,
      nodeIds: lockedRemoved,
    });
  }

  // 2. 整篇还原会覆盖用户此后的所有改动，AI 计划不应该带这个能力。
  const restores = commands.filter(command => command.type === "history.restore").length;
  if (restores) {
    findings.push({
      code: "history-restore",
      severity: "blocking",
      message: `计划包含 ${restores} 条整篇还原（history.restore），AI 不能用它覆盖人类改动`,
    });
  }

  // 3. 删除页面是结构性操作，误删的代价很高。
  const pageDeletes = commands.filter(command => command.type === "page.delete").length;
  if (pageDeletes) {
    findings.push({ code: "page-delete", severity: "blocking", message: `计划会删除 ${pageDeletes} 个页面` });
  }

  // 4. 大批量删除：可能是"重做布局"，也可能是模型失控，交给用户判断。
  if (removed.length > 10 && !lockedRemoved.length) {
    findings.push({
      code: "bulk-delete",
      severity: "warning",
      message: `计划会删除 ${removed.length} 个节点，请确认这是有意的改动`,
      nodeIds: removed.slice(0, 10),
    });
  }

  // 5. 大量新建同样值得提醒：一次生成几十个图层通常是失控的信号。
  const created = Object.keys(after.nodes).filter(id => !before.nodes[id]);
  if (created.length > 20) {
    findings.push({
      code: "bulk-create",
      severity: "warning",
      message: `计划会新建 ${created.length} 个节点，改动范围偏大`,
      nodeIds: created.slice(0, 10),
    });
  }

  // 6. 硬编码颜色：和运行时 warning 同一条设计规范，但这是"可改进"而非"错误"。
  const touched = new Set<NodeId>([...created, ...removed]);
  for (const command of commands) {
    if (command.type === "node.patch" || command.type === "node.create") {
      touched.add(command.type === "node.patch" ? command.payload.id : command.payload.node.id);
    }
  }
  const hardcoded = [...touched]
    .filter(id => after.nodes[id])
    .filter(id => {
      const node = after.nodes[id]!;
      return Boolean(node.appearance.fill?.startsWith("#")) && !node.bindings?.fill;
    });
  if (hardcoded.length) {
    findings.push({
      code: "hardcoded-fill",
      severity: "warning",
      message: `${hardcoded.length} 个节点使用了硬编码填充色，建议绑定颜色 token`,
      nodeIds: hardcoded.slice(0, 10),
    });
  }

  return { findings, blocking: findings.some(finding => finding.severity === "blocking") };
}
