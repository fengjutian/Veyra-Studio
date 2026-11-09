/**
 * 可访问性自动化的规则层。
 *
 * 采集在浏览器里做（真实 Tab 键 + Chrome 可访问性树），判定在这里做：
 * 纯函数、输入是采集到的抽象数据、输出是可读的 issue 列表。这样每条规则都能
 * 直接单测，也能离线跑（不装浏览器也能测规则本身）。
 *
 * 两条纪律：
 * ① 判定只看「采集到的事实」，不猜。读屏那边的事实是 AX 树（角色 + 可访问名 +
 *    是否可聚焦），键盘那边的事实是真实 Tab 落点序列。两者**互相交叉验证**——
 *    AX 说能聚焦但 Tab 到不了，和 Tab 能到但 AX 里没有名字，都是缺陷。
 * ② 「没有发现问题」不等于「没有问题」。规则集本身要有阴性对照（见 test/）。
 */

/** 元素没有可访问名时的占位内容键。 */
export const NO_NAME = "<无名称>";

/** issue 的严重级别。error 会让检查失败；warning 只提示。 */
export type AuditSeverity = "error" | "warning";

export type AuditCode =
  /** 可聚焦元素没有可访问名：读屏只会念出角色，念不出这是什么。 */
  | "missing-accessible-name"
  /** tabindex 大于 0：会打乱 Tab 顺序，键盘顺序从此不可预测。 */
  | "positive-tabindex"
  /** DOM 里可聚焦，Tab 却到不了（被挡住、被跳过、或焦点被劫持）。 */
  | "unreachable-by-keyboard"
  /** Tab 顺序与 DOM 顺序不一致（视觉顺序和键盘顺序对不上）。 */
  | "focus-order-mismatch"
  /** AX 树里是交互角色，却没有可访问名。 */
  | "ax-name-missing"
  /** AX 树说它可聚焦，键盘却到不了（读屏能进、键盘进不去）。 */
  | "ax-keyboard-mismatch"
  /** 聚焦时没有可见的焦点指示。 */
  | "no-focus-indicator"
  /** 焦点在同一个元素上反复打转，键盘用户出不去（焦点陷阱）。 */
  | "focus-trap"
  /** 复合控件（listbox 等）内方向键没走完所有选项。 */
  | "arrow-traversal-incomplete"
  /** 复合控件内方向键把焦点带出了控件。 */
  | "arrow-traversal-escape";

export interface AuditIssue {
  code: AuditCode;
  severity: AuditSeverity;
  message: string;
  /** 出问题的元素标识（与采集端的 auditId 对应）。 */
  target?: string;
}

/** 一次 Tab 落点。 */
export interface FocusVisit {
  /** 第几次 Tab 落点，从 1 开始。 */
  order: number;
  tag: string;
  /** AX 角色（采集时以 AX 为准，回退到 DOM 的 role 属性）。 */
  role: string;
  /** 可访问名（AX 名称优先，回退到 DOM 近似计算）。 */
  name: string;
  /** 稳定标识：`角色:名称`。同名控件会出现多次——这是正常的（多个「固定」单选）。 */
  auditId: string;
  /**
   * 内容键：元素的可访问名。三处采集（DOM 扫描、焦点落点、AX 节点）用它互相
   * 认领——它由元素自己的内容派生，React 重渲染后也不变。
   */
  key: string;
  /** DOM 节点身份：同一个元素永远同一个值。判定「是不是同一个元素」用它，不用标识。 */
  nodeKey: string;
  /**
   * 祖先链（每层祖先的内容键）：用来判「焦点是不是被重定向进了某个祖先」。
   *
   * 用内容键而不是节点身份：React 重渲染会换掉 DOM 节点，节点身份随之失效，
   * 那时候就认不出「Tab 落到的其实是这个容器的子元素」了。
   */
  ancestorKeys: string[];
  tabIndex: number;
  /** 聚焦时是否有可见的焦点指示（outline / box-shadow / 边框 / 背景的变化）。 */
  focusIndicator: boolean;
}

/** AX 树里的一个节点（已过滤掉 ignored 的）。 */
export interface AxNode {
  role: string;
  name: string;
  auditId: string;
  /** 内容键：与 FocusVisit.key 同一套规则，用来把 AX 节点和 DOM 元素对上。 */
  key: string;
  /** DOM 节点身份：与 FocusVisit.nodeKey 同一套规则。 */
  nodeKey: string;
  /** 祖先链：与 FocusVisit.ancestorKeys 同一套规则（内容键）。 */
  ancestorKeys: string[];
  tag: string;
  /** AX 认为它可以被键盘聚焦。 */
  focusable: boolean;
}

