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
  | "interactive-without-name"
  /** 同级的两个文本框互相压住了——文字会叠在一起。 */
  | "text-overlap"
  /** 节点超出了它所在页面的画布——导出/截图时会被裁掉。 */
  | "out-of-bounds"
  /** 同级的两个容器互相压住了。 */
  | "frame-overlap"
  /** 子节点跑出了它所在的父容器。 */
  | "out-of-parent";

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
  /** 文本框重叠到多少才算叠在一起（px²）；缺省 36。设 0 表示只要有重叠就报。 */
  textOverlapArea?: number;
  /** 容器重叠到多少才算压住（px²）；缺省 400。 */
  frameOverlapArea?: number;
  /** 越出画布时允许多少像素（px）；缺省 2。 */
  outOfBoundsTolerance?: number;
  /** 文本节点超出父容器的容差（px）；缺省 24。 */
  textOverflowTolerance?: number;
  /** 可读字号下限（px）；缺省 12。 */
  minReadableFontSize?: number;
  /** 尺寸达到父容器多少比例算「背景层」（0~1）；缺省 0.9。 */
  backgroundSizeRatio?: number;
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
 * 文本框重叠到多少才算「叠在一起」。
 *
 * 取 36px²（6×6）：相邻的两行文字框本来就挨着，边角压上几个像素是正常的；
 * 真正叠字的时候，重叠面积往往是几百上千平方像素。
 */
const TEXT_OVERLAP_AREA = 36;

/**
 * 节点越出画布时允许多少像素。
 *
 * 给 2px 余量：边框宽度、浮点坐标、以及「差一像素刚好贴边」的正常布局都不该报。
 */
const OUT_OF_BOUNDS_TOLERANCE = 2;

/**
 * 文本节点超出父容器的容差（px）。
 *
 * 比容器宽松：模型常给同一列的文本统一宽度，框比字宽一点甚至宽出十几像素很常见，
 * **文字本身并没有掉出卡片**，视觉上看不出来。容器（卡片、按钮、输入框）超出则是真错，
 * 用 2px 的严容差。
 */
const TEXT_OVERFLOW_TOLERANCE = 24;

/**
 * 容器重叠到多少才算「压住」。
 *
 * 取 400px²（约 20×20）：两张卡片边角相切、或者一张小图标块压在卡片边上都不算；
 * 真正压住时，重叠面积往往是几百上千平方像素（实测整张卡片被盖住一半）。
 */
const FRAME_OVERLAP_AREA = 400;

/**
 * 背景层判定：尺寸达到父容器多少比例就算「铺满」。
 *
 * 背景层和内容层本来就叠在一起——登录页的整页背景里就放着登录卡片，这不是错。
 */
const BACKGROUND_SIZE_RATIO = 0.9;

/** lint 的判定阈值。默认值保持原样，只是搬到了可配置的地方。 */
interface LintLimits {
  textOverlapArea: number;
  frameOverlapArea: number;
  outOfBoundsTolerance: number;
  textOverflowTolerance: number;
  minReadableFontSize: number;
  backgroundSizeRatio: number;
}

function resolveLimits(options: LintOptions): LintLimits {
  return {
    textOverlapArea: options.textOverlapArea ?? TEXT_OVERLAP_AREA,
    frameOverlapArea: options.frameOverlapArea ?? FRAME_OVERLAP_AREA,
    outOfBoundsTolerance: options.outOfBoundsTolerance ?? OUT_OF_BOUNDS_TOLERANCE,
    textOverflowTolerance: options.textOverflowTolerance ?? TEXT_OVERFLOW_TOLERANCE,
    minReadableFontSize: options.minReadableFontSize ?? MIN_READABLE_FONT_SIZE,
    backgroundSizeRatio: options.backgroundSizeRatio ?? BACKGROUND_SIZE_RATIO,
  };
}

/** 能装子节点的容器类型——只有这些之间互相压住才算错。 */
const CONTAINER_TYPES = new Set(["frame", "instance", "boolean"]);

