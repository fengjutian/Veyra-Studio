/**
 * 命令词汇表：模型只允许使用这里列出的命令类型。
 *
 * `design-runtime` 没有命令 schema（命令在 apply 时才做运行时校验），所以
 * planner 侧需要自己的一份权威列表：prompt 用它告诉模型能用什么，解析器用
 * 它把越界的输出挡在 dry-run 之前。
 */
export const COMMAND_TYPES = [
  "document.rename",
  "node.create",
  "node.patch",
  "text.patch",
  "node.delete",
  "node.reparent",
  "token.upsert",
  "token.delete",
  "page.create",
  "page.rename",
  "page.delete",
  "component.create",
  "component.remove",
  "component.instantiate",
  "component.define",
  "component.setCreate",
  "component.setVariant",
  "component.createVariant",
  "component.switchVariant",
  "component.property.set",
  "component.property.remove",
  "component.property.bind",
  "component.property.unbind",
  "instance.property.set",
  "instance.property.reset",
  "font.register",
  "font.remove",
  "boolean.create",
  "boolean.setOperation",
  "boolean.release",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && (COMMAND_TYPES as readonly string[]).includes(value);
}

/** 给模型看的命令说明，含每种命令的 payload 形状。 */
export function describeCommandVocabulary(): string {
  return [
    '- node.create: { node: <完整节点对象>, index?: number } —— 新节点的 childIds 必须为空',
    '- node.patch: { id: "<节点 id>", patch: { name?, visible?, locked?, layout?, appearance? } } —— 整块替换，patch 里要写全被替换的字段',
    "- text.patch: { id: \"<文本节点 id>\", patch: { text?, fontFamily?, fontSize?, lineHeight?, fontWeight?, fontStyle?, textAlign?, letterSpacing?, runs? } } —— runs 是段内样式区间 [{ from, to, style: { fontWeight?, fontStyle?, color? } }]，偏移是 UTF-16 下标",
    '- node.delete: { id: "<节点 id>" }',
    '- node.reparent: { id: "<节点 id>", parentId: "<节点或页面 id>", index?: number }',
    '- document.rename: { name: "新名称" }',
    '- page.create: { page: { id, name, childIds: [] }, index?: number }',
    '- page.rename: { id: "<页面 id>", name: "新名称" }',
    '- page.delete: { id: "<页面 id>" } —— 目标页面必须为空，且文档至少保留一个页面',
    '- token.upsert: { name: "color.primary", token: { type: "color"|"number"|"string", value } }',
    '- token.delete: { name: "<token 名>" } —— 被节点绑定时不可删除',
    '- component.create: { id: "<组件 id>", nodeId: "<节点 id>", name: "组件名" } —— 把已有节点提升为组件根',
    '- component.remove: { id: "<组件 id>" } —— 仍有实例引用时不可删除',
    '- component.instantiate: { node: <完整实例节点对象>, index?: number }',
    '- component.define: { component: { id, name, rootNodeId } } —— rootNodeId 必须已经是 type=component 的节点',
    '- component.setCreate: { set: { id, name, properties: ["state"] } } —— 注册变体集，只声明属性名',
    '- component.setVariant: { id: "<组件 id>", variantSetId: "<集合 id>", variant: { state: "default" } } —— 把组件登记为变体成员',
    '- component.createVariant: { sourceComponentId, componentId, name, values: { state: "hover" } } —— 复制根子树生成新变体，源组件必须已属于某个集合',
    '- component.switchVariant: { id: "<实例 id>", componentId: "<同集成员 id>" } —— 切换后按新变体重新物化子树',
    '- component.property.set: { componentId: "<组件 id>", property: { id, name, type: "text"|"boolean", defaultValue } } —— 声明或更新组件属性（按 id 覆盖）',
    '- component.property.remove: { componentId: "<组件 id>", propertyId } —— 删除属性并清理绑定与实例值',
    '- component.property.bind: { componentId, propertyId, nodeId, field: "text"|"visible" } —— 把属性绑到组件内部节点的字段',
    '- component.property.unbind: { componentId, propertyId, nodeId, field } —— 解除绑定，字段恢复组件定义的原始值',
    '- instance.property.set: { instanceId, propertyId, value } —— 设置实例的属性值',
    '- instance.property.reset: { instanceId, propertyId } —— 删掉实例的显式值，回到默认值',
    '- font.register: { font: { family, assetId?, weight?, style? } } —— assetId 指向已上传的字体资源，缺省表示系统字体',
    '- font.remove: { family, weight?, style? } —— 仍被文本节点使用时不可删除',    '- boolean.create: { id: "<布尔组 id>", operation: "union"|"subtract"|"intersect"|"exclude", nodeIds: ["<同级形状 id>", …] } —— 至少两个同级形状，第一个是基准层',
    '- boolean.setOperation: { id: "<布尔组 id>", operation } —— 几何会按运算树实时重算',
    '- boolean.release: { id: "<布尔组 id>" } —— 操作数回到原父级，坐标不变',
  ].join("\n");
}

/** 给模型看的节点模板：node.create / component.instantiate 必须字段齐全。 */
export function describeNodeTemplate(): string {
  return [
    "{",
    '  "id": "frame:unique-id",',
    '  "type": "frame",',
    '  "name": "显示名称",',
    '  "parentId": "<页面 id 或可容纳子节点的 frame id>",',
    '  "childIds": [],',
    '  "visible": true,',
    '  "locked": false,',
    '  "layout": { "mode": "absolute", "x": 48, "y": 48, "width": 240, "height": 140, "widthMode": "fixed", "heightMode": "fixed" },',
    '  "appearance": { "opacity": 1, "fill": "#2563eb", "cornerRadius": 12 }',
    "}",
  ].join("\n");
}
