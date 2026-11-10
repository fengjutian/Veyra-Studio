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
 *
 * ## 三组新增规则（2026-11-10）
 *
 * 之前的规则全是**单节点**的——只看一个节点自己有没有毛病。但设计系统腐坏的
 * 典型症状恰恰是**节点之间的关系**：
 *
 * - 同一个「按钮」在两个页面上长得不一样（跨页面一致性）；
 * - 变体集里有属性没被覆盖、实例设了组件没声明的属性（组件语义）；
 * - 文字太小、空文本、带交互的节点没有可读的名字（可访问性）。
 *
 * 这三组规则都建立在「跨节点」的分析上，因此实现上与单节点规则分开：单节点
 * 规则在遍历里就地报，跨节点规则在遍历结束后统一算。
 */

import { effectiveComponentProperties, propertyBindings } from "./component-properties";
import { tokenColor } from "./tokens";
import type { DesignDocument, DesignNode, InstanceNode, NodeId, PageId, TextNode } from "./types";

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
  | "duplicate-name"
  /** 不同页面的根框尺寸不一样。 */
  | "page-size-mismatch"
  /** 同名节点在不同页面上长得不一样。 */
  | "cross-page-inconsistency"
  /** 变体集声明的属性没在某个变体上覆盖。 */
  | "variant-property-missing"
  /** 实例设置了组件没有声明的属性（悬空覆盖）。 */
  | "instance-unknown-property"
  /** 组件声明了属性，但没有任何节点绑定它。 */
  | "unused-component-property"
  /** 文本节点没有内容。 */
  | "empty-text"
  /** 字号小于可读下限。 */
  | "tiny-text"
  /** 带交互的节点没有可读的名字。 */
  | "interactive-without-name";

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

/**
 * 可读字号下限（px）。
 *
 * 12px 是公认的「再小就读不清」的下限；正文更常见的下限是 16px，但把 12–16px
 * 一律报出来会淹掉真正的 8px 事故，所以这里只卡 12。
 */
const MIN_READABLE_FONT_SIZE = 12;

/**
 * 自动生成的节点名。
 *
 * 这些名字对读屏器没有意义——「Frame」「矩形」念出来用户不知道是什么。带交互的
 * 节点用这种名字，读屏只会念出一个「框架」。
 */
const GENERIC_NODE_NAMES = new Set([
  "Frame", "矩形", "椭圆", "文本", "图片", "直线", "多边形", "星形",
  "布尔", "编组", "组件", "实例", "Shape", "Vector", "Group", "Text",
]);

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
  /** 节点属于哪一页——跨页面规则要用。 */
  const pageOfNode = new Map<NodeId, PageId>();

  const visit = (nodeId: NodeId, siblings: DesignNode[], parent: DesignNode | undefined, pageId: PageId): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    pageOfNode.set(node.id, pageId);

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

    // ── 可访问性：空文本 ───────────────────────────────────────────
    // 空文本节点在导出物里就是一个空标签，读屏器读不出任何东西。
    if (enabled(options, "empty-text") && node.type === "text" && !node.text.trim()) {
      issues.push({
        code: "empty-text",
        severity: "info",
        nodeId: node.id,
        message: `${node.id} 是空文本`,
        detail: node.name,
      });
    }

    // ── 可访问性：字号过小 ─────────────────────────────────────────
    if (enabled(options, "tiny-text") && node.type === "text" && node.text.trim() && node.fontSize < MIN_READABLE_FONT_SIZE) {
      issues.push({
        code: "tiny-text",
        severity: "warning",
        nodeId: node.id,
        message: `${node.id} 的字号 ${node.fontSize}px 低于可读下限 ${MIN_READABLE_FONT_SIZE}px`,
        detail: `${node.fontSize}px`,
      });
    }

    // ── 可访问性：带交互却没有可读的名字 ───────────────────────────
    if (enabled(options, "interactive-without-name") && node.interactions?.length) {
      const name = node.name.trim();
      if (!name || GENERIC_NODE_NAMES.has(name)) {
        issues.push({
          code: "interactive-without-name",
          severity: "warning",
          nodeId: node.id,
          message: `${node.id} 有 ${node.interactions.length} 条交互，但名字是「${name || "(空)"}」，读屏器念不出这是什么`,
          detail: name || "(空)",
        });
      }
    }

    const children = node.childIds.map(id => document.nodes[id]).filter((child): child is DesignNode => Boolean(child));
    for (const childId of node.childIds) visit(childId, children, node, pageId);
  };

  // 每个页面单独处理：根节点之间互为同级，跨页不算同级（否则同名页面会互相误报）。
  for (const pageId of document.pageOrder) {
    const roots = (document.pages[pageId]?.childIds ?? [])
      .map(id => document.nodes[id])
      .filter((node): node is DesignNode => Boolean(node));
    for (const rootId of document.pages[pageId]?.childIds ?? []) visit(rootId, roots, undefined, pageId);
  }

  // ── 跨节点规则：跨页面一致性 ─────────────────────────────────────
  if (enabled(options, "page-size-mismatch")) issues.push(...checkPageSizes(document));
  if (enabled(options, "cross-page-inconsistency")) issues.push(...checkCrossPageConsistency(document, pageOfNode));

  // ── 跨节点规则：组件语义 ─────────────────────────────────────────
  if (enabled(options, "variant-property-missing")) issues.push(...checkVariantProperties(document));
  if (enabled(options, "instance-unknown-property")) issues.push(...checkInstanceProperties(document));
  if (enabled(options, "unused-component-property")) issues.push(...checkUnusedComponentProperties(document));

  return issues;
}

