/**
 * 设计 lint：不该阻止保存、但会让设计系统慢慢腐坏的问题。
 *
 * 与 `validateDocument()` 的分工：
 *
 * - 校验管**合法性**（引用了不存在的资源/token、环、越界值），失败必须修；
 * - lint 管**质量**（硬编码颜色、没绑 token 的间距、不在栅格上的坐标），
 *   只提示、不改文档，也不进事务。
 *
 * 规则只在「这份文档确实有对应的 token 体系」时才报告：没有任何颜色 token 的文档
 * 本来就该用字面色，报硬编码只会制造噪声。
 */

import { tokenColor, tokenNumber } from "./tokens";
import type { DesignDocument, DesignNode, NodeId } from "./types";

/** 一条 lint 结论的分类。 */
export type LintCode =
  /** 填充是硬编码颜色，没有绑定颜色 token。 */
  | "hardcoded-fill"
  /** 描边是硬编码颜色。 */
  | "hardcoded-stroke"
  /** 自动布局的间距是写死的像素，没有绑定数值 token。 */
  | "unbound-spacing"
  /** 位置或尺寸不在栅格上。 */
  | "off-grid"
  /** 同级节点重名。 */
  | "duplicate-name";

export type LintSeverity = "warning" | "info";

export interface LintIssue {
  code: LintCode;
  severity: LintSeverity;
  /** 相关节点；同级重名会给出所有相关节点的第一层路径。 */
  nodeId?: NodeId;
  message: string;
  /** 可选的补充说明（例如具体的值）。 */
  detail?: string;
}

export interface LintOptions {
  /** 栅格步长（px）；缺省 8。设成 1 等于关闭 off-grid。 */
  grid?: number;
  /** 关闭某条规则：`{ "off-grid": false }`。 */
  rules?: Partial<Record<LintCode, boolean>>;
}

const DEFAULT_GRID = 8;

/** 文档里是否有颜色/数值 token——没有就不报对应的硬编码规则。 */
function hasTokenOfType(document: DesignDocument, type: "color" | "number"): boolean {
  return Object.values(document.tokens).some(token => token.type === type);
}

/** 是否落在栅格上（浮点误差按 0.01 容忍）。 */
function onGrid(value: number, grid: number): boolean {
  if (grid <= 1) return true;
  const remainder = Math.abs(value % grid);
  return remainder < 0.01 || Math.abs(remainder - grid) < 0.01;
}

/** 判断规则是否启用。 */
function enabled(options: LintOptions, code: LintCode): boolean {
  return options.rules?.[code] !== false;
}

/**
 * 扫描一篇文档。
 *
 * 结果是稳定的：先按文档里的节点顺序，再按规则顺序，便于快照测试与面板逐行展示。
 * 不修改文档，也不依赖宿主（字体、Canvas）。
 */
export function lintDocument(document: DesignDocument, options: LintOptions = {}): LintIssue[] {
  const grid = Math.max(1, Math.trunc(options.grid ?? DEFAULT_GRID));
  const issues: LintIssue[] = [];
  const hasColorTokens = hasTokenOfType(document, "color");
  const hasNumberTokens = hasTokenOfType(document, "number");

  const visit = (nodeId: NodeId, siblings: DesignNode[], parent: DesignNode | undefined): void => {
    const node = document.nodes[nodeId];
    if (!node) return;

    // 硬编码填充：只在有颜色 token 的文档里报；渐变不算硬编码（token 只能表达单色）。
    if (enabled(options, "hardcoded-fill") && hasColorTokens && !tokenColor(document, node.bindings?.fill)) {
      const solid = (node.appearance.fills ?? []).filter(paint => paint.type === "solid");
      if (solid.length) {
        const colors = solid.map(paint => (paint as { color: string }).color).join(", ");
        issues.push({
          code: "hardcoded-fill",
          severity: "info",
          nodeId: node.id,
          message: `${node.id} 的填充是硬编码颜色`,
          detail: colors,
        });
      }
    }

    // 硬编码描边。
    if (enabled(options, "hardcoded-stroke") && hasColorTokens && !node.bindings?.stroke && node.appearance.stroke) {
      issues.push({
        code: "hardcoded-stroke",
        severity: "info",
        nodeId: node.id,
        message: `${node.id} 的描边是硬编码颜色`,
        detail: node.appearance.stroke,
      });
    }

    // 自动布局间距没绑数值 token。
    if (enabled(options, "unbound-spacing") && hasNumberTokens && node.layout.mode === "stack" && (node.layout.gap ?? 0) > 0 && !node.bindings?.spacing) {
      issues.push({
        code: "unbound-spacing",
        severity: "info",
        nodeId: node.id,
        message: `${node.id} 的自动布局间距没有绑定数值 token`,
        detail: `${node.layout.gap}px`,
      });
    }

    // 栅格：只检查**位置**，不检查宽高。尺寸常常由内容/图片决定（100px 的默认矩形
    // 也不在 8 栅格上），把尺寸算进来会淹没真正的问题——「整页都偏了 3px」。
    // stack / grid 子节点的位置由布局引擎算，报它们没有意义。
    if (enabled(options, "off-grid") && grid > 1) {
      const managed = parent ? parent.layout.mode !== "absolute" : false;
      if (!managed) {
        const values: Array<[string, number]> = [
          ["x", node.layout.x],
          ["y", node.layout.y],
        ];
        const off = values.filter(([, value]) => Number.isFinite(value) && !onGrid(value, grid));
        if (off.length) {
          issues.push({
            code: "off-grid",
            severity: "warning",
            nodeId: node.id,
            message: `${node.id} 的位置不在 ${grid}px 栅格上`,
            detail: off.map(([key, value]) => `${key}=${Math.round(value * 100) / 100}`).join(", "),
          });
        }
      }
    }

    // 同级重名：一次记一条，挂在第一个重名节点上，其余节点列在 detail 里。
    if (enabled(options, "duplicate-name")) {
      const duplicates = siblings.filter(sibling => sibling.name === node.name);
      if (duplicates.length > 1 && duplicates[0]?.id === node.id) {
        issues.push({
          code: "duplicate-name",
          severity: "info",
          nodeId: node.id,
          message: `同级有 ${duplicates.length} 个节点都叫「${node.name}」`,
          detail: duplicates.map(sibling => sibling.id).join(", "),
        });
      }
    }

    const children = node.childIds.map(id => document.nodes[id]).filter((child): child is DesignNode => Boolean(child));
    for (const childId of node.childIds) visit(childId, children, node);
  };

  // 每个页面单独处理：根节点之间互为同级，跨页不算同级（否则同名页面会互相误报）。
  for (const pageId of document.pageOrder) {
    const roots = (document.pages[pageId]?.childIds ?? [])
      .map(id => document.nodes[id])
      .filter((node): node is DesignNode => Boolean(node));
    for (const rootId of document.pages[pageId]?.childIds ?? []) visit(rootId, roots, undefined);
  }

  return issues;
}

/** 按严重程度汇总，面板用来显示角标。 */
export function lintSummary(issues: readonly LintIssue[]): { warnings: number; infos: number; total: number } {
  const warnings = issues.filter(issue => issue.severity === "warning").length;
  return { warnings, infos: issues.length - warnings, total: issues.length };
}

/** 某个规则的中文标题（面板与文档共用）。 */
export const LINT_RULE_TITLES: Record<LintCode, string> = {
  "hardcoded-fill": "硬编码填充",
  "hardcoded-stroke": "硬编码描边",
  "unbound-spacing": "未绑定的间距",
  "off-grid": "不在栅格上",
  "duplicate-name": "同级重名",
};
