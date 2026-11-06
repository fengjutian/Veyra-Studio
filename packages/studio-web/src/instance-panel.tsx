import type { DesignDocument, InstanceNode } from "@ufira/design-schema";
import { NumberField, TextField } from "./property-panel";

/**
 * 实例覆盖面板。
 *
 * 组件实例的子树在实例化时就被物化了，所以这里的输入直接改实例自己的副本，
 * 同时把值记进 `instance.overrides[sourceNodeId]`——组件定义和其它实例不受影响。
 */
export interface OverridePatch {
  text?: string;
  visible?: boolean;
  appearance?: { fill?: string; opacity?: number };
}

export interface InstancePanelProps {
  document: DesignDocument;
  instance: InstanceNode;
  disabled?: boolean;
  onOverride(sourceNodeId: string, patch: OverridePatch): void;
  onReset(sourceNodeId: string): void;
  /** 清空这个实例的全部覆盖。 */
  onResetAll(): void;
  /** 把实例脱离成普通 frame。 */
  onDetach(): void;
}

export interface TextCopy {
  id: string;
  sourceNodeId: string;
  name: string;
  text: string;
  fill: string;
  opacityPercent: number;
}

export function InstancePanel({ document, instance, disabled, onOverride, onReset, onResetAll, onDetach }: InstancePanelProps) {
  const copies = collectTextCopies(document, instance.id);
  const overridden = Object.keys(instance.overrides).length;
  return (
    <div className="instance-panel">
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
                  onChange={event => onOverride(copy.sourceNodeId, { appearance: { fill: event.target.value } })}
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
 */
export function collectTextCopies(document: DesignDocument, instanceId: string): TextCopy[] {
  const prefix = `${instanceId}--`;
  const copies: TextCopy[] = [];
  const walk = (id: string): void => {
    const node = document.nodes[id];
    if (!node) return;
    if (node.type === "text" && id.startsWith(prefix) && !id.includes("--slot--")) {
      copies.push({
        id,
        sourceNodeId: id.slice(prefix.length),
        name: node.name,
        text: node.text,
        fill: node.appearance.fill ?? "#000000",
        opacityPercent: Math.round((node.appearance.opacity ?? 1) * 100),
      });
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(instanceId);
  return copies;
}