/** 两个节点的外接矩形重叠面积（平方像素）。不重叠时返回 0。 */
function overlapArea(left: DesignNode, right: DesignNode): number {
  const width = Math.min(left.layout.x + left.layout.width, right.layout.x + right.layout.width) - Math.max(left.layout.x, right.layout.x);
  const height = Math.min(left.layout.y + left.layout.height, right.layout.y + right.layout.height) - Math.max(left.layout.y, right.layout.y);
  if (width <= 0 || height <= 0) return 0;
  // hug 尺寸的框宽高可能还是 0，算出来的面积没意义。
  if (left.layout.width <= 0 || left.layout.height <= 0 || right.layout.width <= 0 || right.layout.height <= 0) return 0;
  return width * height;
}

/**
 * 两个容器压住了，给出**可以直接照做的**重排方案。
 *
 * 只说「它们压住了」模型是改不对的——它看不到这一行的几何关系，只能瞎挪，
 * 实测连挪三次都压着别的元素（把按钮塞进搜索框的位置、把按钮和下拉框叠在一起）。
 *
 * 这里给的是**整行的排布结果**：这一行每个容器应该放在哪个 x。
 * 放不下时明确告诉它「哪一行总宽超了容器多少、该把哪个改窄」，
 * 剩下的按顺序排开即可。
 */
function describeOverlapFix(left: DesignNode, right: DesignNode, siblings: DesignNode[], parentWidth: number): string {
  const gap = 16;
  const containers = siblings
    .filter(sibling => CONTAINER_TYPES.has(sibling.type))
    .sort((a, b) => a.layout.x - b.layout.x);
  if (!containers.length) return "";
  const start = containers[0]!.layout.x;
  const totalWidth = containers.reduce((sum, sibling) => sum + sibling.layout.width, 0);
  const available = parentWidth - start * 2;
  const needed = totalWidth + gap * Math.max(0, containers.length - 1);
  if (needed > available) {
    const widest = containers.slice().sort((a, b) => b.layout.width - a.layout.width)[0]!;
    const shrink = needed - available;
    return (
      `这一行的 ${containers.length} 个元素总宽 ${Math.round(totalWidth)}px，加上间距要 ${Math.round(needed)}px，` +
      `放不进 ${Math.round(available)}px 的容器——先把 ${widest.id} 的宽度改到 ${Math.max(80, Math.round(widest.layout.width - shrink))}px，` +
      `再按 x 从小到大顺序排开、间距 16px。`
    );
  }
  let cursor = start;
  const plan = containers.map(sibling => {
    const x = Math.round(cursor);
    cursor += sibling.layout.width + gap;
    return `${sibling.id} 的 x 改成 ${x}`;
  });
  return `这一行按 x 从小到大顺序排开、间距 16px：${plan.join("，")}。`;
}

/**
 * 这个节点是不是「铺满父级」的背景层。
 *
 * 背景层和内容层本来就叠在一起——登录页的整页背景里就放着登录卡片，
 * 这不是错。所以判断容器重叠时，尺寸接近父容器的那些要跳过。
 *
 * 根节点的父级是**页面**（页面不是 DesignNode），这时拿页面尺寸当父容器尺寸。
 */
