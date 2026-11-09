/**
 * 采集端在页面里执行的脚本。
 *
 * 这些片段会被拼进 `Runtime.evaluate` 的表达式，或作为 `Runtime.callFunctionOn`
 * 的函数体——所以它们必须是**自包含**的（不能引用外部作用域的变量）。
 *
 * 页面侧只返回**原始事实**（节点身份、内容键、标签、文字、计算样式），标识的
 * 拼装放在 Node 侧做：只有一处实现，三处采集（DOM 扫描、焦点落点、AX 节点回查）
 * 才不会算出不同的东西。
 *
 * 用 String.raw 是因为脚本里有正则 `\s`：普通模板字符串会把它吃成 `s`。
 */
export const PAGE_HELPERS = String.raw`
/*
 * 节点身份：同一个 DOM 元素永远拿到同一个 key。
 *
 * 用 WeakMap 而不是「角色:文字」：真实界面里几十个图标按钮的 textContent 都是
 * 空串，按文字拼标识会全部塌缩成同一个 id，交叉验证就变成拿苹果比橘子。
 * React 重渲染会换掉 DOM 节点，此时 key 也会变——这正是我们要的：「同一个元素」
 * 指的就是同一个节点。
 */
function nodeKeyOf(el) {
  if (!el || el.nodeType !== 1) return "";
  if (!window.__auditNodeKeys) { window.__auditNodeKeys = new WeakMap(); window.__auditNodeKeySeq = 0; }
  let key = window.__auditNodeKeys.get(el);
  if (!key) {
    window.__auditNodeKeySeq += 1;
    key = "n" + window.__auditNodeKeySeq;
    window.__auditNodeKeys.set(el, key);
  }
  return key;
}

function domTextOf(el) {
  return ((el && el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/*
 * 内容键：跨采集时刻仍然稳定的关联依据。
 *
 * React 重渲染会换掉 DOM 节点，节点身份（nodeKey）随之失效——上一轮实测就是
 * 面板切换后整片对不上。内容键由元素自己的可访问名派生，重渲染后不变，
 * 所以三处采集用它互相认领。
 *
 * 键里**不放角色**：DOM 侧算出来的是标签名（select），AX 侧是 AX 角色
 * （combobox），放进去两边就对不上了。角色是「这个元素是什么」，键只需要
 * 「这个元素叫什么」。
 */
function contentKeyOf(el) {
  if (!el || el.nodeType !== 1) return "";
  return accessibleNameOf(el) || "<无名称>";
}

/** 显式标识：作者自己写的稳定标识，比内容键更可靠也更可读。 */
function explicitIdOf(el) {
  const direct = el.getAttribute("data-audit-id");
  if (direct) return direct;
  const nodeId = el.getAttribute("data-node-id");
  if (nodeId) return nodeId;
  if (el.id) return "#" + el.id;
  return "";
}

/*
 * 祖先链：元素上面每一层的**内容键**。
 *
 * 用来判「焦点是不是被重定向进了某个祖先」：Radix 的分段栏自己 tabindex=0，但
 * Tab 落上去后立刻把焦点交给选中的标签页——键盘其实到得了它，只是焦点没停在
 * 它身上。没有祖先链，这种「焦点代理」会被误报成键盘到不了。
 *
 * 用**内容键**而不是节点身份：React 重渲染会换掉 DOM 节点，节点身份随之失效，
 * 那时侯就认不出「Tab 落到的其实是这个容器的子元素」了。内容键由元素自己的
 * 可访问名派生，重渲染后不变。
 */
function ancestorKeysOf(el) {
  const keys = [];
  let current = el && el.parentElement;
  while (current) {
    keys.push(contentKeyOf(current));
    current = current.parentElement;
  }
  return keys;
}

function accessibleNameOf(el) {
  const attr = function (name) { return (el.getAttribute(name) || "").trim(); };
  const aria = attr("aria-label");
  if (aria) return aria;
  const labelledBy = attr("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map(function (id) {
      const target = document.getElementById(id);
      return target ? (target.textContent || "").replace(/\s+/g, " ").trim() : "";
    }).filter(Boolean).join(" ");
    if (text) return text;
  }
  const alt = attr("alt");
  if (alt) return alt;
  const labels = el.labels;
  if (labels && labels.length) {
    const text = Array.prototype.map.call(labels, function (label) {
      return labelTextWithoutControl(label, el);
    }).filter(Boolean).join(" ");
    if (text) return text;
  }
  const text = domTextOf(el);
  if (text) return text;
  const title = attr("title");
  if (title) return title;
  const placeholder = attr("placeholder");
  if (placeholder) return placeholder;
  const value = typeof el.value === "string" ? el.value.trim() : "";
  if (value) return value;
  return "";
}

/*
 * 标签文本：**不含**被标注控件自己的内容。
 *
 * HTML-AAM 规定：控件的可访问名来自包裹它的 <label> 的文本，但要排除控件自身
 * 的文本贡献。真实例子：<label>对齐<select><option>左对齐</option>…</select></label>
 * 的可访问名是「对齐」，不是「对齐左对齐居中右对齐」。直接取 label 的 textContent
 * 会把选项文字也算进去——实测基线里 prop.align 的名字就是这么多出来一截。
 *
 * 不能靠克隆 label 再删控件：游离树上 <select>.labels 是空的，删不掉。
 * 所以直接遍历 label 的子节点，碰到控件本身（或是它的祖先）就跳过它的文本。
 */
function labelTextWithoutControl(label, control) {
  const parts = [];
  const walk = function (node) {
    for (const child of Array.prototype.slice.call(node.childNodes)) {
      if (child === control) continue;
      if (child.nodeType === 3) {
        parts.push(child.textContent || "");
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.contains && child.contains(control)) {
        walk(child);
        continue;
      }
      parts.push(child.textContent || "");
    }
  };
  walk(label);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isTabbable(el) {
  if (el.tabIndex < 0) return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.closest("[inert]")) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (!el.getClientRects().length) return false;
  return true;
}

/*
 * Tab 顺序里的第一个可聚焦元素。
 *
 * 不能用「DOM 顺序第一个」：HTML 规定正 tabindex 的元素排在**所有** tabindex=0
 * 的元素**前面**（按 tabindex 升序）。用 DOM 顺序当起点会直接跳过它们——
 * 上一轮就是因此漏掉了阴性对照里的 tabindex=3 元素，连带报出两条假的
 * 「键盘到不了」。
 */
function firstInTabOrder() {
  const items = [];
  let index = 0;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    index += 1;
    if (!isTabbable(el)) continue;
    items.push({ el, tabIndex: el.tabIndex, index });
  }
  items.sort((left, right) => {
    const leftGroup = left.tabIndex > 0 ? 0 : 1;
    const rightGroup = right.tabIndex > 0 ? 0 : 1;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    if (leftGroup === 0 && left.tabIndex !== right.tabIndex) return left.tabIndex - right.tabIndex;
    return left.index - right.index;
  });
  return items.length ? items[0].el : null;
}

/*
 * 增量样式快照：把「初始扫描之后才变得可 Tab 的元素」的聚焦前样式补上。
 *
 * 为什么需要：真实界面会边走边变——选中画布节点后属性面板才渲染出输入框，
 * 画布的隐藏 listbox 也会把 roving tabindex 挪到当前选项上。这些元素在遍历
 * 开始时还不存在（或还不可 Tab），采集不到「聚焦前」的样式；判定焦点指示
 * 时没有基准，就只能报出并不存在的缺陷（实测把属性面板的输入框全报了一遍）。
 *
 * 每次按 Tab 之前补一次：补到的元素此刻还没被聚焦，样式就是它的「聚焦前」状态。
 */
function styleSnapshotForNewElements() {
  if (!window.__auditStyledNodes) window.__auditStyledNodes = new WeakSet();
  const items = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (window.__auditStyledNodes.has(el)) continue;
    if (el.tabIndex < 0) continue;   // 便宜的过滤：绝大多数元素到不了下一步
    if (!isTabbable(el)) continue;
    // 当前聚焦的元素不能当基准：它此刻的样式**就是**聚焦后的样子，采进去
    // 会把「有焦点环」误判成「聚焦前后没变化」。跳过它（也不记进集合，
    // 等它失去焦点、仍然可 Tab 时再采）。
    if (el === document.activeElement) continue;
    window.__auditStyledNodes.add(el);
    items.push({ nodeKey: nodeKeyOf(el), contentKey: contentKeyOf(el), style: focusStyleSignature(el) });
  }
  return items;
}

/*
 * 焦点指示的判据：拿「聚焦前」和「聚焦后」的样式签名比。
 *
 * 只认 outline / box-shadow 会误判：Studio 的输入框是
 * .dialog-input:focus{outline:none;border-color:#8b5cf6}——用边框变色表示聚焦，
 * 这是合规的焦点指示，但按 outline 判据会被误报。
 */
function focusStyleSignature(el) {
  const style = getComputedStyle(el);
  return [
    style.outlineStyle, style.outlineWidth, style.outlineColor,
    style.boxShadow,
    style.borderTopWidth, style.borderTopColor,
    style.borderLeftWidth, style.borderLeftColor,
    style.backgroundColor,
  ].join("|");
}
`;

