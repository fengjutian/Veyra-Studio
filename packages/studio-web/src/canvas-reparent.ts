import type { DesignCommand } from "@ufira/design-runtime";
import type { DesignDocument, DesignNode } from "@ufira/design-schema";
import type { SceneBox, SceneNode } from "./renderer/scene";

/**
 * 画布上的跨容器拖拽（把节点拖进另一个容器）。
 *
 * 图层面板的跨容器拖拽早就有了（`layer-reorder.ts` 的 `planReparent`），画布上却是
 * 另一回事：画布拖动只改坐标，节点永远留在原来的父级里。这个模块补上画布这条
 * 路径，并且把**约束**集中在一处：
 *
 * - 不能把节点拖进它自己的子级里（会形成环）；
 * - 不能拖进自动布局容器（stack / grid）——那里子节点的位置由布局引擎决定，
 *   拖进去的坐标会被忽略，看起来就是「跳回去了」。这类操作请到图层面板里改顺序；
 * - 不能拖进不能容纳子节点的节点（文本、图片这类叶子节点）；
 * - 不能拖进隐藏或锁定的容器；
 * - 多选时整组一起搬，父子同时被选中时只搬顶层那个。
 *
 * 这个模块是**纯逻辑**：输入文档、拖动结果与落点，输出命令或拒绝原因。
 * 画布只负责命中测试与画高亮，命令怎么落地由运行时决定。
 */

/** 容器能容纳子节点吗。 */
export function canHostChildren(node: { type: string }): boolean {
  return node.type === "frame" || node.type === "component" || node.type === "instance";
}

/** 页面 id 还是节点 id。 */
function isPageId(document: DesignDocument, id: string): boolean {
  return Boolean(document.pages[id]);
}

/**
 * 命中的节点往上找，找到最近的那个能容纳子节点的祖先。
 *
 * 命中的本身就是容器时返回它自己（拖进容器内部）；命中的是叶子节点时返回它的
 * 容器祖先；命中的是页面或找不到时返回 `undefined`（表示落在页面层）。
 */
export function dropContainerFor(document: DesignDocument, hitNodeId: string | undefined): string | undefined {
  if (!hitNodeId) return undefined;
  let current: DesignNode | undefined = document.nodes[hitNodeId];
  while (current) {
    if (canHostChildren(current)) return current.id;
    current = current.parentId ? document.nodes[current.parentId] : undefined;
  }
  return undefined;
}

/** 一次跨容器拖拽的落点判定结果。 */
export type CanvasReparentPlan =
  | { ok: true; commands: DesignCommand[]; containerId: string; containerIsPage: boolean }
  | { ok: false; reason: string; containerId?: string };

export interface CanvasReparentRequest {
  document: DesignDocument;
  /** 被拖动的节点 id（顶层节点即可；父子同时被选中时只保留顶层）。 */
  draggedIds: string[];
  /** 落点容器 id（页面 id 或容器节点 id）。 */
  containerId: string;
  /** 拖动后各节点在**页面坐标系**里的位置（左上角）。 */
  boxes: Record<string, { x: number; y: number }>;
  /** 新父级内容盒原点在页面坐标系里的位置；页面层用 `{ x: 0, y: 0 }`。 */
  containerOrigin: { x: number; y: number };
}

/** 去掉被别的选中节点包含的节点（父子同时被选中时只搬顶层）。 */
export function topLevelDraggedIds(document: DesignDocument, draggedIds: string[]): string[] {
  const selected = new Set(draggedIds);
  return draggedIds.filter(id => {
    let parentId = document.nodes[id]?.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = document.nodes[parentId]?.parentId;
    }
    return true;
  });
}

/** 容器是否用自动布局（stack / grid）——那种容器里子节点位置不由坐标决定。 */
function isAutoLayoutContainer(node: DesignNode): boolean {
  return node.layout.mode === "stack" || node.layout.mode === "grid";
}

/**
 * 判定一次画布拖放，并给出要执行的命令。
 *
 * 命令是「先 reparent 再 patch 坐标」——顺序有意义：坐标 patch 写的是**新父级**
 * 的局部坐标，如果 reparent 还没生效，patch 会被解释成旧父级的坐标。
 */
