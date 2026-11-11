import {
  applyTypographyToken,
  resolveCornerRadii,
  resolveFills,
  resolveRadius,
  resolveStroke,
  computeBooleanBounds,
  computeBooleanGeometry,
  textFillColor,
  vectorPathCommands,
  type CornerRadii,
  type BlendMode,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type Paint,
  type PathCommand,
  type ShadowSpec,
  type ParagraphStyleRun,
  type TextNode,
  type TextRun,
} from "@ufira/design-schema";

/**
 * 场景构建：把设计文档 + 布局结果压成一份"画什么"的纯数据。
 *
 * 这一层不碰 DOM、不碰 Canvas，所以可以在 Node 里直接断言。渲染器只负责把
 * SceneNode 画出来；换渲染器时只需要换渲染器，不需要重新理解文档结构。
 *
 * 借鉴 tldraw / Excalidraw 的分工：形状描述是纯函数，绘制与命中测试各自实现。
 */

export interface SceneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneText {
  value: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  /** 目前只支持 normal / italic。 */
  fontStyle: "normal" | "italic";
  align: "left" | "center" | "right";
  letterSpacing: number;
  color: string;
  /** 段内样式覆盖；为空表示整段用节点级样式。 */
  runs?: TextRun[];
  /** 段落样式区间；决定列表标记与缩进。 */
  paragraphStyles?: ParagraphStyleRun[];
}

export interface SceneImage {
  assetId: string;
  fit: "cover" | "contain" | "fill";
}

export interface SceneNode {
  id: NodeId;
  type: DesignNode["type"];
  box: SceneBox;
  /** 容器是否裁剪子节点（对应 DOM 的 overflow: hidden）。 */
  clip: boolean;
  opacity: number;
  fill?: string;
  /** 填充层；一层纯色或一层线性渐变。 */
  paints?: Paint[];
  stroke?: string;
  strokeWidth: number;
  radius: number;
  /** 四角互不相同的圆角；省略时四角都等于 `radius`。 */
  radii?: CornerRadii;
  /** 矢量节点的路径命令（归一化坐标，相对 box）。 */
  path?: PathCommand[];
  /** 这个节点是蒙版：不绘制自身，只裁剪同父级里排在它上面的兄弟。 */
  mask?: boolean;
  /** 蒙版边缘羽化半径（px）：蒙版轮廓被模糊，被裁剪的内容在边缘渐隐。 */
  maskFeather?: number;
  /** 蒙版裁剪这个节点的蒙版（按兄弟顺序累积）。 */
  maskedBy?: SceneNode[];
  /** 旋转角（角度制，顺时针为正，绕节点中心）；省略表示不旋转。 */
  rotation?: number;
  /** 投影与图层模糊（只作用于节点自身的绘制）。 */
  shadow?: ShadowSpec;
  blur?: number;
  /** 混合模式：节点与它下面的内容怎么混合。画布侧只支持其中一部分。 */
  blendMode?: BlendMode;
  /** 背景模糊半径（px）：节点后面的内容被模糊，节点自身不模糊。 */
  backgroundBlur?: number;
  text?: SceneText;
  image?: SceneImage;
  children: SceneNode[];
}

/**
 * 构建页面场景。
 *
 * 顺序即绘制顺序：先父后子，同级按 `childIds`。隐藏节点整棵跳过——这与导出和
 * 画布当前行为一致。
 */
export function buildScene(document: DesignDocument, pageId: string, boxes: Record<string, SceneBox | undefined>): SceneNode[] {
  const page = document.pages[pageId];
  if (!page) return [];
  return applySiblingMasks(page.childIds
    .map(id => buildNode(document, document.nodes[id], boxes))
    .filter((node): node is SceneNode => Boolean(node)));
}

/**
 * 按兄弟顺序挂遮罩：蒙版裁剪排在它**上面**的兄弟（Figma 语义），蒙版自身不被遮罩。
 *
 * 页面直属节点和容器子节点用的是同一套规则，所以这里抽出来两边共用——否则页面级的
 * 蒙版会静默失效。
 */
function applySiblingMasks(children: SceneNode[]): SceneNode[] {
  const masks: SceneNode[] = [];
  for (const child of children) {
    if (masks.length) child.maskedBy = [...masks];
    if (child.mask) masks.push(child);
  }
  return children;
}

