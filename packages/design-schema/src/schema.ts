import { z } from "zod";

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
}).superRefine((layout, ctx) => {
  if (layout.mode === "stack" && !layout.direction) {
    ctx.addIssue({ code: "custom", message: "Stack layout requires a direction", path: ["direction"] });
  }
});

const appearanceSchema = z.object({
  opacity: z.number().min(0).max(1),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  cornerRadius: nonNegative.optional(),
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
  bindings: z.object({
    fill: z.string().optional(),
    stroke: z.string().optional(),
    typography: z.string().optional(),
    spacing: z.string().optional(),
    radius: z.string().optional(),
  }).optional(),
  externalRefs: z.array(z.object({ provider: z.string().min(1), id })).optional(),
};

const genericNodeSchema = z.object({
  ...baseNodeShape,
  type: z.enum(["frame", "rectangle", "ellipse", "vector", "component"]),
});

const textNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("text"),
  text: z.string(),
  fontFamily: z.string().min(1),
  fontSize: z.number().positive(),
  lineHeight: z.number().positive(),
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

export const designNodeSchema = z.union([
  genericNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  instanceNodeSchema,
]);

export const designDocumentSchema = z.object({
  schemaVersion: z.literal(1),
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
});