/** DOM 扫描得到的一个可聚焦元素。 */
export interface A11yDomItem {
  nodeKey: string;
  key: string;
  /** DOM 角色（没有 role 属性时是空串）。 */
  role: string;
  /** 祖先链（内容键）：与 FocusVisit.ancestorKeys 同一套规则。 */
  ancestorKeys: string[];
}

/** 复合控件内的方向键遍历结果。 */
export interface ArrowTraversal {
  /** 方向键依次落在哪些标识上。 */
  visited: string[];
  /** 期望能走到的全部标识。 */
  expected: string[];
}

export interface A11yAuditInput {
  /** 真实 Tab 键遍历的落点序列。 */
  focusSequence: FocusVisit[];
  /** AX 树节点（已过滤 ignored）。 */
  axNodes: AxNode[];
  /** DOM 顺序里的可聚焦元素**内容键**。 */
  domFocusableOrder: string[];
  /** DOM 扫描得到的可聚焦元素（带节点身份，用于判可达性）。 */
  domItems: A11yDomItem[];
  /**
   * 遍历**结束**后的可聚焦元素内容键（可选）。
   *
   * 对账要用它，而不是遍历前的那份：真实界面会边走边变（Radix 的分段控件重渲染后
   * `tabindex` 会从 0 变成 -1；选中节点后属性面板会启用一批控件）。只认「前后
   * 都在」的控件，瞬时状态才不会变成假缺陷。
   */
  domFocusableAfter?: string[];
  /** 复合控件内的方向键遍历（可选）。 */
  arrowTraversal?: ArrowTraversal;
}

/**
 * 复合控件：焦点由内部子元素代理的控件。
 *
 * 这类控件自己 `tabindex=0`（键盘入口），但 Tab 落上去后焦点会立刻转交给
 * 选中的子元素（ARIA 的 roving tabindex 模式）。键盘用户其实**到得了**它——
 * 焦点在它里面。所以这类元素不该被判成「键盘到不了」。
 *
 * 不豁免就会误报 Radix 的分段栏（tablist）、单选组（radiogroup）、画布的
 * 隐藏 listbox——它们都是这个模式。
 */
export const COMPOSITE_ROLES: ReadonlySet<string> = new Set([
  "tablist",
  "listbox",
  "menu",
  "menubar",
  "radiogroup",
  "toolbar",
  "grid",
  "tree",
  "group",
]);

/**
 * 需要可访问名的角色：这些角色没有名字时，读屏体验直接崩。 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "tab",
  "treeitem",
]);

/**
 * 跑完整套规则。
 *
 * 返回的 issue 按严重级别排序（error 在前），同级按采集顺序——报告读起来是
 * 「先说最要命的，再按出现的先后」。
 */
