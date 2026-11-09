import type {
  ComponentProperty,
  ComponentPropertyBindings,
  ComponentPropertyType,
  ComponentPropertyValue,
  DesignDocument,
  DesignNode,
  InstanceNode,
  NodeId,
} from "./types";

/**
 * 组件属性（component props）的读取与解析。
 *
 * 属性声明在组件定义上，绑定在被绑定的节点上（方向是「字段 → 属性 id」），
 * 实例显式改过的值存在实例的 `propValues` 里。规格见
 * `docs/component-properties.md`。
 */

/** 属性可以驱动的节点字段。 */
export type ComponentPropertyField = "text" | "visible" | "fill" | "fontSize" | "instance";

/** 面板上用什么控件编辑这个类型的值。 */
export type ComponentPropertyControl = "text" | "toggle" | "color" | "number" | "component-select";

/** 一个属性类型的全部约定。 */
export interface PropertyTypeSpec {
  type: ComponentPropertyType;
  /** 值的运行时形态。 */
  valueType: "string" | "boolean" | "number";
  /** 缺省值。 */
  defaultValue: ComponentPropertyValue;
  /** 这个类型能绑到哪些字段。 */
  fields: ComponentPropertyField[];
  /** 面板控件。 */
  control: ComponentPropertyControl;
}

/**
 * 属性类型的规格表。
 *
 * 面板与运行时都读**同一张表**，不允许各写一套——否则「面板能填的值」
 * 和「运行时能接受的值」迟早对不上。
 */
export const PROPERTY_TYPE_SPECS: Record<ComponentPropertyType, PropertyTypeSpec> = {
  text: {
    type: "text",
    valueType: "string",
    defaultValue: "",
    fields: ["text"],
    control: "text",
  },
  boolean: {
    type: "boolean",
    valueType: "boolean",
    defaultValue: false,
    fields: ["visible"],
    control: "toggle",
  },
  "instance-swap": {
    type: "instance-swap",
    valueType: "string",
    // 空串表示「未设置」：属性还没被指定成哪个组件。
    defaultValue: "",
    fields: ["instance"],
    control: "component-select",
  },
  color: {
    type: "color",
    valueType: "string",
    defaultValue: "#000000",
    fields: ["fill"],
    control: "color",
  },
  number: {
    type: "number",
    valueType: "number",
    // 16 是最常见的字号；0 不是合法字号。
    defaultValue: 16,
    fields: ["fontSize"],
    control: "number",
  },
};

/** 全部绑定字段（遍历绑定表时用，避免各处各写一份字段清单）。 */
export const COMPONENT_PROPERTY_FIELDS: ComponentPropertyField[] = ["text", "visible", "fill", "fontSize", "instance"];

/** 字段 → 能绑它的属性类型。 */
export const PROPERTY_FIELD_TYPES: Record<ComponentPropertyField, ComponentPropertyType> = {
  text: "text",
  visible: "boolean",
  fill: "color",
  fontSize: "number",
  instance: "instance-swap",
};

/** 一个绑定字段的语义要求。 */
export interface BindingRequirement {
  /** 能绑这个字段的属性类型。 */
  propertyType: ComponentPropertyType;
  /** 节点类型要求；缺省表示任意节点都行。 */
  nodeType?: "text" | "instance";
}

/**
 * 每个绑定字段的要求。
 *
 * 命令层与文档校验层读**同一张表**：字段与属性类型、节点类型必须对得上，
 * 「把布尔属性绑到字号上」这种错误在两处都要被拦住。
 */
export const BINDING_REQUIREMENTS: Record<ComponentPropertyField, BindingRequirement> = {
  text: { propertyType: "text", nodeType: "text" },
  visible: { propertyType: "boolean" },
  fill: { propertyType: "color" },
  fontSize: { propertyType: "number", nodeType: "text" },
  instance: { propertyType: "instance-swap", nodeType: "instance" },
};

/** 十六进制颜色（`#rgb` 或 `#rrggbb`）。 */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 校验一个属性值。
 *
 * 返回**原因短语**（合法时返回 `undefined`）；完整的句子由调用方拼
 * （`属性 X must be a string`）——这样文档校验层与命令层的措辞保持一致。
 *
 * `instance-swap` 的非空值必须指向**真实存在的组件**——
 * 指向不存在的组件会让实例物化失败，而那是在很久之后才炸的地方。
 */
export function validatePropertyValue(
  property: ComponentProperty,
  value: unknown,
  context?: { document?: DesignDocument },
): string | undefined {
  const spec = PROPERTY_TYPE_SPECS[property.type];
  if (spec.valueType === "boolean") {
    return typeof value === "boolean" ? undefined : "must be a boolean";
  }
  if (spec.valueType === "number") {
    return typeof value === "number" && Number.isFinite(value) ? undefined : "must be a finite number";
  }
  if (typeof value !== "string") return "must be a string";
  if (property.type === "color") {
    return HEX_COLOR_PATTERN.test(value) ? undefined : "must be a #rgb or #rrggbb color";
  }
  if (property.type === "instance-swap" && value) {
    const document = context?.document;
    if (document && !document.components[value]) return "points to a component that does not exist";
  }
  return undefined;
}

