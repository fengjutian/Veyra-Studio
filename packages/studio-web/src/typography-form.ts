/**
 * 字体 token 的编辑表单。
 *
 * 字体 token 是复合值（族名 + 字号 + 行高 + 字重 + 字形 + 字距），用一串单行输入
 * 收集，再在这里统一解析与校验——校验规则与 schema 一致（字号为正、字重 100–900
 * 的整百值），避免「表单能填、保存时报错」。
 *
 * `parseTypographyForm` 是纯函数，可以在 Node 里直接测。
 */

import type { TypographyValue } from "@ufira/design-schema";

/** 表单收集到的原始字符串。 */
export type TypographyFormValues = Record<string, string>;

/** `useForm()` 的结构形状：返回 undefined 表示用户取消。 */
export interface TypographyFormApi {
  (request: {
    title: string;
    description?: string;
    fields: Array<{ key: string; label: string; defaultValue?: string; placeholder?: string }>;
    validate?(values: TypographyFormValues): string | undefined;
    confirmLabel?: string;
  }): Promise<TypographyFormValues | undefined>;
}

/** 解析结果：要么是完整值，要么是一条人话错误。 */
export type TypographyParseResult = { ok: true; value: TypographyValue } | { ok: false; error: string };

/** 把表单值解析成字体 token 值。 */
export function parseTypographyForm(values: TypographyFormValues): TypographyParseResult {
  const family = (values.fontFamily ?? "").trim();
  if (!family) return { ok: false, error: "字体族名不能为空" };

  const size = Number((values.fontSize ?? "").trim());
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "字号必须是正数" };

  const value: TypographyValue = { fontFamily: family, fontSize: size };

  const lineHeightText = (values.lineHeight ?? "").trim();
  if (lineHeightText) {
    const lineHeight = Number(lineHeightText);
    if (!Number.isFinite(lineHeight) || lineHeight < 0) return { ok: false, error: "行高必须是非负数" };
    value.lineHeight = lineHeight;
  }

  const weightText = (values.fontWeight ?? "").trim();
  if (weightText) {
    const weight = Number(weightText);
    if (!Number.isInteger(weight) || weight < 100 || weight > 900) {
      return { ok: false, error: "字重必须是 100–900 的整数" };
    }
    value.fontWeight = weight;
  }

  const letterSpacingText = (values.letterSpacing ?? "").trim();
  if (letterSpacingText) {
    const letterSpacing = Number(letterSpacingText);
    if (!Number.isFinite(letterSpacing)) return { ok: false, error: "字距必须是数字" };
    value.letterSpacing = letterSpacing;
  }

  const style = (values.fontStyle ?? "").trim();
  if (style === "italic" || style === "normal") value.fontStyle = style;
  return { ok: true, value };
}

/** 弹出表单并返回解析后的字体值；取消或校验失败时返回 undefined（错误在表单里提示）。 */
export async function askTypographyValue(askForm: TypographyFormApi, initial: TypographyValue): Promise<TypographyValue | undefined> {
  const result = await askForm({
    title: "字体样式",
    description: "省略的字段不覆盖节点自身的值：只填字号就只统一字号。",
    fields: [
      { key: "fontFamily", label: "字体族名", defaultValue: initial.fontFamily },
      { key: "fontSize", label: "字号（px）", defaultValue: String(initial.fontSize) },
      { key: "lineHeight", label: "行高（px，可留空）", defaultValue: initial.lineHeight === undefined ? "" : String(initial.lineHeight) },
      { key: "fontWeight", label: "字重（100–900，可留空）", defaultValue: initial.fontWeight === undefined ? "" : String(initial.fontWeight) },
      { key: "letterSpacing", label: "字距（px，可留空）", defaultValue: initial.letterSpacing === undefined ? "" : String(initial.letterSpacing) },
      { key: "fontStyle", label: "字形（normal / italic，可留空）", defaultValue: initial.fontStyle ?? "" },
    ],
    validate: values => {
      const parsed = parseTypographyForm(values);
      // studio-web 继承根 tsconfig 的 strict: false，`ok: true | false` 的判别联合
      // 收窄在这里不生效，用 `in` 判断成员更稳妥。
      return "error" in parsed ? parsed.error : undefined;
    },
  });
  if (!result) return undefined;
  const parsed = parseTypographyForm(result);
  return "value" in parsed ? parsed.value : undefined;
}
