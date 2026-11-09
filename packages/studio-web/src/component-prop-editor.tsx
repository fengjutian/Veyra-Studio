import { PROPERTY_TYPE_SPECS, type ComponentPropertyType, type ComponentPropertyValue } from "@ufira/design-schema";
import { NumberField, SelectField, TextField } from "./property-panel";

/**
 * 组件属性的按类型控件。
 *
 * 控件类型由 `PROPERTY_TYPE_SPECS` 的 `control` 字段决定——
 * 面板与运行时读**同一张表**，不允许各写一套。
 *
 * 规格见 `docs/component-properties.md` §3、§7.1。
 */

/** 一个候选组件（`instance-swap` 属性的下拉项）。 */
export interface ComponentChoice {
  componentId: string;
  label: string;
}

export interface ComponentPropEditorProps {
  label: string;
  type: ComponentPropertyType;
  value: ComponentPropertyValue;
  disabled?: boolean;
  /** `instance-swap` 的候选组件；不传就只显示「未设置」。 */
  components?: ComponentChoice[];
  onChange(value: ComponentPropertyValue): void;
}

/**
 * 按属性类型渲染对应的控件。
 *
 * - `text` → 文本输入框
 * - `boolean` → 开关
 * - `color` → 取色器（`input[type=color]`）
 * - `number` → 数字输入框
 * - `instance-swap` → 下拉选择候选组件（默认项「未设置」）
 */
export function ComponentPropEditor({ label, type, value, disabled, components, onChange }: ComponentPropEditorProps) {
  const control = PROPERTY_TYPE_SPECS[type].control;

  if (control === "toggle") {
    return (
      <label className="field field-inline">
        <span className="field-label">{label}</span>
        <input
          type="checkbox"
          disabled={disabled}
          checked={Boolean(value)}
          onChange={event => onChange(event.target.checked)}
        />
      </label>
    );
  }

  if (control === "color") {
    const color = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#000000";
    return (
      <label className="field field-inline">
        <span className="field-label">{label}</span>
        <input
          type="color"
          disabled={disabled}
          value={color}
          onChange={event => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (control === "number") {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
    return (
      <NumberField
        label={label}
        value={numeric}
        disabled={disabled}
        onCommit={next => onChange(next)}
      />
    );
  }

  if (control === "component-select") {
    const current = typeof value === "string" ? value : "";
    return (
      <SelectField
        label={label}
        value={current}
        disabled={disabled}
        options={[
          { value: "", label: "未设置" },
          ...(components ?? []).map(choice => ({ value: choice.componentId, label: choice.label })),
        ]}
        onChange={next => onChange(next)}
      />
    );
  }

  return (
    <TextField
      label={label}
      value={typeof value === "string" ? value : String(value)}
      disabled={disabled}
      onCommit={next => onChange(next)}
    />
  );
}
