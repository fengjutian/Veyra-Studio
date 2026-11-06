import type { DesignDocument, DesignNode, NodeId, NodeType } from "./types";

/**
 * 组件依赖图。
 *
 * 组件可以嵌套：组件 A 的子树里可以放组件 B 的实例。嵌套本身没问题，但如果
 * 依赖绕回自己（A 里放 B、B 里又放 A），实例化就会无限展开。这些工具用来在
 * 编辑期提前拦住这种结构，而不是等提交时抛一句看不懂的校验错误。
 */

/** 某个节点子树里引用到的组件 id（包括节点自己就是实例的情况）。 */
export function componentDependencies(document: DesignDocument, nodeId: NodeId): string[] {
  const found = new Set<string>();
  const visited = new Set<NodeId>();
  const walk = (id: NodeId): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = document.nodes[id];
    if (!node) return;
    if (node.type === "instance") found.add(node.componentId);
    for (const childId of node.childIds) walk(childId);
  };
  walk(nodeId);
  return [...found];
}

/** 从某个组件出发，沿实例引用能到达的所有组件（传递闭包，不含起点）。 */
export function componentReachability(document: DesignDocument, componentId: string): Set<string> {
  const reached = new Set<string>();
  const stack = [componentId];
  while (stack.length) {
    const current = stack.pop()!;
    const rootId = document.components[current]?.rootNodeId;
    if (!rootId) continue;
    for (const dependency of componentDependencies(document, rootId)) {
      if (reached.has(dependency)) continue;
      reached.add(dependency);
      stack.push(dependency);
    }
  }
  return reached;
}

/** 把 `nodeId` 提升成组件 `componentId` 是否会形成自引用或间接环。 */
export function wouldCreateComponentCycle(document: DesignDocument, componentId: string, nodeId: NodeId): boolean {
  for (const dependency of componentDependencies(document, nodeId)) {
    if (dependency === componentId) return true;
    if (componentReachability(document, dependency).has(componentId)) return true;
  }
  return false;
}

/**
 * 某个节点所在的最内层组件。
 *
 * 从节点往上找第一个 `type === "component"` 且有定义的祖先；页面/普通 frame
 * 都不算。用于判断"把节点移进这里会不会让它进入某个组件的子树"。
 */
export function findOwningComponentId(document: DesignDocument, nodeId: NodeId): string | undefined {
  let current: NodeId | undefined = nodeId;
  const visited = new Set<NodeId>();
  while (current) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const node: DesignNode | undefined = document.nodes[current];
    if (!node) return undefined;
    if (node.type === "component") {
      const definition = Object.values(document.components).find(item => item.rootNodeId === node.id);
      if (definition) return definition.id;
    }
    current = node.parentId;
  }
  return undefined;
}

/** 实例可以覆盖的字段。文本节点多一个 `text`，其它节点只能覆盖外观类字段。 */
export type OverrideField = "text" | "name" | "visible" | "appearance";

export function overridableFields(node: DesignNode): OverrideField[] {
  return node.type === "text" ? ["text", "name", "visible", "appearance"] : ["name", "visible", "appearance"];
}

/** 一个实例对外暴露的可覆盖目标（组件定义里的源节点）。 */
export interface ExposedPropertyTarget {
  sourceNodeId: NodeId;
  nodeType: NodeType;
  /** 组件定义里的节点名，作为界面标签。 */
  name: string;
  /** 这个节点允许覆盖的字段。 */
  fields: OverrideField[];
  /** 组件定义里的默认文本；非文本节点没有。 */
  defaultText?: string;
}

/**
 * 列出实例可覆盖的属性目标。
 *
 * 只包含组件定义物化出来的节点（`instanceId--sourceId`），插槽内容不算——
 * 那是用户填进去的，不是组件的参数。返回顺序按源节点 id 排序，保证稳定。
 * 这份清单就是 UI、AI 和外部集成共同使用的"属性暴露"契约。
 */
export function exposedOverrideTargets(document: DesignDocument, instanceId: NodeId): ExposedPropertyTarget[] {
  const instance = document.nodes[instanceId];
  if (!instance || instance.type !== "instance") return [];
  const definition = document.components[instance.componentId];
  if (!definition) return [];

  const prefix = `${instanceId}--`;
  const targets: ExposedPropertyTarget[] = [];
  const visited = new Set<NodeId>();
  const walk = (id: NodeId): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = document.nodes[id];
    if (!node) return;
    if (id.startsWith(prefix) && !id.includes("--slot--")) {
      const sourceNodeId = id.slice(prefix.length);
      const source = document.nodes[sourceNodeId];
      if (source) {
        targets.push({
          sourceNodeId,
          nodeType: source.type,
          name: source.name,
          fields: overridableFields(source),
          ...(source.type === "text" ? { defaultText: source.text } : {}),
        });
      }
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(instanceId);
  return targets.sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId));
}