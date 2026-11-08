import { z } from "zod";
import { isValidVectorPath } from "./geometry";

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

export const layoutSchema = z.object({
  mode: z.enum(["absolute", "stack"]),
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
}).superRefine((layout, ctx) => {
  if (layout.mode === "stack" && !layout.direction) {
    ctx.addIssue({ code: "custom", message: "Stack layout requires a direction", path: ["direction"] });
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
  interactions: z.array(interactionSchema).optional(),
};

const genericNodeShape = { ...baseNodeShape };

const frameNodeSchema = z.object({ ...genericNodeShape, type: z.literal("frame") });
const rectangleNodeSchema = z.object({ ...genericNodeShape, type: z.literal("rectangle") });
const ellipseNodeSchema = z.object({ ...genericNodeShape, type: z.literal("ellipse") });
const vectorNodeSchema = z.object({ ...genericNodeShape, type: z.literal("vector"), geometry: vectorGeometrySchema.optional() });
const componentNodeSchema = z.object({ ...genericNodeShape, type: z.literal("component") });

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
});

// 判别联合按 type 选分支，报错会直接落到出问题的字段上；
// 普通 z.union 会把分支错误吞成一句 "Invalid input"，无法定位。
export const designNodeSchema = z.discriminatedUnion("type", [
  frameNodeSchema,
  rectangleNodeSchema,
  ellipseNodeSchema,
  vectorNodeSchema,
  componentNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  instanceNodeSchema,
]);

export const designDocumentSchema = z.object({
  schemaVersion: z.literal(3),
  id,
  revision: z.number().int().nonnegative(),
  meta: z.object({ name: z.string().min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  pageOrder: z.array(id),
  pages: z.record(id, z.object({ id, name: z.string(), childIds: z.array(id) })),
  nodes: z.record(id, designNodeSchema),
  components: z.record(id, z.object({ id, name: z.string(), rootNodeId: id })),
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
