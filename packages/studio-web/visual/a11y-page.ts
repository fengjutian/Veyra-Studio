/**
 * 采集端在页面里执行的脚本。
 *
 * 这些片段会被拼进 `Runtime.evaluate` 的表达式，或作为 `Runtime.callFunctionOn`
 * 的函数体——所以它们必须是**自包含**的（不能引用外部作用域的变量）。
 *
 * 三处（DOM 扫描、焦点落点、AX 节点回查 DOM）必须用**同一套**标识规则，否则
 * 交叉验证就是拿苹果比橘子。这里把规则集中在 PAGE_HELPERS 里，三处共用。
 *
 * 用 String.raw 是因为脚本里有正则 `\s`：普通模板字符串会把它吃成 `s`。
 */
export const PAGE_HELPERS = String.raw`
function auditIdOf(el) {
  if (!el || el.nodeType !== 1) return "";
  const direct = el.getAttribute("data-audit-id");
  if (direct) return direct;
  const nodeId = el.getAttribute("data-node-id");
  if (nodeId) return nodeId;
  if (el.id) return "#" + el.id;
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return role + ":" + text;
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
      return (label.textContent || "").replace(/\s+/g, " ").trim();
    }).filter(Boolean).join(" ");
    if (text) return text;
  }
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const title = attr("title");
  if (title) return title;
  const placeholder = attr("placeholder");
  if (placeholder) return placeholder;
  const value = typeof el.value === "string" ? el.value.trim() : "";
  if (value) return value;
  return "";
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

/** 扫描 DOM 里所有可 Tab 到的元素（按文档顺序）。 */
export function domFocusableExpression(): string {
  return `${PAGE_HELPERS}
(() => {
  const items = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!isTabbable(el)) continue;
    items.push({
      auditId: auditIdOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      tabIndex: el.tabIndex,
      style: focusStyleSignature(el),
    });
  }
  return items;
})()`;
}

/** 读当前焦点落点。body / 无焦点时返回 null。 */
export function focusVisitExpression(): string {
  return `${PAGE_HELPERS}
(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    name: accessibleNameOf(el),
    auditId: auditIdOf(el),
    tabIndex: el.tabIndex,
    style: focusStyleSignature(el),
  };
})()`;
}

/**
 * AX 节点回查 DOM 用的函数体。
 *
 * `Runtime.callFunctionOn` 的 `this` 是被解析的节点。文本节点没有
 * `getAttribute`——AX 树里 StaticText 常常指向文本节点，所以必须先挡掉。
 */
export const AX_ELEMENT_FUNCTION = String.raw`function () {
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const direct = el.getAttribute("data-audit-id");
  const nodeId = el.getAttribute("data-node-id");
  const id = el.id ? "#" + el.id : "";
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return {
    auditId: direct || nodeId || id || (role + ":" + text),
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    tabIndex: el.tabIndex,
  };
}`;