/**
 * 跨页面一致性（一）：页面根框尺寸。
 *
 * 不同页面的画板尺寸不一样，会让「按页面切换视图」的原型和导出的多页交付物
 * 忽大忽小。只在根框是**固定尺寸**时比——`hug` / `fill` 的尺寸是算出来的，
 * 比出来的差异没有意义。
 */
function checkPageSizes(document: DesignDocument): LintIssue[] {
  const sizes: Array<{ pageId: PageId; pageName: string; nodeId: NodeId; width: number; height: number }> = [];
  for (const pageId of document.pageOrder) {
    const rootId = document.pages[pageId]?.childIds[0];
    if (!rootId) continue;
    const root = document.nodes[rootId];
    if (!root) continue;
    if (root.layout.widthMode !== "fixed" || root.layout.heightMode !== "fixed") continue;
    sizes.push({
      pageId,
      pageName: document.pages[pageId]?.name ?? pageId,
      nodeId: root.id,
      width: root.layout.width,
      height: root.layout.height,
    });
  }
  if (sizes.length < 2) return [];
  const first = sizes[0]!;
  const differing = sizes.filter(size => size.width !== first.width || size.height !== first.height);
  if (!differing.length) return [];
  return [{
    code: "page-size-mismatch",
    severity: "warning",
    nodeId: first.nodeId,
    message: `${differing.length + 1} 个页面的画板尺寸不一致`,
    detail: sizes.map(size => `${size.pageName} ${size.width}×${size.height}`).join("；"),
  }];
}

/**
 * 一个节点的「视觉签名」：跨页面比较时看的几个属性。
 *
 * 只放**用户能一眼看出来**的属性：尺寸、填充色、字号。位置不放——同一个组件在
 * 不同页面本来就该放在不同位置。宽度/高度只在固定尺寸时纳入，`hug`/`fill`
 * 的尺寸由内容算出来，比了会误报。
 */