export function auditA11y(input: A11yAuditInput): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const focus = input.focusSequence;

  // ① 正 tabindex：一旦有，后面的顺序检查都不可信，先报。
  for (const visit of focus) {
    if (visit.tabIndex > 0) {
      issues.push({
        code: "positive-tabindex",
        severity: "error",
        message: `tabindex=${visit.tabIndex}：正 tabindex 会打乱 Tab 顺序`,
        target: visit.auditId,
      });
    }
  }

  // ② 可访问名缺失。
  for (const visit of focus) {
    if (!visit.name.trim()) {
      issues.push({
        code: "missing-accessible-name",
        severity: "error",
        message: "可聚焦元素没有可访问名：读屏只能念出角色，念不出它是什么",
        target: visit.auditId,
      });
    }
  }

  // ③ 焦点陷阱：同一个**节点**被反复落点。
  //    必须按节点身份（nodeKey）判，不能按标识判：真实界面里几十个图标按钮
  //    名称相同是正常的，那是「同名不同元素」，不是被困住。也不能拿「落点数比
  //    DOM 里的可聚焦元素多」来猜——界面在遍历途中变一下就会误报。
  const occurrences = new Map<string, number>();
  for (const visit of focus) occurrences.set(visit.nodeKey, (occurrences.get(visit.nodeKey) ?? 0) + 1);
  const repeated = [...occurrences.entries()].find(([, count]) => count > 1);
  if (repeated) {
    issues.push({
      code: "focus-trap",
      severity: "error",
      message: `焦点在同一元素上重复落点 ${repeated[1]} 次：键盘用户可能被困住`,
      target: repeated[0],
    });
  }

  // ④ DOM 里可聚焦、Tab 到不了的元素。
  //    按**节点**判可达，而不是按标识：同名控件（好几个「固定」单选）是正常的。
  //    只认**遍历前后都在**的控件：真实界面会边走边变——选中节点后属性面板启用
  //    一批控件，Radix 的分段控件重渲染后 tabindex 会从 0 变成 -1。
  const beforeCounts = countBy(input.domFocusableOrder);
  const afterCounts = input.domFocusableAfter ? countBy(input.domFocusableAfter) : beforeCounts;
  const settledKeys = new Set([...beforeCounts.keys()].filter(key => afterCounts.has(key)));
  const reachedNodes = new Set(focus.map(visit => visit.nodeKey));
  // 所有落点的祖先链合起来：用来认「焦点被重定向进了某个复合控件」。
  const reachedAncestorKeys = new Set<string>();
  for (const visit of focus) for (const ancestor of visit.ancestorKeys) reachedAncestorKeys.add(ancestor);

  const unreachable = new Map<string, number>();
  for (const item of input.domItems) {
    if (!settledKeys.has(item.key)) continue;
    if (reachedNodes.has(item.nodeKey)) continue;
    // 焦点代理：复合控件自己 tabindex=0，Tab 落上去后焦点转给了它内部的子元素。
    // 键盘其实到得了它，不能报「到不了」。
    if (COMPOSITE_ROLES.has(item.role) && item.key !== NO_NAME && reachedAncestorKeys.has(item.key)) continue;
    unreachable.set(item.key, (unreachable.get(item.key) ?? 0) + 1);
  }
  for (const [auditId, count] of unreachable) {
    issues.push({
      code: "unreachable-by-keyboard",
      severity: "error",
      message: `DOM 里有 ${count} 个「${auditId}」，Tab 一次也没落到：键盘到不了`,
      target: auditId,
    });
  }

  // ⑤ Tab 顺序与 DOM 顺序是否一致。两边都按「首次出现」去重后再比：同名控件
  //    不该制造假差异，重复项也不该把比较搅乱。
  const domOrder = firstOccurrences(input.domFocusableOrder.filter(auditId => settledKeys.has(auditId)));
  const tabOrder = firstOccurrences(focus.map(visit => visit.key));
  const common = domOrder.filter(auditId => tabOrder.includes(auditId));
  const actualOrder = tabOrder.filter(auditId => common.includes(auditId));
  for (let index = 1; index < common.length; index += 1) {
    const previous = common[index - 1]!;
    const current = common[index]!;
    if (actualOrder.indexOf(current) < actualOrder.indexOf(previous)) {
      issues.push({
        code: "focus-order-mismatch",
        severity: "error",
        message: `Tab 顺序与 DOM 顺序不一致：DOM 里 ${previous} 在 ${current} 之前，Tab 却是反的`,
        target: current,
      });
      break;
    }
  }

  // ⑥ AX 树里交互角色必须有名字。
  for (const node of input.axNodes) {
    if (INTERACTIVE_ROLES.has(node.role) && !node.name.trim()) {
      issues.push({
        code: "ax-name-missing",
        severity: "error",
        message: `可访问性树里的 ${node.role} 没有可访问名`,
        target: node.auditId,
      });
    }
  }

  // ⑦ AX 说能聚焦、键盘却到不了的元素（交叉验证的两边之一）。
  //    比的是**数量**：同名控件有多个是正常的，所以比个数而不是比集合。
  //    只认「稳定存在」的键：AX 树是遍历前采的，界面后来变了不算缺陷。
  const axFocusable = input.axNodes.filter(node => node.focusable);
  const reachedNodesByKey = new Map<string, Set<string>>();
  for (const visit of focus) {
    let nodes = reachedNodesByKey.get(visit.key);
    if (!nodes) {
      nodes = new Set<string>();
      reachedNodesByKey.set(visit.key, nodes);
    }
    nodes.add(visit.nodeKey);
  }
  for (const [key, axCount] of countBy(axFocusable.map(node => node.key))) {
    if (!settledKeys.has(key)) continue;
    const reached = reachedNodesByKey.get(key)?.size ?? 0;
    if (reached >= axCount) continue;
    // 焦点代理：复合控件自己可聚焦，Tab 落上去后焦点转给了它内部的子元素——
    // 键盘其实到得了，只是焦点没停在它身上。
    const proxied = axFocusable.some(
      node => node.key === key && COMPOSITE_ROLES.has(node.role) && key !== NO_NAME && reachedAncestorKeys.has(key),
    );
    if (proxied) continue;
    issues.push({
      code: "ax-keyboard-mismatch",
      severity: "error",
      message: `可访问性树列出 ${axCount} 个可聚焦的「${key}」，Tab 只到 ${reached} 个：读屏能进、键盘进不去`,
      target: key,
    });
  }

  // ⑧ 焦点可见性。
  for (const visit of focus) {
    if (!visit.focusIndicator) {
      issues.push({
        code: "no-focus-indicator",
        severity: "warning",
        message: "聚焦时看不到任何变化：outline / 阴影 / 边框 / 背景都没动",
        target: visit.auditId,
      });
    }
  }

  // ⑨ 复合控件内的方向键遍历。
  if (input.arrowTraversal) {
    const { visited, expected } = input.arrowTraversal;
    const missing = expected.filter(auditId => !visited.includes(auditId));
    if (missing.length) {
      issues.push({
        code: "arrow-traversal-incomplete",
        severity: "error",
        message: `方向键没走到：${missing.join("、")}`,
      });
    }
    const escaped = visited.filter(auditId => !expected.includes(auditId));
    if (escaped.length) {
      issues.push({
        code: "arrow-traversal-escape",
        severity: "error",
        message: "方向键把焦点带出了控件",
        target: escaped[0],
      });
    }
  }

  return sortIssues(issues);
}

