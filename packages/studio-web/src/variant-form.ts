import type { FormField } from "./ui/dialogs";

/**
 * 变体表单的纯逻辑。
 *
 * 从 main.tsx 里抽出来的原因很实际：新建变体需要「属性名 → 当前值 → 新值」三段输入，
 * 一多属性就会变成拼字符串的地狱；把字段生成、值回收、校验放在纯函数里，
 * 面板只管渲染，Node 里也能测。
 */

/** 新建变体集时：属性名用逗号分隔，容忍全角逗号。 */
export function parseVariantProperties(raw: string): { properties: string[]; error?: string } {
  const properties = raw
    .split(/[,，]/)
    .map(item => item.trim())
    .filter(Boolean);
  if (!properties.length) return { properties: [], error: "至少需要一个属性名" };
  if (new Set(properties).size !== properties.length) return { properties, error: "属性名不能重复" };
  if (properties.some(property => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property))) {
    return { properties, error: "属性名只能是字母、数字、下划线，且不能以数字开头" };
  }
  return { properties };
}

/** 属性取值的字符集：允许中文，避免设计师被迫写英文状态名。 */
const VALUE_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/;

/** 已有变体集：每个属性一个「新值」字段，当前值写在 label 里。 */
export function variantNextFields(properties: string[], current: Record<string, string> = {}): FormField[] {
  return properties.map(property => ({
    key: `next:${property}`,
    label: `${property} 的新值（当前 ${current[property] ?? "—"}）`,
    defaultValue: "",
    placeholder: "例如 hover",
  }));
}

/** 首次建立变体集：每个属性还要给出「当前组件」的取值。 */
export function variantCurrentFields(properties: string[]): FormField[] {
  return properties.map(property => ({
    key: `current:${property}`,
    label: `${property} 的当前值`,
    defaultValue: "default",
  }));
}

export function currentValuesFromForm(properties: string[], values: Record<string, string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const property of properties) record[property] = (values[`current:${property}`] ?? "").trim();
  return record;
}

export function nextValuesFromForm(properties: string[], values: Record<string, string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const property of properties) record[property] = (values[`next:${property}`] ?? "").trim();
  return record;
}

/** 表单校验：新值必填、字符集合法、且不能和当前值完全相同。 */
export function validateVariantForm(
  properties: string[],
  values: Record<string, string>,
  options: { includeCurrent: boolean },
): string | undefined {
  const current = options.includeCurrent ? currentValuesFromForm(properties, values) : {};
  for (const property of properties) {
    const value = (values[`next:${property}`] ?? "").trim();
    if (!value) return `${property} 的新值不能为空`;
    if (!VALUE_PATTERN.test(value)) return `${property} 的新值只能用字母、数字、下划线、连字符或中文`;
    if (options.includeCurrent) {
      const currentValue = current[property]!;
      if (!currentValue) return `${property} 的当前值不能为空`;
      if (!VALUE_PATTERN.test(currentValue)) return `${property} 的当前值只能用字母、数字、下划线、连字符或中文`;
    }
  }
  if (options.includeCurrent) {
    const same = properties.every(property => current[property] === (values[`next:${property}`] ?? "").trim());
    if (same) return "新变体和当前组件的取值完全相同";
  }
  return undefined;
}