function visualSignature(document: DesignDocument, node: DesignNode): { size?: string; fill?: string; fontSize?: number } {
  const fixed = node.layout.widthMode === "fixed" && node.layout.heightMode === "fixed";
  const fill = tokenColor(document, node.bindings?.fill)
    ?? (node.appearance.fills ?? []).find(paint => paint.type === "solid")?.color;
  const fontSize = node.type === "text" ? (node as TextNode).fontSize : undefined;
  return {
    ...(fixed ? { size: `${node.layout.width}×${node.layout.height}` } : {}),
    ...(fill ? { fill } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
  };
}

/** 视觉签名的可读描述（两两比较时说明差在哪）。 */
function describeSignatureDifference(left: ReturnType<typeof visualSignature>, right: ReturnType<typeof visualSignature>): string[] {
  const differences: string[] = [];
  if (left.size && right.size && left.size !== right.size) differences.push(`尺寸 ${left.size} vs ${right.size}`);
  if (left.fill && right.fill && left.fill !== right.fill) differences.push(`填充 ${left.fill} vs ${right.fill}`);
  if (left.fontSize !== undefined && right.fontSize !== undefined && left.fontSize !== right.fontSize) {
    differences.push(`字号 ${left.fontSize}px vs ${right.fontSize}px`);
  }
  return differences;
}

/**
 * 跨页面一致性（二）：同名节点在不同页面上长得不一样。
 *
 * 这是设计系统腐坏最常见的形态：设计稿里到处是叫「按钮」「卡片」「标题」的节点，
 * 复制粘贴之后样式就漂了。等到有人来做组件时，已经有五六种「按钮」了。
 *
 * 判据刻意保守：**同名 + 同类型 + 跨页面**，且差异落在尺寸/填充/字号上。
 * 同名但类型不同的不算（页面上叫「内容」的 frame 和 text 本来就不该一样）。
 */
function checkCrossPageConsistency(
  document: DesignDocument,
  pageOfNode: Map<NodeId, PageId>,
): LintIssue[] {
  const byName = new Map<string, DesignNode[]>();
  for (const node of Object.values(document.nodes)) {
    const name = node.name.trim();
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(node);
    byName.set(name, list);
  }

  const issues: LintIssue[] = [];
  for (const [name, nodes] of byName) {
    if (nodes.length < 2) continue;
    // 同名节点必须落在**不同页面**上才有意义。
    const pages = new Set(nodes.map(node => pageOfNode.get(node.id)).filter((page): page is PageId => Boolean(page)));
    if (pages.size < 2) continue;

    // 先按类型分开：页面上叫「内容」的 frame 和 text 本来就不该一样，
    // 把它们放在一起比会报出「长得不一样」这种毫无意义的结论。
    const byType = new Map<string, DesignNode[]>();
    for (const node of nodes) {
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }

    for (const sameType of byType.values()) {
      if (sameType.length < 2) continue;
      const typePages = new Set(sameType.map(node => pageOfNode.get(node.id)).filter((page): page is PageId => Boolean(page)));
      if (typePages.size < 2) continue;

      // 按视觉签名分组；只有分布在不同页面的组之间才算不一致。
      const groups = new Map<string, { node: DesignNode; signature: ReturnType<typeof visualSignature>; pages: Set<PageId> }>();
      for (const node of sameType) {
        const pageId = pageOfNode.get(node.id);
        if (!pageId) continue;
        const signature = visualSignature(document, node);
        const key = `${signature.size ?? ""}|${signature.fill ?? ""}|${signature.fontSize ?? ""}`;
        const group = groups.get(key);
        if (group) group.pages.add(pageId);
        else groups.set(key, { node, signature, pages: new Set([pageId]) });
      }
      if (groups.size < 2) continue;

      // 找一对落在不同页面上的分组；同一个名字最多报一条。
      const variants = [...groups.values()];
      let reported = false;
      for (let i = 0; i < variants.length && !reported; i += 1) {
        for (let j = i + 1; j < variants.length; j += 1) {
          const left = variants[i]!;
          const right = variants[j]!;
          const sharesPage = [...left.pages].some(page => right.pages.has(page));
          if (sharesPage) continue;
          const differences = describeSignatureDifference(left.signature, right.signature);
          if (!differences.length) continue;
          issues.push({
            code: "cross-page-inconsistency",
            severity: "warning",
            nodeId: left.node.id,
            message: `跨页面的「${name}」长得不一样`,
            detail: `${left.node.id} 与 ${right.node.id}：${differences.join("；")}`,
          });
          reported = true;
          break;
        }
      }
      // 同一个名字只报一条——它在别的类型下再不一致也是同一个症状。
      if (reported) break;
    }
  }
  return issues;
}

/**
 * 组件语义（一）：变体集的属性没在某个变体上覆盖。
 *
 * 变体集声明了「状态 = 默认 / 悬停」这样的属性，每个变体都得给出自己的取值。
 * 少一个取值，那个变体在实例里就没法被正确区分。
 */
function checkVariantProperties(document: DesignDocument): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const set of Object.values(document.componentSets ?? {})) {
    const members = Object.values(document.components).filter(component => component.variantSetId === set.id);
    for (const member of members) {
      const missing = set.properties.filter(property => !member.variant || !(property in member.variant));
      if (!missing.length) continue;
      issues.push({
        code: "variant-property-missing",
        severity: "warning",
        nodeId: member.rootNodeId,
        message: `变体「${member.name}」没有覆盖变体集「${set.name}」的属性`,
        detail: missing.join(", "),
      });
    }
  }
  return issues;
}

