import type { DesignDocument, DesignNode, Paint } from "@ufira/design-schema";
import { describeCommandVocabulary, describeNodeTemplate } from "./command-vocabulary";
import type { AiPlanRequest } from "./safe-ai-editor";

export interface PlannerPrompt {
  system: string;
  user: string;
}

/**
 * 组装给模型的 system / user 两段提示。
 *
 * system 段固定描述命令词汇和输出契约，user 段带上这次要改的文档摘要。这样模型
 * 看到的是「当前文档里真实存在的 id 和几何」，而不是要它自己猜节点结构。
 */
export function buildPlannerPrompt(request: AiPlanRequest): PlannerPrompt {
  return { system: buildSystemPrompt(), user: buildUserPrompt(request) };
}

function buildSystemPrompt(): string {
  return [
    "你是 AI Design Studio 的命令规划器。把用户的中文需求翻译成该设计文档的 JSON 命令计划。",
    "",
    "只输出一个 JSON 对象，不要输出解释文字，也不要用 Markdown 代码围栏。格式：",
    "{",
    '  "summary": "一句话说明这次改动",',
    '  "assumptions": ["做此改动所依赖的假设"],',
    '  "commands": [ { "type": "<命令类型>", "payload": { } } ]',
    "}",
    "",
    "可用命令（type / payload）：",
    describeCommandVocabulary(),
    "",
    "新建节点的完整模板（node.create / component.instantiate 必须字段齐全）：",
    describeNodeTemplate(),
    "",
    "文本节点在模板基础上额外需要：text、fontFamily、fontSize、lineHeight；",
    "可选 fontWeight（100–900 的整数）、fontStyle（\"normal\"|\"italic\"）、",
    "textAlign（\"left\"|\"center\"|\"right\"）、letterSpacing（数字，单位 px）。",
    "",
    "硬性规则：",
    "1. 只能引用文档摘要里出现过的节点 id 和页面 id；新建节点的 id 必须唯一并带类型前缀（如 frame:card-1）。",
    "2. node.create 的 childIds 必须为空；把节点放进容器时把它的 parentId 设成该容器 id。",
    "3. node.patch 是整块替换：patch 里一旦写了 layout 或 appearance，就必须写全该对象的全部字段，否则会丢掉其它属性。",
    "4. width/height 只有在 widthMode/heightMode 为 \"fixed\" 时才生效；\"hug\" 表示跟随内容，\"fill\" 表示跟随父级。",
    "5. 文本的字号/行高/字重等改动优先用 text.patch，不要用 node.patch。",
    "6. 只做用户要求的改动，不要顺手重构或改无关节点；commands 保持最少。",
    "7. assumptions 用来写你替用户做的假设（例如\"沿用当前页面的边距\"），没有假设就给空数组。",
  ].join("\n");
}

function buildUserPrompt(request: AiPlanRequest): string {
  return [
    `用户需求：${request.prompt.trim()}`,
    "",
    summarizeDocument(request.document, request.selectedNodeIds),
    "",
    "请只输出 JSON 计划。",
  ].join("\n");
}

/** 把当前文档压成模型能读懂的紧凑摘要。 */
export function summarizeDocument(document: DesignDocument, selectedNodeIds: string[] = []): string {
  const lines: string[] = [];
  lines.push(`当前文档：${document.meta.name}（revision ${document.revision}）`);

  lines.push("可用页面：");
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    lines.push(`- ${page.id} 名称="${page.name}" 顶层对象 ${page.childIds.length} 个`);
  }

  lines.push("节点树：");
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    lines.push(`- ${page.id} 名称="${page.name}"`);
    for (const childId of page.childIds) appendNode(lines, document, childId, 1);
  }

  lines.push("Token：");
  const tokenEntries = Object.entries(document.tokens);
  if (!tokenEntries.length) lines.push("- （无）");
  else for (const [name, token] of tokenEntries) lines.push(`- ${name} = ${String(token.value)}（${token.type}）`);

  lines.push("组件：");
  const componentEntries = Object.entries(document.components);
  if (!componentEntries.length) lines.push("- （无）");
  else for (const [id, component] of componentEntries) lines.push(`- ${id} 名称="${component.name}" 根节点=${component.rootNodeId}`);

  lines.push(`当前选中：${selectedNodeIds.length ? selectedNodeIds.join(", ") : "（无）"}`);
  return lines.join("\n");
}

function appendNode(lines: string[], document: DesignDocument, nodeId: string, depth: number): void {
  const node = document.nodes[nodeId];
  if (!node) return;
  lines.push(`${"  ".repeat(depth)}- ${describeNode(node)}`);
  for (const childId of node.childIds) appendNode(lines, document, childId, depth + 1);
}

function describeNode(node: DesignNode): string {
  const parts = [
    `${node.id} 名称="${node.name}" 类型=${node.type}`,
    `位置=(${round(node.layout.x)},${round(node.layout.y)})`,
    `尺寸=${round(node.layout.width)}×${round(node.layout.height)}`,
  ];
  const fill = node.appearance.fills?.[0];
  if (fill) parts.push(`填充=${describePaint(fill)}`);
  if (node.appearance.stroke) parts.push(`描边=${node.appearance.stroke}`);
  if (node.type === "text") parts.push(`文本="${node.text}"`, `字号=${node.fontSize}`);
  return parts.join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 把填充层压成一句给模型看的描述。
 *
 * 必须按 `type` 收窄：`Paint` 是 solid / linear / radial 三选一，早先这里只判断了
 * `solid` 就直接读 `angle`，径向渐变一进文档就让 dts 构建失败（TS2339）。
 */
function describePaint(paint: Paint): string {
  if (paint.type === "solid") return paint.color;
  if (paint.type === "linear") return `线性渐变(${paint.angle}deg)`;
  return `径向渐变(中心 ${round(paint.cx * 100)}%,${round(paint.cy * 100)}%，半径 ${round(paint.r * 100)}%)`;
}