/**
 * 扫描 DOM 里所有可 Tab 到的元素（按文档顺序）。
 *
 * 辅助函数要先注入页面全局（见 `injectPageHelpers`），所以这里不再重复内联。
 */
export function domFocusableExpression(): string {
  return `(() => {
  if (!window.__auditStyledNodes) window.__auditStyledNodes = new WeakSet();
  const items = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!isTabbable(el)) continue;
    window.__auditStyledNodes.add(el);
    items.push({
      nodeKey: nodeKeyOf(el),
      contentKey: contentKeyOf(el),
      explicitId: explicitIdOf(el),
      ancestorKeys: ancestorKeysOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      tabIndex: el.tabIndex,
      text: domTextOf(el),
      style: focusStyleSignature(el),
      // 当前是否聚焦：聚焦着的元素不能当「聚焦前」的基准。
      focused: el === document.activeElement,
    });
  }
  return items;
})()`;
}

/** 增量补采「刚变得可 Tab 的元素」的聚焦前样式。 */
export function styleSnapshotExpression(): string {
  return `(() => styleSnapshotForNewElements())()`;
}

/** 读当前焦点落点。body / 无焦点时返回 null。 */
export function focusVisitExpression(): string {
  return `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const s = getComputedStyle(el);
  return {
    nodeKey: nodeKeyOf(el),
    contentKey: contentKeyOf(el),
    explicitId: explicitIdOf(el),
    ancestorKeys: ancestorKeysOf(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    text: domTextOf(el),
    name: accessibleNameOf(el),
    tabIndex: el.tabIndex,
    style: focusStyleSignature(el),
    // 正向证据：此刻有没有可见的描边 / 阴影。没有「聚焦前」基准时，
    // 靠它判断「至少看得见一个环」。
    outlineVisible: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0,
    shadowVisible: !!s.boxShadow && s.boxShadow !== "none",
  };
})()`;
}

/**
 * AX 节点回查 DOM 用的函数体。
 *
 * `Runtime.callFunctionOn` 的 `this` 是被解析的节点。文本节点没有
 * `getAttribute`——AX 树里 StaticText 常常指向文本节点，所以必须先挡掉。
 *
 * 页面侧辅助函数（`accessibleNameOf` 等）由采集流程先注入全局，这里直接用。
 */
export const AX_ELEMENT_FUNCTION = String.raw`function () {
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const direct = el.getAttribute("data-audit-id");
  const nodeId = el.getAttribute("data-node-id");
  const id = el.id ? "#" + el.id : "";
  return {
    nodeKey: nodeKeyOf(el),
    contentKey: contentKeyOf(el),
    explicitId: direct || nodeId || id,
    ancestorKeys: ancestorKeysOf(el),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    tabIndex: el.tabIndex,
    text: domTextOf(el),
  };
}`;