/**
 * 组件语义（二）：实例设置了组件没有声明的属性。
 *
 * 组件删掉或改名一个属性后，实例上显式设置过的旧值会留在文档里。它既不生效，
 * 也不会被自动清掉——用户改组件属性时看不见这个幽灵值。
 */
function checkInstanceProperties(document: DesignDocument): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "instance") continue;
    const instance = node as InstanceNode;
    const values = instance.propValues ?? {};
    const ids = Object.keys(values);
    if (!ids.length) continue;
    const declared = new Set(effectiveComponentProperties(document, instance.componentId).map(property => property.id));
    if (!declared.size) continue;
    const unknown = ids.filter(id => !declared.has(id));
    if (!unknown.length) continue;
    issues.push({
      code: "instance-unknown-property",
      severity: "warning",
      nodeId: node.id,
      message: `${node.id} 设置了组件没有声明的属性`,
      detail: unknown.join(", "),
    });
  }
  return issues;
}

/**
 * 组件语义（三）：组件声明了属性，但没有任何节点绑定它。
 *
 * 属性本身没接线：改这个属性不会有任何视觉变化。这种属性留在文档里只会让人
 * 以为「这个参数管用」。
 */
function checkUnusedComponentProperties(document: DesignDocument): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const component of Object.values(document.components)) {
    const properties = effectiveComponentProperties(document, component.id);
    if (!properties.length) continue;
    const bound = new Set(propertyBindings(document, component.id).map(binding => binding.propertyId));
    const unused = properties.filter(property => !bound.has(property.id));
    if (!unused.length) continue;
    issues.push({
      code: "unused-component-property",
      severity: "info",
      nodeId: component.rootNodeId,
      message: `组件「${component.name}」声明的属性没有绑定到任何节点`,
      detail: unused.map(property => property.name || property.id).join(", "),
    });
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
  "page-size-mismatch": "页面尺寸不一致",
  "cross-page-inconsistency": "跨页面样式不一致",
  "variant-property-missing": "变体属性没覆盖",
  "instance-unknown-property": "实例设了未声明的属性",
  "unused-component-property": "属性没有接线",
  "empty-text": "空文本",
  "tiny-text": "字号过小",
  "interactive-without-name": "交互节点没有可读名字",
};

/**
 * 这些 lint 结论有**明确的修法**，可以交给模型自动改。
 *
 * 反过来，有些结论是「需要人决策」的：页面画板尺寸该统一成多大？跨页面的同名
 * 节点该以哪一边为准？声明了却没接线的属性，是该删属性还是该加绑定？——没有
 * 唯一答案，模型只能瞎猜，猜错就是一次破坏性的改动。
 *
 * 所以这几条**只在面板里提示，不进体检层的待修清单**：编排循环不该拿它们去
 * 反复折腾模型（那正是「震荡」停止条件的来源）。
 */
const AUTO_FIXABLE_CODES = new Set<LintCode>([
  "hardcoded-fill",
  "hardcoded-stroke",
  "unbound-spacing",
  "off-grid",
  "duplicate-name",
  "variant-property-missing",
  "instance-unknown-property",
  "empty-text",
  "tiny-text",
  "interactive-without-name",
]);

/**
 * 这条 lint 结论能不能自动修。
 *
 * 体检层（`collectSelfCheck`）用它决定哪些结论进「待修清单」回喂给模型；
 * 面板不区分——所有结论都显示。
 */
export function lintIssueActionable(code: LintCode): boolean {
  return AUTO_FIXABLE_CODES.has(code);
}
