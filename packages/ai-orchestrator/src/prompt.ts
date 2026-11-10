import type { DesignDocument, DesignNode, Paint } from "@ufira/design-schema";
import { describeColorUsage, describeCommandVocabulary, describeNodeTemplate } from "./command-vocabulary";
import type { AiPlanRequest } from "./safe-ai-editor";
import { formatSelfCheckForPrompt } from "./self-check";

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
    "你是 Veyra 的命令规划器。把用户的中文需求翻译成该设计文档的 JSON 命令计划。",
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
    "颜色的写法：",
    describeColorUsage(),
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
    "8. 如果提示里给出了「体检结论」的待修清单，就只针对清单里的问题做改动，清单之外的问题不要顺手改。",
    "9. 多页面任务先用 page.create 创建页面（新页面 id 必须唯一），再用 node.create 把节点放入对应页面；不要把不同页面的节点混到同一个 parentId。",
    "10. 跨页面设计优先复用现有 token、组件与主题；除非用户明确要求，每一页都要保持相同的颜色、字体、圆角和间距体系。",
    "11. 坐标与尺寸一律取整数。**不要逐字符推算文本宽度、不要计算全角字符占几个像素**——",
    "    那样既算不准，又会把回复拖到写不完。视觉上大致齐整即可，宽度按经验给整。",
    "12. 只输出 JSON 计划本身：不要解释、不要写计算过程、不要加注释。",
    "13. 计划较长时，**先保证结构完整**（父节点在子节点之前、命令顺序能直接执行），再补细节；",
    "    不要为了凑节点数而堆无意义的节点，也不要因为细节多而把计划写到一半。",
  ].join("\n");
}

function buildUserPrompt(request: AiPlanRequest): string {
  const parts: string[] = [`用户需求：${request.prompt.trim()}`, ""];
  // 体检结论排在文档摘要之前：模型先看到"哪里不对"，再看"现在长什么样"，
  // 顺序反了容易让它先通读文档再自己找问题（那就是它在干体检的活）。
  if (request.selfCheck) {
    parts.push(formatSelfCheckForPrompt(request.selfCheck, request.selfCheckRound ? { round: request.selfCheckRound } : {}));
    parts.push("");
  }
  if (request.image) {
    parts.push(describeAttachedImage(request.image));
    parts.push("");
  }
  if (request.scopePageId) {
    // 单页范围：明说边界。光靠「摘要里没有」还不够——模型会自己推演出别的页面也有类似节点。
    parts.push([
      `本次计划只做页面 ${request.scopePageId} 这一页。`,
      "摘要里没有列出的节点 id 一律不要出现在命令里，也不要改、删、复用其它页面的节点——",
      "需要同样的东西就自己新建节点（id 自己起，带这一页的前缀）。",
    ].join(""));
    parts.push("");
  }
  parts.push(summarizeDocument(request.document, request.selectedNodeIds, request.scopePageId));
  parts.push("");
  parts.push("请只输出 JSON 计划。");
  return parts.join("\n");
}

/**
 * 告诉模型「附了一张图」以及「图和文字摘要各管什么」。
 *
 * 必须讲清楚分工：文字摘要给的是**精确数值**（id、坐标、字号），截图给的是
 * **观感**（挤不挤、齐不齐、好不好看）。模型分不清这两者时，要么忽略截图，
 * 要么拿截图里的模糊印象去改精确数值——两种都会出错。
 */
function describeAttachedImage(image: AiPlanRequest["image"]): string {
  if (!image) return "";
  const size = image.width && image.height ? `${image.width}×${image.height}` : "尺寸未知";
  return [
    `附上了${image.label ? image.label : "当前画面"}的截图（${image.mimeType}，${size}）。`,
    "分工：文字摘要给的是精确的节点 id、坐标、尺寸与字号；截图给的是观感——挤不挤、对不对齐、够不够醒目、哪里难看。",
    "要改的仍然是摘要里列出的真实节点，用它们的 id 下命令；截图用来判断「改成什么样」，不要凭截图猜 id。",
  ].join("\n");
}

/**
 * 把当前文档压成模型能读懂的紧凑摘要。
 *
 * ## 单页范围：别把别的页面的节点 id 摊给模型
 *
 * 限定在某一页的任务（`scopePageId`）只列出**那一页**的节点树，其它页面只留名字。
 *
 * 原因实测过：摘要里带着别的页面的节点 id 时，模型会把它们当成「可以拿来改的现成节点」——
 * 画第 3 页时，它把第 2 页的 `frame:users-sidebar`、`text:users-product-name` 等 28 个节点
 * 逐个 patch 了一遍（"照着上一页的样子改一下"），整份计划被单页范围审查拦下，连试三次都一样。
 *
 * 规则 1 已经写着「只能引用摘要里出现过的节点 id」——摘要里不出现，问题就不存在了。
 */
export function summarizeDocument(document: DesignDocument, selectedNodeIds: string[] = [], scopePageId?: string): string {
  const lines: string[] = [];
  lines.push(`当前文档：${document.meta.name}（revision ${document.revision}）`);

  lines.push("可用页面：");
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    lines.push(`- ${page.id} 名称="${page.name}" 尺寸=${page.width ?? 960}×${page.height ?? 680} 顶层对象 ${page.childIds.length} 个 主题=${page.themeId ?? "（跟随基础主题）"}`);
  }

  lines.push("节点树：");
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    if (scopePageId && pageId !== scopePageId) {
      // 别的页面：只留一行名字，不给节点 id。
      lines.push(`- ${page.id} 名称="${page.name}"（本次不涉及这一页，不列出它的节点）`);
      continue;
    }
    lines.push(`- ${page.id} 名称="${page.name}"`);
    for (const childId of page.childIds) appendNode(lines, document, childId, 1);
  }

  lines.push("Token：");
  const tokenEntries = Object.entries(document.tokens);
  if (!tokenEntries.length) lines.push("- （无）");
  else for (const [name, token] of tokenEntries) lines.push(`- ${name} = ${String(token.value)}（${token.type}）`);

  lines.push("主题：");
  const themes = document.themes ?? [];
  if (!themes.length) lines.push("- （无）");
  else for (const theme of themes) {
    const overrides = Object.keys(theme.tokens).join(", ") || "无 token 覆盖";
    lines.push(`- ${theme.id} 名称="${theme.name}"${theme.extends ? ` 继承=${theme.extends}` : ""} 覆盖=${overrides}`);
  }

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
 * 必须按 `type` 收窄：`Paint` 是 solid / linear / radial / elliptical 四选一，
 * 早先这里只判断了 `solid` 就直接读 `angle`，径向渐变一进文档就让 dts 构建失败（TS2339）；
 * 椭圆渐变加进来后，末尾那个「否则就是径向」的兜底也会读错字段（半径变成 NaN），
 * 所以每种类型都单独收窄。
 */
function describePaint(paint: Paint): string {
  if (paint.type === "solid") return paint.color;
  if (paint.type === "linear") return `线性渐变(${paint.angle}deg)`;
  if (paint.type === "elliptical") return `椭圆渐变(中心 ${round(paint.cx * 100)}%,${round(paint.cy * 100)}%，半轴 ${round(paint.rx * 100)}%×${round(paint.ry * 100)}%)`;
  return `径向渐变(中心 ${round(paint.cx * 100)}%,${round(paint.cy * 100)}%，半径 ${round(paint.r * 100)}%)`;
}