export function buildNode(document: DesignDocument, node: DesignNode | undefined, boxes: Record<string, SceneBox | undefined>): SceneNode | undefined {
  if (!node || node.visible === false) return undefined;
  const layoutBox = boxes[node.id] ?? { x: node.layout.x ?? 0, y: node.layout.y ?? 0, width: node.layout.width ?? 0, height: node.layout.height ?? 0 };
  // 布尔组的参考框取操作数并集（含旋转）：旋转过的操作数会转出原来的盒子，
  // 按旧盒子归一化会把形状硬拉变形，画布与命中因此都以并集为准。
  const booleanBounds = node.type === "boolean" ? computeBooleanBounds(document, node, boxes) : undefined;
  const box = booleanBounds ?? layoutBox;
  const fills = resolveFills(document, node);
  // 主色：实色取自身、渐变取首个色标。文本颜色与对比度检查只认单一颜色。
  const fill = fills[0]?.type === "solid" ? fills[0].color : fills[0]?.stops[0]?.color;
  const stroke = resolveStroke(document, node);
  const radii = resolveCornerRadii(document, node);
  // 只有真正四角不同才带 `radii`：四角相同的文档继续走单值分支，导出产物不变。
  const perCorner = radii && radii.some(value => value !== radii[0]) ? radii : undefined;
  // 布尔组只画运算结果：几何在读取时按运算树算出来，再归一化到自己的盒子，
  // 这样画布、命中测试、导出都复用 vector 的同一套路径管线。
  const booleanPath = node.type === "boolean" ? computeBooleanGeometry(document, node, boxes, box) : undefined;
  const children = node.type === "boolean" ? [] : applySiblingMasks(node.childIds
    .map(childId => buildNode(document, document.nodes[childId], boxes))
    .filter((child): child is SceneNode => Boolean(child)));
  const scene: SceneNode = {
    id: node.id,
    type: node.type,
    box,
    clip: node.type === "frame" || node.type === "component" || node.type === "instance",
    opacity: node.appearance.opacity ?? 1,
    ...(fill ? { fill } : {}),
    ...(fills.length ? { paints: fills } : {}),
    ...(stroke ? { stroke } : {}),
    // 描边宽度来自外观；缺省 1px，与旧文档和 DOM 默认边框一致。
    strokeWidth: stroke ? (node.appearance.strokeWidth ?? 1) : 0,
    radius: resolveRadius(document, node) ?? 0,
    ...(perCorner ? { radii: perCorner } : {}),
    ...(node.type === "vector" && node.geometry ? { path: vectorPathCommands(node.geometry.d) } : {}),
    ...(booleanPath ? { path: booleanPath } : {}),
    ...(node.mask ? { mask: true } : {}),
    ...(node.maskFeather ? { maskFeather: node.maskFeather } : {}),
    ...(node.layout.rotation ? { rotation: node.layout.rotation } : {}),
    ...(node.appearance.shadow ? { shadow: node.appearance.shadow } : {}),
    ...(node.appearance.blur ? { blur: node.appearance.blur } : {}),
    ...(node.appearance.blendMode && node.appearance.blendMode !== "normal" ? { blendMode: node.appearance.blendMode } : {}),
    ...(node.appearance.backgroundBlur ? { backgroundBlur: node.appearance.backgroundBlur } : {}),
    children,
  };

  if (node.type === "text") {
    // 字体 token 覆盖在场景构建这一层生效：渲染器只认具体字号/族名，
    // 不再回头查文档里的绑定。`applyTypographyToken` 只改文字样式，不改节点类型。
    const text = applyTypographyToken(document, node) as TextNode;
    scene.text = {
      value: text.text,
      fontFamily: text.fontFamily,
      fontSize: text.fontSize,
      lineHeight: text.lineHeight,
      fontWeight: text.fontWeight ?? 400,
      fontStyle: text.fontStyle === "italic" ? "italic" : "normal",
      align: text.textAlign === "center" || text.textAlign === "right" ? text.textAlign : "left",
      letterSpacing: text.letterSpacing ?? 0,
      // 文字色：与 HTML/SVG 共用同一套规则（第一层填充 → 渐变取首个色标 → 默认色）。
      color: textFillColor(document, node),
      ...(text.runs?.length ? { runs: text.runs } : {}),
      ...(text.paragraphStyles?.length ? { paragraphStyles: text.paragraphStyles } : {}),
    };
  }
  if (node.type === "image" && node.assetId) {
    scene.image = { assetId: node.assetId, fit: node.fit === "contain" || node.fit === "fill" ? node.fit : "cover" };
  }
  return scene;
}
