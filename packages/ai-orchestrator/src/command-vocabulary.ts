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
    "- text.patch: { id: \"<文本节点 id>\", patch: { text?, fontFamily?, fontSize?, lineHeight?, fontWeight?, fontStyle?, textAlign?, letterSpacing? } }",
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