function isBackgroundLike(
  node: DesignNode,
  parent: { layout: { width: number; height: number } } | undefined,
  ratio = BACKGROUND_SIZE_RATIO,
): boolean {
  if (!parent) return false;
  if (parent.layout.width <= 0 || parent.layout.height <= 0) return false;
  return node.layout.width >= parent.layout.width * ratio && node.layout.height >= parent.layout.height * ratio;
}

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
  const limits = resolveLimits(options);
  const issues: LintIssue[] = [];
  const hasColorTokens = hasTokenOfType(document, "color");
  const hasNumberTokens = hasTokenOfType(document, "number");
  /** 节点属于哪一页——跨页面规则要用。 */
  const pageOfNode = new Map<NodeId, PageId>();

  /**
   * 递归遍历一个节点。
   *
   * `origin` 是当前节点**相对页面**的绝对坐标；为 null 表示坐标不可信
   * （祖先里有一层是 stack / grid，子节点的位置由布局引擎算，写在 layout 里的是 0）。
   * 越界检查只在坐标可信时才做得。
   *
   * `ancestorOut` 表示祖先里已经有节点越界了。越界的根因几乎总是**最外层那个
   * 超尺寸的容器**——把它挪好，里面的子节点跟着就好了。只报根因，结论数量能从
   * 几十条收敛到几条，模型一轮就修得完。
   */
  const visit = (
    nodeId: NodeId,
    siblings: DesignNode[],
    parent: DesignNode | undefined,
    pageId: PageId,
    origin: { x: number; y: number } | null,
    ancestorOut: boolean,
  ): void => {
    const node = document.nodes[nodeId];
    if (!node) return;
    pageOfNode.set(node.id, pageId);
    const page = document.pages[pageId];
    /**
     * 同级节点**共同的**父容器：根节点时是页面（页面不是 DesignNode，用它的尺寸）。
     * frame-overlap 比较的是同级节点，用它。
     */
    const siblingParentBox = parent ?? (page ? { layout: { width: page.width ?? 0, height: page.height ?? 0 } } : undefined);
    /**
     * `parent` **自己**的父容器：判断 parent 是不是「铺满上一级」的背景层要用它。
     *
     * 这两个不能混：混了的话每个节点都会拿自己去比自己的尺寸，于是人人都是背景层，
     * 越界与重叠的结论会全部消失（踩过一次：out-of-parent 一条都没报）。
     */
    const parentBox = parent
      ? (document.nodes[parent.parentId]
        ? { layout: { width: document.nodes[parent.parentId]!.layout.width, height: document.nodes[parent.parentId]!.layout.height } }
        : (page ? { layout: { width: page.width ?? 0, height: page.height ?? 0 } } : undefined))
      : undefined;

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

    // 文本互相重叠：同一父节点下两个文本框压在一起，文字就会叠着显示。
    //
    // 这条是实测出来的：AI 生成整页计划时经常把两行文字塞进高度不够的框里，
    // 渲染出来就是「名字和邮箱叠成两行」。别的规则都查不出来——每一行单独看
    // 都合法（字号正常、位置在栅格上、内容非空），只有**两个框叠在一起**才是问题。
    if (enabled(options, "text-overlap") && node.type === "text" && node.text.trim()) {
      const clash = siblings.find(sibling =>
        sibling.id !== node.id
        && sibling.type === "text"
        && sibling.text.trim()
        && overlapArea(node, sibling) > limits.textOverlapArea
        && sibling.id > node.id,
      );
      if (clash) {
        issues.push({
          code: "text-overlap",
          severity: "warning",
          nodeId: node.id,
          message: `${node.id} 和 ${clash.id} 的文本框重叠在一起，文字会叠着显示`,
          detail: `重叠 ${Math.round(overlapArea(node, clash))}px²`,
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
    if (enabled(options, "tiny-text") && node.type === "text" && node.text.trim() && node.fontSize < limits.minReadableFontSize) {
      issues.push({
        code: "tiny-text",
        severity: "warning",
        nodeId: node.id,
        message: `${node.id} 的字号 ${node.fontSize}px 低于可读下限 ${limits.minReadableFontSize}px`,
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

    // 节点超出页面画布：导出与截图都会把它裁掉，底部按钮条被切掉一半就是这种。
    //
    // 这条是实测出来的：模型把内容区排得比画布高，页面底部的东西（「取消 / 保存」
    // 那一行）落在 900 之外，截图上只看得见半条。别的规则都查不出来——
    // 每个节点单独看都合法（位置在栅格上、尺寸正常），只有**相对整页画布**才知道越界了。
    //
    // `outOfBounds` 算出来后要传给子节点：祖先越界时，子节点是被牵连的，不重复报。
    let outOfBounds = false;
    if (origin) {
      const absX = origin.x + node.layout.x;
      const absY = origin.y + node.layout.y;
      const width = node.layout.width;
      const height = node.layout.height;
      if (page?.width && page.height) {
        const over: string[] = [];
        if (absX < -limits.outOfBoundsTolerance) over.push(`左边超出 ${Math.round(-absX)}px`);
        if (absY < -limits.outOfBoundsTolerance) over.push(`上边超出 ${Math.round(-absY)}px`);
        if (absX + width > page.width + limits.outOfBoundsTolerance) over.push(`右边超出 ${Math.round(absX + width - page.width)}px`);
        if (absY + height > page.height + limits.outOfBoundsTolerance) over.push(`下边超出 ${Math.round(absY + height - page.height)}px`);
        outOfBounds = over.length > 0;
        if (outOfBounds && !ancestorOut && enabled(options, "out-of-bounds")) {
          issues.push({
            code: "out-of-bounds",
            severity: "warning",
            nodeId: node.id,
            message: `${node.id} 超出了页面 ${pageId} 的画布`,
            detail: over.join("，"),
          });
        }
      }
    }

    // 容器互相压住：一张卡片盖住另一张，最难看的错法之一。
    //
    // 实测出来的：新建订单页的「收货信息」卡片被下面的「支付方式」卡片盖掉了半张。
    // 文本重叠规则查不出来——压住的是两张卡片，文字框本身没有互相压。
    //
    // 铺满父级的**背景层**不算错（登录页的整页背景和中间的登录卡片本来就叠着），
    // 因此尺寸接近父容器的那种一律跳过。
    if (enabled(options, "frame-overlap") && CONTAINER_TYPES.has(node.type) && !isBackgroundLike(node, siblingParentBox, limits.backgroundSizeRatio)) {
      const clash = siblings.find(sibling =>
        sibling.id !== node.id
        && CONTAINER_TYPES.has(sibling.type)
        && !isBackgroundLike(sibling, siblingParentBox, limits.backgroundSizeRatio)
        && overlapArea(node, sibling) > limits.frameOverlapArea
        && sibling.id > node.id,
      );
      if (clash) {
        issues.push({
          code: "frame-overlap",
          severity: "warning",
          nodeId: node.id,
          message: `${node.id} 和 ${clash.id} 这两个容器互相压住了`,
          detail: `重叠 ${Math.round(overlapArea(node, clash))}px²。${describeOverlapFix(node, clash, siblings, parent?.layout.width ?? 0)}`,
        });
      }
    }

    // 子节点跑出父容器：文字掉到卡片外面、输入框探出卡片右边。
    //
    // 实测出来的：模型把卡片改窄（1032 → 824）以解决「超出画布」，却**没动里面的子节点**——
    // 子节点还是原来那个 x，于是文字跑出卡片 184px。改父不改子，边界就破了。
    //
    // 背景层（铺满父级的那种）不算：它里面的东西随便放。
    if (enabled(options, "out-of-parent") && parent && parent.layout.mode === "absolute"
      && CONTAINER_TYPES.has(parent.type)
      && !isBackgroundLike(node, parent, limits.backgroundSizeRatio)
      && !isBackgroundLike(parent, parentBox, limits.backgroundSizeRatio)) {
      const tolerance = node.type === "text" ? limits.textOverflowTolerance : limits.outOfBoundsTolerance;
      const over: string[] = [];
      if (node.layout.x < -tolerance) over.push(`左边超出 ${Math.round(-node.layout.x)}px`);
      if (node.layout.y < -tolerance) over.push(`上边超出 ${Math.round(-node.layout.y)}px`);
      if (node.layout.x + node.layout.width > parent.layout.width + tolerance) {
        over.push(`右边超出 ${Math.round(node.layout.x + node.layout.width - parent.layout.width)}px`);
      }
      if (node.layout.y + node.layout.height > parent.layout.height + tolerance) {
        over.push(`下边超出 ${Math.round(node.layout.y + node.layout.height - parent.layout.height)}px`);
      }
      if (over.length) {
        issues.push({
          code: "out-of-parent",
          severity: "warning",
          nodeId: node.id,
          message: `${node.id} 跑出了父容器 ${parent.id}`,
          detail: over.join("，"),
        });
      }
    }

    const children = node.childIds.map(id => document.nodes[id]).filter((child): child is DesignNode => Boolean(child));
    const childOrigin = origin && node.layout.mode === "absolute"
      ? { x: origin.x + node.layout.x, y: origin.y + node.layout.y }
      : null;
    for (const childId of node.childIds) visit(childId, children, node, pageId, childOrigin, ancestorOut || outOfBounds);
  };

  // 每个页面单独处理：根节点之间互为同级，跨页不算同级（否则同名页面会互相误报）。
  for (const pageId of document.pageOrder) {
    const roots = (document.pages[pageId]?.childIds ?? [])
      .map(id => document.nodes[id])
      .filter((node): node is DesignNode => Boolean(node));
    for (const rootId of document.pages[pageId]?.childIds ?? []) visit(rootId, roots, undefined, pageId, { x: 0, y: 0 }, false);
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
  "text-overlap": "文本互相重叠",
  "out-of-bounds": "超出画布",
  "frame-overlap": "容器互相压住",
  "out-of-parent": "跑出父容器",
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
  "text-overlap",
  "out-of-bounds",
  "frame-overlap",
  "out-of-parent",
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