/** error 在前；同级保持发现顺序。 */
export function sortIssues(issues: AuditIssue[]): AuditIssue[] {
  return [...issues].sort((left, right) => {
    const rank = (issue: AuditIssue) => (issue.severity === "error" ? 0 : 1);
    return rank(left) - rank(right);
  });
}

/** 按标识计数。同名控件是常态（好几个「固定」单选），所以比的是数量不是集合。 */
export function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** 保留首次出现顺序的去重。 */
export function firstOccurrences(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface AuditSummary {
  errors: number;
  warnings: number;
  ok: boolean;
}

export function summarizeIssues(issues: AuditIssue[]): AuditSummary {
  const errors = issues.filter(issue => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return { errors, warnings, ok: errors === 0 };
}

/** 一条 issue 的人类可读单行。 */
export function formatIssue(issue: AuditIssue): string {
  const target = issue.target ? ` [${issue.target}]` : "";
  return `${issue.severity === "error" ? "错误" : "警告"} ${issue.code}${target}：${issue.message}`;
}

/** 基线里记录的一条焦点落点。 */
export interface A11yFocusEntry {
  auditId: string;
  role: string;
  name: string;
}

/**
 * 可访问性基线。
 *
 * 与字体度量基线不同：这里记的不是数值，而是**语义快照**——Tab 顺序、每一步的
 * 角色与可访问名、以及读屏脚本。语义变了（按钮改名、焦点顺序调整、控件丢了
 * aria-label）都会被基线抓住，而这类改动不会体现在任何像素基线里。
 */
export interface A11yBaseline {
  environment: {
    os: string;
    browser?: string;
    generatedAt: string;
  };
  /** Tab 落点顺序。 */
  focusOrder: A11yFocusEntry[];
  /** 读屏脚本：AX 树里交互节点的「角色：名称」。 */
  announcements: string[];
}

export interface A11yBaselineDiff {
  /** 焦点顺序或语义变化的行。 */
  focusChanges: string[];
  /** 读屏脚本变化的行。 */
  announcementChanges: string[];
}

function describeFocus(entry: A11yFocusEntry): string {
  return `${entry.auditId}（${entry.role || "无角色"}：${entry.name || "无名称"}）`;
}

/** 与基线逐项比较。返回空 diff 表示语义没有变化。 */
export function compareA11yBaseline(baseline: A11yBaseline, current: A11yBaseline): A11yBaselineDiff {
  const focusChanges: string[] = [];
  const announcementChanges: string[] = [];

  const baselineFocus = baseline.focusOrder.map(describeFocus);
  const currentFocus = current.focusOrder.map(describeFocus);
  const focusLength = Math.max(baselineFocus.length, currentFocus.length);
  for (let index = 0; index < focusLength; index += 1) {
    const before = baselineFocus[index];
    const after = currentFocus[index];
    if (before === after) continue;
    if (before === undefined) focusChanges.push(`新增第 ${index + 1} 个焦点落点：${after}`);
    else if (after === undefined) focusChanges.push(`少了第 ${index + 1} 个焦点落点：${before}`);
    else focusChanges.push(`第 ${index + 1} 个焦点落点变了：${before} → ${after}`);
  }

  const announcementLength = Math.max(baseline.announcements.length, current.announcements.length);
  for (let index = 0; index < announcementLength; index += 1) {
    const before = baseline.announcements[index];
    const after = current.announcements[index];
    if (before === after) continue;
    if (before === undefined) announcementChanges.push(`新增读屏项：${after}`);
    else if (after === undefined) announcementChanges.push(`少了读屏项：${before}`);
    else announcementChanges.push(`读屏项变了：${before} → ${after}`);
  }

  return { focusChanges, announcementChanges };
}

/** 从采集结果生成基线。 */
export function buildA11yBaseline(
  environment: A11yBaseline["environment"],
  focusSequence: FocusVisit[],
  axNodes: AxNode[],
): A11yBaseline {
  return {
    environment,
    focusOrder: focusSequence.map(visit => ({ auditId: visit.auditId, role: visit.role, name: visit.name })),
    announcements: axNodes
      .filter(node => INTERACTIVE_ROLES.has(node.role))
      .map(node => `${node.role}：${node.name || "（无名称）"}`),
  };
}