export function planCanvasReparent(request: CanvasReparentRequest): CanvasReparentPlan {
  const { document, containerId } = request;
  const containerIsPage = isPageId(document, containerId);
  const container = containerIsPage ? undefined : document.nodes[containerId];

  if (!containerIsPage && !container) {
    return { ok: false, reason: "落点不是有效的容器", containerId };
  }
  if (container && !canHostChildren(container)) {
    return { ok: false, reason: "这个节点不能容纳子节点", containerId };
  }
  if (container?.visible === false) {
    return { ok: false, reason: "容器是隐藏的，放不进去", containerId };
  }
  if (container?.locked) {
    return { ok: false, reason: "容器已锁定，放不进去", containerId };
  }
  if (container && isAutoLayoutContainer(container)) {
    // 自动布局容器里子节点的位置由布局引擎算，拖进去的坐标会被忽略——
    // 与其让节点「跳回去」，不如在这里说清楚该怎么做。
    return { ok: false, reason: "自动布局容器由布局决定位置，请在图层面板里调整顺序", containerId };
  }

  const dragged = topLevelDraggedIds(document, request.draggedIds);
  if (!dragged.length) return { ok: false, reason: "没有可移动的节点", containerId };

  for (const id of dragged) {
    const node = document.nodes[id];
    if (!node) return { ok: false, reason: "节点已不存在", containerId };
    // 不能拖进自己的子树：会造成环，运行时也会拒绝，但这里给出人话。
    if (id === containerId || isDescendantOf(document, id, containerId)) {
      return { ok: false, reason: "不能把节点放进它自己的子级里", containerId };
    }
  }

  const commands: DesignCommand[] = [];
  for (const id of dragged) {
    const node = document.nodes[id]!;
    if (node.parentId !== containerId) {
      commands.push({ type: "node.reparent", payload: { id, parentId: containerId } });
    }
    const box = request.boxes[id];
    if (!box) continue;
    // 坐标换算到新父级的局部坐标：布局里的 x/y 是相对父级内容盒的。
    commands.push({
      type: "node.patch",
      payload: {
        id,
        patch: { layout: { ...node.layout, x: box.x - request.containerOrigin.x, y: box.y - request.containerOrigin.y } },
      },
    });
  }
  // 搬空之后的空编组要删掉：它的存在意义就是把那几个节点聚在一起。
  //
  // 判据是「**这次拖放搬走了它的最后一个子节点**」，不是「它现在没有子节点」——
  // 后者会把用户自己建的空 frame 也删掉。用户要留空 frame，就不会有子节点被搬走。
  for (const parentId of emptiedParents(document, dragged, containerId)) {
    commands.push({ type: "node.delete", payload: { id: parentId } });
  }
  return { ok: true, commands, containerId, containerIsPage };
}

/**
 * 这次搬运会掏空的父级。
 *
 * 「掏空」= 搬走之后它一个子节点都不剩（被搬走的不算还在里面）。
 * 页面不算：页面不会因为孩子被搬走而消失。
 */
export function emptiedParents(document: DesignDocument, draggedIds: string[], containerId: string): string[] {
  const moved = new Set(draggedIds);
  const emptied = new Set<string>();
  for (const id of draggedIds) {
    const node = document.nodes[id];
    const parentId = node?.parentId;
    if (!node || !parentId || parentId === containerId) continue;
    if (document.pages[parentId]) continue;
    const parent = document.nodes[parentId];
    if (!parent) continue;
    const remaining = parent.childIds.filter(childId => childId !== id && !moved.has(childId));
    if (!remaining.length) emptied.add(parentId);
  }
  return [...emptied];
}

/** `candidate` 是否在 `ancestor` 的子树里。 */
export function isDescendantOf(document: DesignDocument, ancestor: string, candidate: string): boolean {
  const node = document.nodes[ancestor];
  if (!node) return false;
  return node.childIds.some(childId => childId === candidate || isDescendantOf(document, childId, candidate));
}

/**
 * 被拖节点的预览包围盒中心。
 *
 * 用它判定落点容器：节点本身跟着指针走，指针永远在节点上，靠指针判定只会命中
 * 自己；节点的**中心**进入另一个容器，才是「放进去了」的直观含义。
 */
export function previewCenter(boxes: SceneBox[], point?: { x: number; y: number }): { x: number; y: number } | undefined {
  if (!boxes.length) return undefined;
  const minX = Math.min(...boxes.map(box => box.x));
  const minY = Math.min(...boxes.map(box => box.y));
  const maxX = Math.max(...boxes.map(box => box.x + box.width));
  const maxY = Math.max(...boxes.map(box => box.y + box.height));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** 点是否在盒子内。 */
function containsPoint(box: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

/** 在场景树里找某个节点的盒子（页面坐标系）。 */
export function findSceneBox(scene: SceneNode[], id: string): SceneBox | undefined {
  for (const node of scene) {
    if (node.id === id) return node.box;
    const found = findSceneBox(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * 父级**内容盒**原点在页面坐标系里的位置。
 *
 * 布局里的 x/y 是相对父级内容盒的局部坐标，所以任何页面坐标都要减掉这个原点
 * 才能写回布局。页面层的原点是 (0,0)；容器还要加上自己的 padding。
 */
export function parentContentOrigin(
  document: DesignDocument,
  scene: SceneNode[],
  parentId: string | undefined,
): { x: number; y: number } {
  if (!parentId) return { x: 0, y: 0 };
  if (document.pages[parentId]) return { x: 0, y: 0 };
  const box = findSceneBox(scene, parentId);
  if (!box) return { x: 0, y: 0 };
  const padding = document.nodes[parentId]?.layout.padding;
  return { x: box.x + (padding?.left ?? 0), y: box.y + (padding?.top ?? 0) };
}

/**
 * 在画布场景里找**包含某个点**的最深容器。
 *
 * 用来判定「这次拖放会不会落进某个容器」：被拖动的节点（及其子树）整体排除——
 * 否则节点会命中自己，永远找不到真正的落点。找不到容器就是落在页面层。
 *
 * 这里用**几何**判定而不是命中测试：命中测试问的是「点在谁上面」，而拖放要问的是
 * 「节点最终被放进谁里面」，后者是包含关系。
 */
export function findDropContainerInScene(
  scene: SceneNode[],
  point: { x: number; y: number },
  excludedIds: ReadonlySet<string>,
): string | undefined {
  const visit = (nodes: SceneNode[]): string | undefined => {
    for (const node of nodes) {
      // 被拖动的节点连同整棵子树都不参与判定。
      if (excludedIds.has(node.id)) continue;
      if (canHostChildren(node) && containsPoint(node.box, point)) {
        // 更深的容器优先：先看子节点里有没有更合适的落点。
        return visit(node.children) ?? node.id;
      }
      const deeper = visit(node.children);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return visit(scene);
}
