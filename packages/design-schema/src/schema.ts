import { z } from "zod";
import { isValidVectorPath } from "./geometry";
import { validateTextRuns } from "./rich-text";
import { validateParagraphStyles } from "./paragraph-styles";

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
]);

const gridCellSchema = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  rowSpan: z.number().int().positive().optional(),
  columnSpan: z.number().int().positive().optional(),
});

const gridSpecSchema = z.object({
  columns: z.array(gridTrackSchema),
  rows: z.array(gridTrackSchema),
  columnGap: nonNegative,
  rowGap: nonNegative,
  cells: z.record(id, gridCellSchema).optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
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
]);

const componentPropertyBindingsSchema = z.object({
  text: z.string().min(1).optional(),
  visible: z.string().min(1).optional(),
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
  propValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
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

export const designDocumentSchema = z.object({
  schemaVersion: z.literal(4),
  id,
  revision: z.number().int().nonnegative(),
  meta: z.object({ name: z.string().min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  pageOrder: z.array(id),
  pages: z.record(id, z.object({ id, name: z.string(), childIds: z.array(id) })),
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
  })).optional(),
  fonts: z.array(z.object({
    family: z.string().min(1),
    assetId: id.optional(),
    weight: z.number().int().min(100).max(900).optional(),
    style: z.enum(["normal", "italic"]).optional(),
  })).optional(),
  tokens: z.record(z.string(), z.object({
    type: z.enum(["color", "number", "string"]),
    value: z.union([z.string(), z.number()]),
  })),
  assets: z.record(id, z.object({
    id,
    hash: z.string().min(1),
    mimeType: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    name: z.string().optional(),
  })),
  migrations: z.array(z.object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    at: z.iso.datetime(),
  })).optional(),
});
