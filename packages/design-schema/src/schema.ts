import { z } from "zod";
import { isValidVectorPath } from "./geometry";
import { validateTextRuns } from "./rich-text";
import { validateParagraphStyles } from "./paragraph-styles";
import { isValidGridAreaName, parseGridAreaTemplate } from "./grid-areas";

const nonNegative = z.number().finite().nonnegative();
const id = z.string().min(1);

/**
 * 原型交互的 schema。
 *
 * 字段大多可选——不是「可省略」，而是「切换事件/动作类型后残留」（见
 * `interactions.ts` 文件头）。因此这里**只校验值的形状**，
 * 语义自洽性（延迟是否合法、动画是否与动作匹配）由 `validateInteraction()` 负责，
 * 在写入命令层调用。
 */
const interactionSchema = z.object({
  eventType: z.enum(["click", "mouse-press", "mouse-over", "mouse-enter", "mouse-leave", "after-delay"]),
  actionType: z.enum(["navigate", "open-overlay", "toggle-overlay", "close-overlay", "prev-screen", "open-url"]),
  delay: nonNegative.optional(),
  destination: id.nullable().optional(),
  preserveScroll: z.boolean().optional(),
  url: z.string().optional(),
  overlayPositionType: z.enum([
    "manual", "center", "top-left", "top-right", "top-center",
    "bottom-left", "bottom-right", "bottom-center",
  ]).optional(),
  overlayPosition: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  closeClickOutside: z.boolean().optional(),
  backgroundOverlay: z.boolean().optional(),
  positionRelativeTo: id.nullable().optional(),
  animation: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("dissolve"),
      duration: nonNegative,
      easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
      way: z.enum(["in", "out"]).optional(),
      offsetEffect: z.boolean().optional(),
      direction: z.enum(["right", "left", "up", "down"]).optional(),
    }),
    z.object({
      type: z.literal("slide"),
      duration: nonNegative,
      easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
      way: z.enum(["in", "out"]),
      direction: z.enum(["right", "left", "up", "down"]),
      offsetEffect: z.boolean(),
    }),
    z.object({
      type: z.literal("push"),
      duration: nonNegative,
      easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
      direction: z.enum(["right", "left", "up", "down"]),
    }),
  ]).optional(),
});

const gridTrackSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), size: nonNegative }),
  // 权重必须为正：0 权重的 fraction 轨道永远分不到空间，等于把这条轨道废了。
  z.object({ type: z.literal("fraction"), weight: z.number().finite().positive() }),
  z.object({ type: z.literal("auto") }),
  z.object({ type: z.literal("min-content") }),
  z.object({ type: z.literal("max-content") }),
  // 最小宽度必须为正：0 会让「可用尺寸 ÷ 最小宽度」变成无穷多条轨道。
  z.object({
    type: z.literal("repeat"),
    mode: z.enum(["auto-fill", "auto-fit"]),
    min: z.number().finite().positive(),
    grow: z.boolean().optional(),
  }),
]);

const gridCellSchema = z.object({
  row: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  rowSpan: z.number().int().positive().optional(),
  columnSpan: z.number().int().positive().optional(),
  area: z.string().min(1).optional(),
}).superRefine((cell, ctx) => {
  if (cell.area !== undefined) {
    // 命名区域与行列号是二选一的定位方式：同时给出时「以谁为准」没有确定答案。
    if (cell.row !== undefined || cell.column !== undefined) {
      ctx.addIssue({ code: "custom", message: "A grid cell cannot give both an area name and row/column" });
    }
    // 区域的外接矩形已经决定了跨度，再写跨度只会和模板打架。
    if (cell.rowSpan !== undefined || cell.columnSpan !== undefined) {
      ctx.addIssue({ code: "custom", message: "A grid cell with an area name cannot also give a span" });
    }
    if (!isValidGridAreaName(cell.area)) {
      ctx.addIssue({ code: "custom", message: `"${cell.area}" is not a valid grid area name`, path: ["area"] });
    }
    return;
  }
  if (cell.row === undefined || cell.column === undefined) {
    ctx.addIssue({ code: "custom", message: "A grid cell must give either an area name or row and column", path: ["row"] });
  }
});

