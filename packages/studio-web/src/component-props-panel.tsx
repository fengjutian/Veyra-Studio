import type { ComponentPropertyField, DesignDocument } from "@ufira/design-schema";
import { componentPropertyViews, type ComponentPropertyView } from "./component-props";

/**
 * 组件属性（component props）的组件侧面板。
 *
 * 显示的是**拥有这个节点的组件**的属性声明：属性名、类型、默认值、
 * 绑定在哪个节点的哪个字段上。
 *
 * 绑定目标就是当前选中的节点——和 Figma 的
 * 「选中图层 → Create component property」一致：先选图层，再暴露。
 */

export interface ComponentPropsPanelProps {
  document: DesignDocument;
  /** 属性声明所在的组件 id。 */
  componentId: string;
  /** 当前选中的节点；暴露属性时用它当绑定目标。 */
  selectedNodeId?: string;
  /** 当前选中的节点是否在这个组件的子树内部（能不能当绑定目标）。 */
  canExpose: boolean;
  disabled?: boolean;
  /** 把选中的节点暴露成一个新属性。 */
  onExpose(field: ComponentPropertyField): void;
  /** 删除属性声明。 */
  onRemove(propertyId: string): void;
  /** 解除绑定（属性声明保留）。 */
  onUnbind(propertyId: string, nodeId: string, field: ComponentPropertyField): void;
}

export function ComponentPropsPanel({ document, componentId, selectedNodeId, canExpose, disabled, onExpose, onRemove, onUnbind }: ComponentPropsPanelProps) {
  const properties = componentPropertyViews(document, componentId);
  return (
    <div className="component-props">
      <div className="section-heading">
        <h2>组件属性{properties.length ? ` · ${properties.length}` : ""}</h2>
      </div>
      {properties.length === 0
        ? <p className="empty-hint">这个组件还没有暴露属性。选中组件内部的节点后可以暴露。</p>
        : properties.map(property => (
          <PropertyRow key={property.propertyId} property={property} disabled={disabled} onRemove={onRemove} onUnbind={onUnbind} />
        ))}
      <div className="instance-actions">
        <button type="button" disabled={disabled || !canExpose} onClick={() => onExpose("text")}>暴露为文本属性</button>
        <button type="button" disabled={disabled || !canExpose} onClick={() => onExpose("visible")}>暴露为布尔属性</button>
      </div>
      {!canExpose && <p className="empty-hint">选中组件内部的节点，才能把它暴露成属性。</p>}
      {selectedNodeId && !canExpose && null}
    </div>
  );
}

function PropertyRow({
  property,
  disabled,
  onRemove,
  onUnbind,
}: {
  property: ComponentPropertyView;
  disabled?: boolean;
  onRemove(propertyId: string): void;
  onUnbind(propertyId: string, nodeId: string, field: ComponentPropertyField): void;
}) {
  const fieldLabel = property.field === "text" ? "文本" : property.field === "visible" ? "可见性" : undefined;
  return (
    <div className="component-prop-row">
      <span className="component-prop-name" title={property.name}>{property.name}</span>
      <span className="component-prop-meta">{property.type === "text" ? "文本" : "布尔"}</span>
      <span className="component-prop-target" title={property.targetName ?? "未绑定"}>
        {property.targetName && fieldLabel ? `${property.targetName} · ${fieldLabel}` : "未绑定"}
      </span>
      <span className="instance-actions">
        {property.targetNodeId && property.field && (
          <button type="button" disabled={disabled} onClick={() => onUnbind(property.propertyId, property.targetNodeId!, property.field!)}>解绑</button>
        )}
        <button type="button" disabled={disabled} onClick={() => onRemove(property.propertyId)}>删除</button>
      </span>
    </div>
  );
}
