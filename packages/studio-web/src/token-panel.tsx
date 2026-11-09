import type { PropertyBindings, TokenValue } from "@ufira/design-schema";
import { Icon } from "./icons";
import { Tooltip } from "./ui/tooltip";

export interface TokenPanelProps {
  tokens: Record<string, TokenValue>;
  /** 当前选中节点的绑定；没有选中时绑定控件禁用。 */
  bindings?: PropertyBindings;
  disabled?: boolean;
  canBind: boolean;
  onCreate(): void;
  onUpdate(name: string, token: TokenValue): void;
  onBind(property: keyof PropertyBindings, tokenName: string): void;
  onUnbind(property: keyof PropertyBindings): void;
  onDelete(name: string): void;
}

/** 每种 token 类型可以绑定的属性。 */
const BINDABLE: Record<TokenValue["type"], Array<keyof PropertyBindings>> = {
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

/** token 值的一行预览；复合值（字体）拼成可读的一段。 */
function tokenPreview(token: TokenValue): string {
  if (token.type === "typography") {
    const { fontFamily, fontSize, lineHeight, fontWeight } = token.value;
    return `${fontFamily} ${fontSize}px${lineHeight ? `/${lineHeight}` : ""}${fontWeight ? ` · ${fontWeight}` : ""}`;
  }
  return String(token.value);
}

/**
 * Token 面板。
 *
 * 一行一份 token：值预览、名字、绑定下拉、编辑、删除。颜色 token 能绑填充/描边，
 * 数值 token 能绑圆角/间距——和 `resolveRadius` / `resolveGap` / `resolveStroke`
 * 支持的绑定保持一致，避免出现"能绑但不生效"的选项。
 */
export function TokenPanel({ tokens, bindings, disabled, canBind, onCreate, onUpdate, onBind, onUnbind, onDelete }: TokenPanelProps) {
  const entries = Object.entries(tokens).sort(([left], [right]) => left.localeCompare(right));
  const boundProperty = (name: string): keyof PropertyBindings | undefined =>
    (Object.entries(bindings ?? {}) as Array<[keyof PropertyBindings, string]>).find(([, value]) => value === name)?.[0];

  return (
    <div className="token-panel">
      <div className="section-heading">
        <h2>设计 Tokens</h2>
        <button disabled={disabled} onClick={onCreate}><Icon name="tokenAdd" />新增</button>
      </div>
      {entries.length === 0 && <p className="empty-hint">还没有 token。新增颜色或数值 token 后可以绑定到选中节点。</p>}
      <div className="token-panel-list">
        {entries.map(([name, token]) => {
          const property = boundProperty(name);
          const bindable = BINDABLE[token.type] ?? [];
          return (
            <div className="token-panel-row" key={name}>
              {token.type === "color"
                ? <span className="token-swatch" style={{ background: String(token.value) }} />
                : <span className="token-swatch token-swatch-value">{tokenPreview(token)}</span>}
              <span className="token-panel-name" title={`${name}: ${tokenPreview(token)}`}>{name}</span>
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
    </div>
  );
}
