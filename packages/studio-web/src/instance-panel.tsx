import type { ComponentPropertyValue, DesignDocument, DesignNode, InstanceNode, Paint } from "@ufira/design-schema";
import { NumberField, TextField } from "./property-panel";
import { ComponentPropEditor, type ComponentChoice } from "./component-prop-editor";
import { instancePropertyViews, nodeBoundByProperty } from "./component-props";
import type { VariantOption } from "./components";

/**
 * 实例覆盖面板。
 *
 * 组件实例的子树在实例化时就被物化了，所以这里的输入直接改实例自己的副本，
 * 同时把值记进 `instance.overrides[sourceNodeId]`——组件定义和其它实例不受影响。
 */
export interface OverridePatch {
  text?: string;
  visible?: boolean;
  appearance?: { fills?: Paint[]; opacity?: number };
}

export interface InstancePanelProps {
  document: DesignDocument;
  instance: InstanceNode;
  disabled?: boolean;
  /** 同一变体集的成员；超过一个才会渲染切换器。 */
  variants?: VariantOption[];
  onSwitchVariant?(componentId: string): void;
  onOverride(sourceNodeId: string, patch: OverridePatch): void;
  onReset(sourceNodeId: string): void;
  /** 清空这个实例的全部覆盖。 */
  onResetAll(): void;
  /** 把实例脱离成普通 frame。 */
  onDetach(): void;
  /** 设置实例的组件属性值。 */
  onSetProperty?(propertyId: string, value: ComponentPropertyValue): void;
  /** 删掉实例的显式属性值，回到默认值。 */
  onResetProperty?(propertyId: string): void;
  /** `instance-swap` 属性的候选组件；不传就用文档里全部组件（去掉自己）。 */
  componentChoices?: ComponentChoice[];
}

export interface TextCopy {
  id: string;
  sourceNodeId: string;
  name: string;
  text: string;
  fill: string;
  opacityPercent: number;
}

export function InstancePanel({ document, instance, disabled, variants, onSwitchVariant, onOverride, onReset, onResetAll, onDetach, onSetProperty, onResetProperty, componentChoices }: InstancePanelProps) {
  const copies = collectTextCopies(document, instance.id);
  const overridden = Object.keys(instance.overrides).length;
  const properties = instancePropertyViews(document, instance);
  // `instance-swap` 的候选：文档里全部组件，除了这个实例自己指向的那个
  // （把自己换成自己没有意义，而且会形成自引用）。
  const choices = componentChoices ?? Object.values(document.components)
    .filter(component => component.id !== instance.componentId)
    .map(component => ({ componentId: component.id, label: component.name }));
  return (
    <div className="instance-panel">
      {variants && variants.length > 1 && (
        <label className="field field-inline">
          <span className="field-label">变体</span>
          <select
            className="variant-select"
            value={instance.componentId}
            disabled={disabled}
            onChange={event => onSwitchVariant?.(event.target.value)}
          >
            {variants.map(option => (
              <option key={option.componentId} value={option.componentId}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {properties.length > 0 && (
        <>
          <div className="section-heading">
            <h2>组件属性</h2>
          </div>
          {properties.map(property => (
            <div className="instance-override" key={property.propertyId}>
              <ComponentPropEditor
                label={property.name}
                type={property.type}
                value={property.value}
                disabled={disabled}
                components={choices}
                onChange={value => onSetProperty?.(property.propertyId, value)}
              />
              <div className="instance-override-appearance">
                <span className="field-label" title={property.targetName ?? ""}>{property.targetName ?? "未绑定"}</span>
                {property.explicit && <button type="button" disabled={disabled} onClick={() => onResetProperty?.(property.propertyId)}>恢复默认</button>}
              </div>
            </div>
          ))}
        </>
      )}
      <div className="section-heading">
        <h2>实例覆盖{overridden ? ` · ${overridden}` : ""}</h2>
        <span className="instance-actions">
          <button type="button" disabled={disabled || overridden === 0} onClick={onResetAll}>全部重置</button>
          <button type="button" disabled={disabled} onClick={onDetach}>脱离组件</button>
        </span>
      </div>
      {copies.length === 0
        ? <p className="empty-hint">这个实例里没有可覆盖的文本。</p>
        : copies.map(copy => (
          <div className="instance-override" key={copy.id}>
            <TextField
              label={copy.name}
              value={copy.text}
              disabled={disabled}
              onCommit={text => onOverride(copy.sourceNodeId, { text })}
            />
            <div className="instance-override-appearance">
              <label className="field field-inline">
                <span className="field-label">填充</span>
                <input
                  type="color"
                  disabled={disabled}
                  value={normalizeHex(copy.fill)}
                  onChange={event => onOverride(copy.sourceNodeId, { appearance: { fills: [{ type: "solid", color: event.target.value }] } })}
                />
              </label>
              <NumberField
                label="透明度"
                value={copy.opacityPercent}
                min={0}
                disabled={disabled}
                onCommit={percent => onOverride(copy.sourceNodeId, { appearance: { opacity: Math.min(1, Math.max(0, percent / 100)) } })}
              />
              <button type="button" disabled={disabled} onClick={() => onReset(copy.sourceNodeId)}>重置</button>
            </div>
          </div>
        ))}
    </div>
  );
}

/** `<input type="color">` 只接受 #rrggbb；其它写法退回黑色，避免受控值漂移。 */
function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
}

/**
 * 收集实例里由组件定义的文本节点。
 *
 * 只收 `instanceId--sourceId` 这种直接物化的节点；插槽内容（`--slot--` 前缀）
 * 是用户后来填进去的，不属于组件定义，也不该被"覆盖"。
 *
 * 被组件属性接管的文本节点也不收：它的内容归属性管，
 * 两处都能改会让人以为有一个改动没生效。
 */
export function collectTextCopies(document: DesignDocument, instanceId: string): TextCopy[] {
  const prefix = `${instanceId}--`;
  const instance = document.nodes[instanceId];
  const componentId = instance?.type === "instance" ? instance.componentId : undefined;
  const copies: TextCopy[] = [];
  const walk = (id: string): void => {
    const node = document.nodes[id];
    if (!node) return;
    if (node.type === "text" && id.startsWith(prefix) && !id.includes("--slot--")) {
      const sourceNodeId = id.slice(prefix.length);
      const bound = componentId ? nodeBoundByProperty(document, componentId, sourceNodeId, "text") : undefined;
      if (!bound) {
        copies.push({
          id,
          sourceNodeId,
          name: node.name,
          text: node.text,
          fill: primaryFill(node) ?? "#000000",
          opacityPercent: Math.round((node.appearance.opacity ?? 1) * 100),
        });
      }
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(instanceId);
  return copies;
}

/** 覆盖面板里的填充是单一颜色：实色取自身、渐变取首个色标。 */
function primaryFill(node: DesignNode): string | undefined {
  const paint = node.appearance.fills?.[0];
  if (!paint) return undefined;
  return paint.type === "solid" ? paint.color : paint.stops[0]?.color;
}