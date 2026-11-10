import type { NodeType, PropertyOverride } from "@ufira/design-schema";

/**
 * 主题属性覆盖的表单解析。
 *
 * 抽出来是为了能单独测：表单全是字符串，解析错一步就是「半径变成 0」这种
 * 静默坏数据——单元测试比点界面可靠。
 */

/** 属性覆盖能写的节点类型；空表示不限类型。 */
export const PROPERTY_OVERRIDE_TYPES: NodeType[] = ["frame", "text", "image", "rectangle", "ellipse", "vector", "component", "instance", "boolean"];

/** 表单里数值字段的键名，按顺序。 */
export const PROPERTY_OVERRIDE_NUMBER_FIELDS = ["cornerRadius", "gap", "padding", "fontSize", "opacity"] as const;

export interface ParsedPropertyOverride {
  /** 解析出来的覆盖；出错了是 `undefined`。 */
  override?: PropertyOverride;
  /** 错误文案；解析成功是 `undefined`。 */
  error?: string;
}

/** 一条属性覆盖的可读摘要，用于面板上的一行说明。 */
export function describePropertyOverride(override: PropertyOverride): string {
  const parts: string[] = [];
  if (override.type) parts.push(`类型 ${override.type}`);
  if (override.cornerRadius !== undefined) parts.push(`圆角 ${override.cornerRadius}`);
  if (override.gap !== undefined) parts.push(`间距 ${override.gap}`);
  if (override.padding !== undefined) parts.push(`内边距 ${override.padding}`);
  if (override.fontSize !== undefined) parts.push(`字号 ${override.fontSize}`);
  if (override.opacity !== undefined) parts.push(`不透明度 ${override.opacity}`);
  return parts.join(" · ");
}

/**
 * 把表单值解析成一条属性覆盖。
 *
 * 空字符串表示「这个字段不覆盖」——不是 0。`opacity` 允许 0（完全透明），
 * 所以不能用「值是否为 0」来判断字段有没有填。
 */
export function parsePropertyOverride(values: Record<string, string>): ParsedPropertyOverride {
  const type = values.type?.trim();
  if (type && !PROPERTY_OVERRIDE_TYPES.includes(type as NodeType)) return { error: "节点类型不认识" };
  const override: PropertyOverride = {};
  if (type) override.type = type as NodeType;
  for (const field of PROPERTY_OVERRIDE_NUMBER_FIELDS) {
    const raw = values[field]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: `${field} 要填数字` };
    if (field === "fontSize" && value <= 0) return { error: "字号要大于 0" };
    if (field !== "opacity" && value < 0) return { error: `${field} 不能是负数` };
    if (field === "opacity" && (value < 0 || value > 1)) return { error: "不透明度要在 0–1 之间" };
    override[field] = value;
  }
  return { override };
}
