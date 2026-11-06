import type { DesignDocument, InstanceNode } from "@ufira/design-schema";
import { TextField } from "./property-panel";

/**
 * 实例覆盖面板。
 *
 * 组件实例的子树在实例化时就被物化了，所以这里的输入直接改实例自己的副本，
 * 同时把值记进 `instance.overrides[sourceNodeId]`——组件定义和其它实例不受影响。
 */
export interface InstancePanelProps {
  document: DesignDocument;
  instance: InstanceNode;
  disabled?: boolean;
  onOverride(sourceNodeId: string, patch: { text?: string }): void;
}

export interface TextCopy {
  id: string;
  sourceNodeId: string;
  name: string;
  text: string;
}

export function InstancePanel({ document, instance, disabled, onOverride }: InstancePanelProps) {
  const copies = collectTextCopies(document, instance.id);
  return (
    <div className="instance-panel">
      <h2>实例覆盖</h2>
      {copies.length === 0
        ? <p className="empty-hint">这个实例里没有可覆盖的文本。</p>
        : copies.map(copy => (
          <TextField
            key={copy.id}
            label={copy.name}
            value={copy.text}
            disabled={disabled}
            onCommit={text => onOverride(copy.sourceNodeId, { text })}
          />
        ))}
    </div>
  );
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
      copies.push({ id, sourceNodeId: id.slice(prefix.length), name: node.name, text: node.text });
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(instanceId);
  return copies;
}
