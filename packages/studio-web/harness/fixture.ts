import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode, type Paint } from "@ufira/design-schema";

/**
 * 画布像素基线的 fixture。
 *
 * 覆盖渲染器的每条分支：圆角、描边、椭圆、嵌套裁剪、透明度、隐藏节点、三种图片状态
 * （正常 / contain / 缺失）、三种文本对齐与字重。坐标固定在 960×680 内，保证截图
 * 只随渲染逻辑变化。
 */
export function fixtureDocument(): DesignDocument {
  const document = createDocument("doc:harness", "Canvas Harness", "page:1");
  const add = (node: DesignNode): DesignNode => {
    document.nodes[node.id] = node;
    return node;
  };

  const card = add(frame("card", "page:1", 40, 40, 360, 220, { fill: "#ffffff", stroke: "#e2e8f0", cornerRadius: 16 }));
  const title = add(text("title", "card", 24, 22, 300, 34, "画布渲染基线", { fontSize: 24, lineHeight: 32, fontWeight: 700, fill: "#0f172a" }));
  const body = add(text("body", "card", 24, 66, 312, 96, "这段文字用来验证换行、行高和颜色解析，覆盖窄容器里的多行排版。", { fontSize: 14, lineHeight: 22, fill: "#475569" }));
  const badge = add(frame("badge", "card", 24, 166, 96, 30, { fill: "#eef2ff", cornerRadius: 15 }));
  const badgeText = add(text("badge-text", "badge", 0, 6, 96, 18, "Beta", { fontSize: 12, lineHeight: 18, align: "center", fill: "#4338ca" }));
  card.childIds = [title.id, body.id, badge.id];
  badge.childIds = [badgeText.id];

  const accent = add(frame("accent", "page:1", 460, 40, 240, 120, { fill: "#f87171", cornerRadius: 32 }));
  const dot = add({ ...frame("dot", "page:1", 560, 196, 96, 96, { fill: "#8b5cf6" }), type: "ellipse" } as DesignNode);

  const clip = add(frame("clip", "page:1", 40, 320, 240, 120, { fill: "#f1f5f9", stroke: "#cbd5e1", cornerRadius: 12 }));
  const overflowing = add(frame("overflowing", "clip", 160, 30, 180, 120, { fill: "#2563eb", cornerRadius: 8, opacity: 0.7 }));
  clip.childIds = [overflowing.id];

  const hidden = add({ ...frame("hidden", "page:1", 40, 470, 120, 60, { fill: "#111827" }), visible: false } as DesignNode);

  const rightAligned = add(text("right", "page:1", 700, 340, 200, 30, "右对齐", { fontSize: 20, lineHeight: 28, align: "right", fill: "#0f172a" }));

  const image = add({
    ...frame("image", "page:1", 460, 320, 200, 140, { cornerRadius: 8 }),
    type: "image",
    assetId: "asset:sample",
    fit: "cover",
  } as DesignNode);
  const missing = add({
    ...frame("missing", "page:1", 700, 380, 140, 90, { cornerRadius: 8 }),
    type: "image",
    assetId: "asset:missing",
    fit: "contain",
  } as DesignNode);
  const faded = add(frame("faded", "page:1", 700, 500, 140, 60, { fill: "#22c55e", cornerRadius: 12, opacity: 0.4 }));

  // 两张图都登记在资源表里（否则文档不合法）；harness 只解码 sample，
  // missing 因此会走"缺图占位"分支。
  document.assets["asset:sample"] = { id: "asset:sample", hash: "hash-sample", mimeType: "image/png", byteLength: 1, name: "sample.png" };
  document.assets["asset:missing"] = { id: "asset:missing", hash: "hash-missing", mimeType: "image/png", byteLength: 1, name: "missing.png" };
  document.pages["page:1"].childIds = [card.id, accent.id, dot.id, clip.id, hidden.id, rightAligned.id, image.id, missing.id, faded.id];
  return document;
}

function frame(
  id: string,
  parentId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  appearance: FrameAppearance = {},
): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: appearanceOf(appearance),
  };
}

interface FrameAppearance {
  fill?: string;
  stroke?: string;
  cornerRadius?: number;
  opacity?: number;
}

/**
 * fixture 里用 `fill` 简写，落到文档时必须写成 schema v3 的 `appearance.fills`。
 *
 * 这里曾经直接把 `fill` 摊进 `appearance`，而 v3 之后渲染器只读 `fills`——于是
 * 基线截图里的填充全部消失，像素回归却一直"通过"（对比的是同一份坏渲染）。
 * harness 目录此前不在 tsconfig 的 include 里，类型检查也没拦住。
 */
function appearanceOf({ fill, ...rest }: FrameAppearance) {
  return {
    ...defaultAppearance(),
    ...rest,
    ...(fill ? { fills: [{ type: "solid", color: fill }] as Paint[] } : {}),
  };
}

function text(
  id: string,
  parentId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  options: { fontSize: number; lineHeight: number; fontWeight?: number; align?: "left" | "center" | "right"; fill?: string },
): DesignNode {
  return {
    ...frame(id, parentId, x, y, width, height, { fill: options.fill }),
    type: "text",
    text: value,
    fontFamily: "Inter",
    fontSize: options.fontSize,
    lineHeight: options.lineHeight,
    fontWeight: options.fontWeight ?? 400,
    textAlign: options.align ?? "left",
  } as DesignNode;
}