/** 属性的缺省值（按类型表）。 */
export function defaultPropertyValue(type: ComponentPropertyType): ComponentPropertyValue {
  return PROPERTY_TYPE_SPECS[type].defaultValue;
}

/** 一条绑定：某个源节点的某个字段由哪个属性驱动。 */
export interface PropertyBinding {
  propertyId: string;
  /** 组件定义里的源节点 id。 */
  sourceNodeId: NodeId;
  field: ComponentPropertyField;
}

/** 组件声明的属性；没有声明时返回空数组。 */
export function componentProperties(document: DesignDocument, componentId: string): ComponentProperty[] {
  return document.components[componentId]?.properties ?? [];
}

/**
 * 变体集**共享**的属性声明。
 *
 * 组件不在任何变体集里时返回空数组——共享声明是集合作用域的能力。
 */
export function sharedComponentProperties(document: DesignDocument, componentId: string): ComponentProperty[] {
  const setId = document.components[componentId]?.variantSetId;
  if (!setId) return [];
  return document.componentSets?.[setId]?.componentProperties ?? [];
}

/**
 * 组件的**有效属性声明**：变体集共享声明 + 组件自己的声明。
 *
 * 按属性 id 合并（规则见 `docs/component-properties.md` §4.1）：
 * - 同名 id：组件自己的声明优先（覆盖整条定义：名字、类型、默认值）；
 * - 只有共享声明有：原样继承；
 * - 只有组件自己有：追加在继承来的声明之后。
 *
 * 顺序：先按共享声明的顺序（被覆盖的换成组件自己的定义），再追加组件独有的。
 * 这样同一变体集里所有变体的属性面板顺序一致。
 *
 * **类型冲突是错误**（组件把共享属性的类型改了）：命令层会拒绝，
 * 文档校验也会报出来。这里仍按「组件自己的优先」取值——
 * 能走到这一步的文档要么通过了校验，要么是手改过的 JSON。
 */
export function effectiveComponentProperties(document: DesignDocument, componentId: string): ComponentProperty[] {
  const shared = sharedComponentProperties(document, componentId);
  const own = componentProperties(document, componentId);
  const ownById = new Map(own.map(property => [property.id, property]));
  const merged: ComponentProperty[] = [];
  const taken = new Set<string>();
  for (const property of shared) {
    const override = ownById.get(property.id);
    merged.push(override ?? property);
    taken.add(property.id);
  }
  for (const property of own) {
    if (taken.has(property.id)) continue;
    merged.push(property);
  }
  return merged;
}

/**
 * 组件与它的变体集共享声明之间的**类型冲突**。
 *
 * 返回冲突的属性 id 列表。文档校验与命令层都用它拦住「改共享属性类型」。
 */
export function sharedPropertyTypeConflicts(document: DesignDocument, componentId: string): string[] {
  const shared = sharedComponentProperties(document, componentId);
  const own = componentProperties(document, componentId);
  const sharedById = new Map(shared.map(property => [property.id, property]));
  const conflicts: string[] = [];
  for (const property of own) {
    const sharedProperty = sharedById.get(property.id);
    if (sharedProperty && sharedProperty.type !== property.type) conflicts.push(property.id);
  }
  return conflicts;
}

/** 按 id 找属性；找不到返回 undefined。 */
export function findComponentProperty(document: DesignDocument, componentId: string, propertyId: string): ComponentProperty | undefined {
  return effectiveComponentProperties(document, componentId).find(property => property.id === propertyId);
}

/**
 * 列出组件根子树里所有的属性绑定。
 *
 * 只扫组件**定义**的子树，不扫实例副本——实例副本在物化时会被剥掉绑定
 * （绑定是组件定义的属性，不是副本的）。
 */
export function propertyBindings(document: DesignDocument, componentId: string): PropertyBinding[] {
  const definition = document.components[componentId];
  if (!definition) return [];
  const bindings: PropertyBinding[] = [];
  const visited = new Set<NodeId>();
  const walk = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node) return;
    const nodeBindings = node.componentPropertyBindings;
    if (nodeBindings) {
      if (nodeBindings.text) bindings.push({ propertyId: nodeBindings.text, sourceNodeId: nodeId, field: "text" });
      if (nodeBindings.visible) bindings.push({ propertyId: nodeBindings.visible, sourceNodeId: nodeId, field: "visible" });
      if (nodeBindings.fill) bindings.push({ propertyId: nodeBindings.fill, sourceNodeId: nodeId, field: "fill" });
      if (nodeBindings.fontSize) bindings.push({ propertyId: nodeBindings.fontSize, sourceNodeId: nodeId, field: "fontSize" });
      if (nodeBindings.instance) bindings.push({ propertyId: nodeBindings.instance, sourceNodeId: nodeId, field: "instance" });
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(definition.rootNodeId);
  return bindings;
}

