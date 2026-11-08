import { z } from "zod";
import { isValidVectorPath } from "./geometry";

const nonNegative = z.number().finite().nonnegative();
const id = z.string().min(1);

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
