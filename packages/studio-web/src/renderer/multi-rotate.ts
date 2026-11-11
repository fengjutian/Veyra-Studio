import type { DesignDocument, LayoutSpec } from "@ufira/design-schema";
import { boxCenter, normalizeAngle, rotatePoint, snapAngle, toRadians, type Point } from "./rotation";
import { selectionBounds, type Rect } from "./selection";

/**
 * 多选整体旋转（纯函数层）。
 *
 * 旋转是**刚性变换**：整组节点绕同一个枢轴转同一个角度，节点之间的相对位置不变。
 * 这里把「转多少」「绕哪儿转」「转完每个节点在哪儿」三件事拆成纯函数，交互层只负责
 * 把指针位置换算成角度增量。
 *
 * 坐标系说明：盒子是**绝对**坐标（布局引擎解出来的页面坐标），枢轴也在绝对坐标系里。
 * 提交时上层再把绝对坐标换算成相对父级的局部坐标——旋转与移动、缩放必须走同一套
 * 换算，否则嵌套节点会被减两次父级原点。
 */

/** 参与旋转的一个节点：绝对盒 + 当前角度。 */
export interface RotateTarget {
  id: string;
  /** 绝对盒（页面坐标）；旋转不改变尺寸，只改中心。 */
  box: Rect;
  /** 当前旋转角（度，顺时针为正）。 */
  rotation: number;
}

/** 旋转后的一个节点。 */
export interface RotateOutcome {
  id: string;
  /** 新的旋转角（度，已规范到 (-180,180]）。 */
  rotation: number;
  /** 旋转后的中心（绝对坐标）。 */
  center: Point;
  /** 旋转后的绝对盒（尺寸不变，中心换算过）。 */
  box: Rect;
}

/** 拖动过程中的旋转预览：一次手势涉及的所有节点 + 当前角度。 */
export interface RotationPreviewItem {
  id: string;
  /** 新的旋转角（度）。 */
  rotation: number;
  /** 旋转后的绝对盒。 */
  box: Rect;
}

export interface RotationPreview {
  /**
   * 展示用的角度：单选是节点的**绝对**角度，多选是整组的**旋转增量**。
   *
   * 多选没有「组的绝对角度」这回事——每个节点各自存自己的角度，所以只能展示增量。
   */
  angle: number;
  items: RotationPreviewItem[];
}

/**
 * 组旋转的枢轴：选中节点旋转后包围盒的中心。
 *
 * 用「视觉包围盒」而不是轴对齐盒：节点本身已经转过 30° 时，轴对齐盒的中心会偏，
 * 绕它转会让整组在旋转时轻微漂移。
 */
export function groupPivot(boxes: readonly Rect[]): Point | undefined {
  const bounds = selectionBounds([...boxes]);
  return bounds ? boxCenter(bounds) : undefined;
}

/**
 * 刚性旋转：每个节点绕枢轴转同一个角度，自身角度也加上这个增量。
 *
 * 尺寸不变，只有中心在动——这正是刚性变换：形状不变形，位置整体绕枢轴公转。
 */
export function rotateTargets(targets: readonly RotateTarget[], pivot: Point, deltaDegrees: number): RotateOutcome[] {
  const radians = toRadians(deltaDegrees);
  return targets.map(target => {
    const center = rotatePoint(boxCenter(target.box), pivot, radians);
    return {
      id: target.id,
      rotation: normalizeAngle(target.rotation + deltaDegrees),
      center,
      box: {
        x: center.x - target.box.width / 2,
        y: center.y - target.box.height / 2,
        width: target.box.width,
        height: target.box.height,
      },
    };
  });
}

/**
 * Shift 吸附。
 *
 * 单选按**绝对角度**吸附（15° 的整数倍），保持既有单节点旋转的手感；多选按**增量**
 * 吸附——整组必须转同一个角度，否则相对位置会被拉歪，刚性就没了。
 */
export interface RotationRequest {
  /** 参与旋转的节点。 */
  targets: readonly RotateTarget[];
  /** 旋转枢轴（绝对坐标）。 */
  pivot: Point;
  /** 指针当前相对枢轴的极角（度）。 */
  pointerAngle: number;
  /** 按下时指针相对枢轴的极角（度）。 */
  startPointerAngle: number;
  /** 是否按住 Shift 吸附。 */
  snap?: boolean;
  /** 吸附步长（度）。 */
  step?: number;
}

/**
 * 一次旋转手势的完整结果（预览用）。
 *
 * 单选与多选的吸附规则不同，所以合成一个函数而不是散在交互层：吸附是**手感**的一部分，
 * 必须能被单测钉住。
 */
export function planRotation(request: RotationRequest): RotationPreview {
  const { targets, pivot, pointerAngle, startPointerAngle, snap = false, step = 15 } = request;
  const delta = normalizeAngle(pointerAngle - startPointerAngle);
  if (targets.length === 1) {
    const target = targets[0]!;
    // 单选：按绝对角度吸附；枢轴就是自己的中心，所以位置不动。
    const raw = normalizeAngle(target.rotation + delta);
    const rotation = snap ? snapAngle(raw, step) : raw;
    return { angle: rotation, items: [{ id: target.id, rotation, box: target.box }] };
  }
  // 多选：整组刚性旋转，Shift 吸附的是**增量**，相对位置必须保持不变。
  const effective = snap ? snapAngle(delta, step) : delta;
  const outcomes = rotateTargets(targets, pivot, effective);
  return {
    angle: effective,
    items: outcomes.map(outcome => ({ id: outcome.id, rotation: outcome.rotation, box: outcome.box })),
  };
}

/**
 * 画布提交的坐标换算：绝对场景坐标 → 相对父级内容盒的局部坐标。
 *
 * 布局里的 x/y 是**相对父级内容盒**的局部坐标，画布给的却是页面坐标。移动、缩放、
 * 旋转三条提交路径都必须走这一处换算：只要有一条路径传了已经是局部坐标的数值，
 * 就会像旋转早先那样被减两次父级原点，嵌套节点直接跑偏。
 */
export function toParentLocalLayout(layout: LayoutSpec, absolute: { x: number; y: number }, origin: { x: number; y: number }): LayoutSpec {
  return { ...layout, x: absolute.x - origin.x, y: absolute.y - origin.y };
}

/**
 * 旋转后的自动布局重排提示。
 *
 * 布局引擎**按旋转后的视觉包围盒占位**：stack 里的兄弟节点会让开，hug 容器会变大，
 * grid 的自动轨道会变宽。盒子本身的尺寸不变——旋转是绘制时的变换。
 *
 * 绝对定位的父级不受影响（按坐标摆，旋转不改坐标），所以那里没有提示。
 */
export function rotationRelayoutNotice(document: DesignDocument, ids: readonly string[]): string | undefined {
  const automatic = ids.filter(id => {
    const parentId = document.nodes[id]?.parentId;
    const parent = parentId ? document.nodes[parentId] : undefined;
    return Boolean(parent && parent.layout.mode !== "absolute");
  });
  if (!automatic.length) return undefined;
  const grid = automatic.some(id => {
    const parentId = document.nodes[id]?.parentId;
    return document.nodes[parentId ?? ""]?.layout.mode === "grid";
  });
  return grid
    ? "已旋转：父容器是网格，只有自动轨道会按旋转后的包围盒让位，固定轨道不会"
    : "已旋转：父容器是自动布局（stack），兄弟节点已按旋转后的包围盒让位";
}