/** 某个属性在组件里的全部绑定。 */
export function propertyBindingsFor(document: DesignDocument, componentId: string, propertyId: string): PropertyBinding[] {
  return propertyBindings(document, componentId).filter(binding => binding.propertyId === propertyId);
}

/** 一个属性的绑定目标：驱动哪个源节点的哪个字段。 */
export interface PropertyTarget {
  property: ComponentProperty;
  /** 组件定义里的源节点 id。 */
  sourceNodeId: NodeId;
  field: ComponentPropertyField;
}

/**
 * 组件里所有「属性 → 源节点字段」的绑定。
 *
 * 只列出**属性确实声明过**的绑定：绑定指向的属性被删掉后，那条绑定是残留，
 * 应用时不应当把它算进去。
 */
export function propertyTargets(document: DesignDocument, componentId: string): PropertyTarget[] {
  const properties = new Map(effectiveComponentProperties(document, componentId).map(property => [property.id, property]));
  const targets: PropertyTarget[] = [];
  for (const binding of propertyBindings(document, componentId)) {
    const property = properties.get(binding.propertyId);
    if (!property) continue;
    targets.push({ property, sourceNodeId: binding.sourceNodeId, field: binding.field });
  }
  return targets;
}

/**
 * 节点是否在某棵子树的**内部**（不含子树根本身）。
 *
 * 「内部」是绑定的硬要求：组件根本身只是容器，把它绑成属性没有意义。
 */
export function isInsideSubtree(document: DesignDocument, nodeId: NodeId, rootId: NodeId): boolean {
  if (nodeId === rootId) return false;
  return isWithinSubtree(document, nodeId, rootId);
}

/** 节点是否在子树内部（含根本身）。 */
export function isWithinSubtree(document: DesignDocument, nodeId: NodeId, rootId: NodeId): boolean {
  if (nodeId === rootId) return true;
  let current: NodeId | undefined = document.nodes[nodeId]?.parentId;
  const visited = new Set<NodeId>([nodeId]);
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (current === rootId) return true;
    current = document.nodes[current]?.parentId;
  }
  return false;
}

/**
 * 节点是否在某个实例的子树里（祖先链上有实例节点，节点自己不算）。
 *
 * 用来区分「组件定义里的节点」和「实例副本」：副本上的绑定没有意义，
 * 物化时会剥掉。
 */
export function isInsideInstance(document: DesignDocument, nodeId: NodeId): boolean {
  let current: NodeId | undefined = document.nodes[nodeId]?.parentId;
  const visited = new Set<NodeId>([nodeId]);
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    const node: DesignNode | undefined = document.nodes[current];
    if (!node) return false;
    if (node.type === "instance") return true;
    current = node.parentId;
  }
  return false;
}

/**
 * 实例上某个属性的**有效值**：显式值优先，没显式改过就用组件默认值。
 *
 * 显式值的类型可能与属性类型对不上（手改过的文档）：这时回落到默认值，
 * 而不是把错的类型传给运行时。
 */
export function resolvePropertyValue(
  document: DesignDocument,
  instance: InstanceNode,
  property: ComponentProperty,
): ComponentPropertyValue {
  const explicit = instance.propValues?.[property.id];
  if (explicit === undefined) return property.defaultValue;
  const spec = PROPERTY_TYPE_SPECS[property.type];
  if (spec.valueType === "boolean") return typeof explicit === "boolean" ? explicit : property.defaultValue;
  if (spec.valueType === "number") return typeof explicit === "number" && Number.isFinite(explicit) ? explicit : property.defaultValue;
  return typeof explicit === "string" ? explicit : property.defaultValue;
}

/**
 * 实例的**有效属性声明**（变体集共享声明 + 组件自己的声明，已合并）。
 *
 * 实例侧只认这个：共享声明改了，实例面板与运行时一起跟着变。
 */
export function resolveInstanceProperties(document: DesignDocument, instance: InstanceNode): ComponentProperty[] {
  return effectiveComponentProperties(document, instance.componentId);
}

/** 实例显式改过的属性 id 集合。 */
export function explicitPropertyIds(instance: InstanceNode): string[] {
  return Object.keys(instance.propValues ?? {});
}

/**
 * 把组件的某个属性绑到节点字段上，返回新的绑定表。
 *
 * 同一个字段只能绑一个属性，重复绑定是覆盖（返回新对象，不改原表）。
 */
export function withPropertyBinding(
  bindings: ComponentPropertyBindings | undefined,
  field: ComponentPropertyField,
  propertyId: string,
): ComponentPropertyBindings {
  return { ...(bindings ?? {}), [field]: propertyId };
}