const gridSpecSchema = z.object({
  columns: z.array(gridTrackSchema),
  rows: z.array(gridTrackSchema),
  columnGap: nonNegative,
  rowGap: nonNegative,
  areas: z.array(z.string()).optional(),
  cells: z.record(id, gridCellSchema).optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
}).superRefine((grid, ctx) => {
  const template = parseGridAreaTemplate(grid.areas ?? []);
  if (grid.areas !== undefined) {
    for (const issue of template.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.row === undefined ? ["areas"] : ["areas", issue.row - 1] });
    }
    // 模板与轨道数必须一致：区域画在轨道之外时，「多出来的那一列」到底存不存在
    // 只能靠猜——不如让用户把模板改到和轨道对齐。
    if (template.columns && template.columns !== grid.columns.length) {
      ctx.addIssue({
        code: "custom",
        message: `Grid areas has ${template.columns} columns but there are ${grid.columns.length} column tracks`,
        path: ["areas"],
      });
    }
    if (template.rows && template.rows !== grid.rows.length) {
      ctx.addIssue({
        code: "custom",
        message: `Grid areas has ${template.rows} rows but there are ${grid.rows.length} row tracks`,
        path: ["areas"],
      });
    }
  }
  if (!grid.cells) return;
  for (const [nodeId, cell] of Object.entries(grid.cells)) {
    if (cell.area === undefined) continue;
    if (grid.areas === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Grid cell references area "${cell.area}" but the grid has no areas template`,
        path: ["cells", nodeId, "area"],
      });
      continue;
    }
    if (!template.areas.has(cell.area)) {
      ctx.addIssue({
        code: "custom",
        message: `Grid cell references unknown area "${cell.area}"`,
        path: ["cells", nodeId, "area"],
      });
    }
  }
});

export const layoutSchema = z.object({
  mode: z.enum(["absolute", "stack", "grid"]),
  direction: z.enum(["horizontal", "vertical"]).optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: nonNegative,
  height: nonNegative,
  widthMode: z.enum(["fixed", "fill", "hug"]),
  heightMode: z.enum(["fixed", "fill", "hug"]),
  gap: nonNegative.optional(),
  padding: z.object({ top: nonNegative, right: nonNegative, bottom: nonNegative, left: nonNegative }).optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
  rotation: z.number().finite().optional(),
  grid: gridSpecSchema.optional(),
}).superRefine((layout, ctx) => {
  if (layout.mode === "stack" && !layout.direction) {
    ctx.addIssue({ code: "custom", message: "Stack layout requires a direction", path: ["direction"] });
  }
  // Grid 容器必须给出轨道配置：没有轨道就没有格子，子节点无处可放。
  if (layout.mode === "grid" && !layout.grid) {
    ctx.addIssue({ code: "custom", message: "Grid layout requires a grid configuration", path: ["grid"] });
  }
  // 非 grid 容器不该带 grid 配置——留着会让「这个容器到底怎么排版」变得含糊。
  if (layout.mode !== "grid" && layout.grid) {
    ctx.addIssue({ code: "custom", message: "Grid configuration is only allowed on grid layouts", path: ["grid"] });
  }
});

const shadowSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  blur: nonNegative,
  color: z.string().min(1),
});

const paintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: z.string().min(1) }),
  z.object({
    type: z.literal("linear"),
    angle: z.number().finite(),
    // 少于两个色标画不出渐变。
    stops: z.array(z.object({ offset: z.number().min(0).max(1), color: z.string().min(1) })).min(2),
  }),
  z.object({
    type: z.literal("radial"),
    // 中心可以落在盒子外（负值/大于 1 是有效设计），所以不做范围限制。
    cx: z.number().finite(),
    cy: z.number().finite(),
    // 半径必须是正数：0 或负数的圆什么也画不出来。
    r: z.number().finite().positive(),
    stops: z.array(z.object({ offset: z.number().min(0).max(1), color: z.string().min(1) })).min(2),
  }),
  z.object({
    type: z.literal("elliptical"),
    cx: z.number().finite(),
    cy: z.number().finite(),
    // 两个半轴都必须是正数：0 或负数的半轴画不出椭圆。
    rx: z.number().finite().positive(),
    ry: z.number().finite().positive(),
    // 旋转角（度，顺时针）；缺省 0 = 不旋转。
    angle: z.number().finite().optional(),
    stops: z.array(z.object({ offset: z.number().min(0).max(1), color: z.string().min(1) })).min(2),
  }),
]);

const appearanceSchema = z.object({
  opacity: z.number().min(0).max(1),
  fills: z.array(paintSchema).optional(),
  stroke: z.string().optional(),
  // 缺省按 1px；0 没有意义（画不出线），所以要求为正数。
  strokeWidth: z.number().finite().positive().optional(),
  cornerRadius: nonNegative.optional(),
  cornerRadii: z.tuple([nonNegative, nonNegative, nonNegative, nonNegative]).optional(),
  shadow: shadowSchema.optional(),
  blur: nonNegative.optional(),
  blendMode: z.enum([
    "normal", "multiply", "screen", "overlay", "darken", "lighten",
    "color-dodge", "color-burn", "hard-light", "soft-light",
    "difference", "exclusion", "hue", "saturation", "color", "luminosity",
  ]).optional(),
  backgroundBlur: nonNegative.optional(),
});

/**
 * 矢量几何只接受归一化、只含 M/L/C/Q/Z 的路径。
 *
 * 校验放在这里而不是渲染层：一条含 `A` 的路径如果被放进来，画布会少画一段、
 * 导出会输出另一段，两边悄悄不一致。宁可写入时就拒绝。
 * 在曲线上的点必须在 [0,1]；控制点允许越界（曲线向外鼓时必然如此）。
 */
const vectorGeometrySchema = z.object({
  kind: z.literal("path"),
  d: z.string().min(1).refine(isValidVectorPath, { message: "Vector path must contain only M/L/C/Q/Z, with on-curve points in [0,1]" }),
});

const constraintAxisSchema = z.enum(["start", "end", "center", "stretch", "scale"]);

/**
 * 组件属性的 schema。
 *
 * 判别联合：类型与默认值必须配对，`text` 属性的默认值不能是布尔值。
 */
export const componentPropertySchema = z.discriminatedUnion("type", [
  z.object({ id: id, name: z.string().min(1), type: z.literal("text"), defaultValue: z.string() }),
  z.object({ id: id, name: z.string().min(1), type: z.literal("boolean"), defaultValue: z.boolean() }),
  z.object({ id: id, name: z.string().min(1), type: z.literal("instance-swap"), defaultValue: z.string() }),
  z.object({ id: id, name: z.string().min(1), type: z.literal("color"), defaultValue: z.string() }),
  z.object({ id: id, name: z.string().min(1), type: z.literal("number"), defaultValue: z.number() }),
]);

const componentPropertyBindingsSchema = z.object({
  text: z.string().min(1).optional(),
  visible: z.string().min(1).optional(),
  fill: z.string().min(1).optional(),
  fontSize: z.string().min(1).optional(),
  instance: z.string().min(1).optional(),
});

const baseNodeShape = {
  id,
  name: z.string(),
  parentId: id,
  childIds: z.array(id),
  visible: z.boolean(),
  locked: z.boolean(),
  layout: layoutSchema,
  appearance: appearanceSchema,
  constraints: z.object({ horizontal: constraintAxisSchema, vertical: constraintAxisSchema }).optional(),
  bindings: z.object({
    fill: z.string().optional(),
    stroke: z.string().optional(),
    typography: z.string().optional(),
    spacing: z.string().optional(),
    radius: z.string().optional(),
  }).optional(),
  externalRefs: z.array(z.object({ provider: z.string().min(1), id })).optional(),
  slot: z.boolean().optional(),
  overflow: z.enum(["visible", "hidden", "scroll"]).optional(),
  mask: z.boolean().optional(),
  componentPropertyBindings: componentPropertyBindingsSchema.optional(),
  interactions: z.array(interactionSchema).optional(),
};

const genericNodeShape = { ...baseNodeShape };

const frameNodeSchema = z.object({ ...genericNodeShape, type: z.literal("frame") });
const rectangleNodeSchema = z.object({ ...genericNodeShape, type: z.literal("rectangle") });
const ellipseNodeSchema = z.object({ ...genericNodeShape, type: z.literal("ellipse") });
const vectorNodeSchema = z.object({ ...genericNodeShape, type: z.literal("vector"), geometry: vectorGeometrySchema.optional() });
const componentNodeSchema = z.object({ ...genericNodeShape, type: z.literal("component") });
const booleanNodeSchema = z.object({
  ...genericNodeShape,
  type: z.literal("boolean"),
  operation: z.enum(["union", "subtract", "intersect", "exclude"]),
});

const textRunSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  style: z.object({
    fontWeight: z.number().int().min(100).max(900).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    fontSize: z.number().positive().optional(),
    color: z.string().min(1).optional(),
  }).refine(style => style.fontWeight !== undefined || style.fontStyle !== undefined || style.fontSize !== undefined || style.color !== undefined, {
    message: "Text run style must set at least one field",
  }),
});

const paragraphStyleRunSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  style: z.object({
    listType: z.enum(["bullet", "ordered"]).optional(),
    indent: z.number().int().min(0).max(4).optional(),
    paragraphIndent: z.number().finite().nonnegative().optional(),
    hanging: z.boolean().optional(),
    listSpacing: z.number().finite().nonnegative().optional(),
  }).refine(style => style.listType !== undefined
    || style.indent !== undefined
    || style.paragraphIndent !== undefined
    || style.hanging !== undefined
    || style.listSpacing !== undefined, {
    message: "Paragraph style must set at least one field",
  }),
});

const textNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("text"),
  text: z.string(),
  fontFamily: z.string().min(1),
  fontSize: z.number().positive(),
  lineHeight: z.number().positive(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
  letterSpacing: z.number().finite().optional(),
  runs: z.array(textRunSchema).optional(),
  paragraphStyles: z.array(paragraphStyleRunSchema).optional(),
}).superRefine((node, context) => {
  // 区间与文本的对应关系（越界、重叠、切断代理对）无法用字段级 schema 表达，
  // 交给唯一的校验函数，避免 schema 和命令层各写一套判定。
  const error = validateTextRuns(node.text, node.runs);
  if (error) context.addIssue({ code: "custom", message: error, path: ["runs"] });
  // 段落样式的区间还必须对齐段落边界（`\n` 切出的段），同样交给唯一入口判定。
  const paragraphError = validateParagraphStyles(node.text, node.paragraphStyles);
  if (paragraphError) context.addIssue({ code: "custom", message: paragraphError, path: ["paragraphStyles"] });
});

const imageNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("image"),
  assetId: id,
  fit: z.enum(["cover", "contain", "fill"]),
});

const instanceNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("instance"),
  componentId: id,
  overrides: z.record(z.string(), z.unknown()),
  propValues: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
});

// 判别联合按 type 选分支，报错会直接落到出问题的字段上；
// 普通 z.union 会把分支错误吞成一句 "Invalid input"，无法定位。
export const designNodeSchema = z.discriminatedUnion("type", [
  frameNodeSchema,
  rectangleNodeSchema,
  ellipseNodeSchema,
  vectorNodeSchema,
  componentNodeSchema,
  booleanNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  instanceNodeSchema,
]);

/** 一个 token 的值；主题覆盖与基础 token 共用同一份形状。 */
const tokenValueSchema = z.union([
  z.object({
    type: z.enum(["color", "number", "string"]),
    value: z.union([z.string(), z.number()]),
  }),
  z.object({
    type: z.literal("typography"),
    value: z.object({
      fontFamily: z.string().min(1),
      // 字号必须为正：0 会让文本测量退化成 0 宽、0 高。
      fontSize: z.number().finite().positive(),
      lineHeight: z.number().finite().nonnegative().optional(),
      fontWeight: z.number().int().min(100).max(900).optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      letterSpacing: z.number().finite().optional(),
    }),
  }),
  // 别名：值是被引用的 token 名；目标存在性与环由 `validateDocument()` 检查。
  z.object({ type: z.literal("alias"), value: z.string().min(1) }),
]);

export const designDocumentSchema = z.object({
  schemaVersion: z.literal(4),
  id,
  revision: z.number().int().nonnegative(),
  meta: z.object({ name: z.string().min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  pageOrder: z.array(id),
  pages: z.record(id, z.object({
    id,
    name: z.string(),
    childIds: z.array(id),
    width: z.number().int().min(64).max(8192).optional(),
    height: z.number().int().min(64).max(8192).optional(),
    themeId: z.string().min(1).optional(),
  })),
  nodes: z.record(id, designNodeSchema),
  components: z.record(id, z.object({
    id,
    name: z.string(),
    rootNodeId: id,
    variantSetId: id.optional(),
    variant: z.record(z.string().min(1), z.string().min(1)).optional(),
    properties: z.array(componentPropertySchema).optional(),
  })),
  componentSets: z.record(id, z.object({
    id,
    name: z.string(),
    properties: z.array(z.string().min(1)).min(1),
    // 变体集共享的组件属性声明；可选，旧集合没有它也完全合法。
    componentProperties: z.array(componentPropertySchema).optional(),
  })).optional(),
  fonts: z.array(z.object({
    family: z.string().min(1),
    assetId: id.optional(),
    weight: z.number().int().min(100).max(900).optional(),
    style: z.enum(["normal", "italic"]).optional(),
  })).optional(),
  tokens: z.record(z.string(), tokenValueSchema),
  // 主题：只覆盖已存在的 token 值；名字/目标存在性由 `validateDocument()` 检查。
  themes: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    // 继承自另一个主题；父主题存在性与成环由 `validateDocument()` 检查。
    extends: z.string().min(1).optional(),
    tokens: z.record(z.string(), tokenValueSchema),
    // 节点名 → 属性覆盖；只影响节点自身字段（圆角、间距等），不影响 token 解析。
    properties: z.record(z.string(), z.object({
      type: z.enum(["frame", "text", "image", "rectangle", "ellipse", "vector", "component", "instance", "boolean"]).optional(),
      cornerRadius: nonNegative.optional(),
      gap: nonNegative.optional(),
      padding: nonNegative.optional(),
      fontSize: z.number().finite().positive().optional(),
      opacity: z.number().finite().min(0).max(1).optional(),
    })).optional(),
  })).optional(),
  // 分组元数据：只影响面板显示，不影响解析与导出。
  tokenGroups: z.array(z.object({
    id: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    order: z.number().optional(),
  })).optional(),
  assets: z.record(id, z.object({
    id,
    hash: z.string().min(1),
    mimeType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    name: z.string().optional(),
    // 来源/授权全部可选：不知道就不填，不能因为缺元数据让旧文档变得不合法。
    origin: z.object({
      source: z.string().optional(),
      author: z.string().optional(),
      license: z.string().optional(),
      note: z.string().optional(),
    }).optional(),
    // 外部素材服务：provider + providerAssetId 构成缓存键。
    external: z.object({
      provider: z.string().min(1),
      providerAssetId: z.string().min(1),
      fetchedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().optional(),
    }).optional(),
  })),
  migrations: z.array(z.object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    at: z.iso.datetime(),
  })).optional(),
});
