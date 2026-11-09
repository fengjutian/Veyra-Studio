import type { PropertyBindings, TokenValue } from "@ufira/design-schema";
import { effectiveTokenType, groupTokens } from "./token-groups";
import { Icon } from "./icons";
import { Tooltip } from "./ui/tooltip";

export interface TokenPanelProps {
  tokens: Record<string, TokenValue>;
  /** 当前选中节点的绑定；没有选中时绑定控件禁用。 */
  bindings?: PropertyBindings;
  disabled?: boolean;
  canBind: boolean;
  onCreate(): void;
  /** 从样式表导入 token（CSS 自定义属性 / SCSS 变量）。 */
  onImport?(): void;
  onUpdate(name: string, token: TokenValue): void;
  onBind(property: keyof PropertyBindings, tokenName: string): void;
  onUnbind(property: keyof PropertyBindings): void;
  onDelete(name: string): void;
  /** 当前主题名；有值时面板进入「主题模式」：只能覆盖已有 token。 */
  themeName?: string;
  /** 这个 token 在当前主题下是否有覆盖。 */
  overridden?(name: string): boolean;
  /** 去掉当前主题下的覆盖，回到基础值。 */
  onResetOverride?(name: string): void;
}

/** 每种 token 类型可以绑定的属性。 */
const BINDABLE: Record<Exclude<TokenValue["type"], "alias">, Array<keyof PropertyBindings>> = {
  color: ["fill", "stroke"],
  number: ["radius", "spacing"],
  typography: ["typography"],
  // 早期标量类型没有渲染语义，不提供绑定入口。
  string: [],
};

const PROPERTY_LABELS: Record<keyof PropertyBindings, string> = {
  fill: "填充",
  stroke: "描边",
  typography: "字体",
  spacing: "间距",
  radius: "圆角",
};

/**
 * 别名链的最终类型。
 *
 * 绑定下拉要按**最终类型**给选项：`text.primary`（alias → 颜色）应该能绑填充。
 * 链断了就按别名本身处理（不给绑定入口），与校验层的判定保持一致。
 */
/** token 值的一行预览；复合值（字体）拼成可读的一段，别名显示指向目标。 */
function tokenPreview(token: TokenValue): string {
  if (token.type === "typography") {
    const { fontFamily, fontSize, lineHeight, fontWeight } = token.value;
    return `${fontFamily} ${fontSize}px${lineHeight ? `/${lineHeight}` : ""}${fontWeight ? ` · ${fontWeight}` : ""}`;
  }
  if (token.type === "alias") return `→ ${token.value}`;
  return String(token.value);
}

/**
 * Token 面板。
 *
 * 一行一份 token：值预览、名字、绑定下拉、编辑、删除。颜色 token 能绑填充/描边，
 * 数值 token 能绑圆角/间距——和 `resolveRadius` / `resolveGap` / `resolveStroke`
 * 支持的绑定保持一致，避免出现"能绑但不生效"的选项。
 */
export function TokenPanel({ tokens, bindings, disabled, canBind, onCreate, onImport, onUpdate, onBind, onUnbind, onDelete, themeName, overridden, onResetOverride }: TokenPanelProps) {
  const entries = Object.entries(tokens).sort(([left], [right]) => left.localeCompare(right));
  const boundProperty = (name: string): keyof PropertyBindings | undefined =>
    (Object.entries(bindings ?? {}) as Array<[keyof PropertyBindings, string]>).find(([, value]) => value === name)?.[0];

  return (
    <div className="token-panel">
      <div className="section-heading">
        <h2>设计 Tokens{themeName ? ` · ${themeName}` : ""}</h2>
        {onImport ? (
          <Tooltip label="从样式表导入 token">
            <button
              aria-label="从样式表导入 token"
              disabled={disabled || Boolean(themeName)}
              onClick={onImport}
              title={themeName ? "主题只能覆盖已有 token" : undefined}
            >
              <Icon name="import" />
            </button>
          </Tooltip>
        ) : null}
        <button disabled={disabled || Boolean(themeName)} onClick={onCreate} title={themeName ? "主题只能覆盖已有 token" : undefined}><Icon name="tokenAdd" />新增</button>
      </div>
      {themeName ? (
        <p className="empty-hint">当前在主题「{themeName}」：改值会写成该主题的覆盖，带「已覆盖」标记的可以恢复基础值。</p>
      ) : null}
      {entries.length === 0 && <p className="empty-hint">还没有 token。新增颜色或数值 token 后可以绑定到选中节点。</p>}
      <div className="token-panel-list">
        {groupTokens(tokens).map(group => (
          <div className="token-group" key={group.id || "ungrouped"}>
            <h3 className="token-group-title">{group.label}</h3>
            {group.entries.map(([name, token]) => {
              const property = boundProperty(name);
              const resolvedType = effectiveTokenType(tokens, name);
              const bindable = resolvedType ? BINDABLE[resolvedType as Exclude<TokenValue["type"], "alias">] ?? [] : [];
              return (
                <div className="token-panel-row" key={name}>
                  {token.type === "color"
                    ? <span className="token-swatch" style={{ background: String(token.value) }} />
                    : <span className="token-swatch token-swatch-value">{tokenPreview(token)}</span>}
                  <span className="token-panel-name" title={`${name}: ${tokenPreview(token)}`}>{name}</span>
                  {overridden?.(name) ? (
                    <>
                      <span className="token-override-badge">已覆盖</span>
                      {onResetOverride ? (
                        <Tooltip label="恢复基础值">
                          <button className="icon-only" aria-label={`恢复 ${name} 的基础值`} disabled={disabled} onClick={() => onResetOverride(name)}>↺</button>
                        </Tooltip>
                      ) : null}
                    </>
                  ) : null}
                  <select
                    className="token-bind-select"
                    aria-label={`绑定 ${name}`}
                    disabled={disabled || !canBind}
                    value={property ?? ""}
                    onChange={event => {
                      const next = event.target.value as keyof PropertyBindings | "";
                      if (property && (!next || next !== property)) onUnbind(property);
                      if (next) onBind(next, name);
                    }}
                  >
                    <option value="">不绑定</option>
                    {bindable.map(item => <option key={item} value={item}>{PROPERTY_LABELS[item]}</option>)}
                  </select>
                  <Tooltip label="修改 token 值">
                    <button className="icon-only" aria-label={`修改 ${name}`} disabled={disabled} onClick={() => onUpdate(name, token)}><Icon name="tokenEdit" /></button>
                  </Tooltip>
                  <Tooltip label="删除 token">
                    <button className="icon-only" aria-label={`删除 ${name}`} disabled={disabled} onClick={() => onDelete(name)}><Icon name="tokenRemove" /></button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
