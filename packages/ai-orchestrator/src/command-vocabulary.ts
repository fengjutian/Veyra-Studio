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
  "text.paragraph.set",
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
    '- node.patch: { id: "<节点 id>", patch: { name?, visible?, locked?, layout?, appearance? } } —— 整块替换，patch 里要写全被替换的字段；appearance 里颜色写在 fills（数组），没有 fill 字段',
    "- text.patch: { id: \"<文本节点 id>\", patch: { text?, fontFamily?, fontSize?, lineHeight?, fontWeight?, fontStyle?, textAlign?, letterSpacing?, runs? } } —— runs 是段内样式区间 [{ from, to, style: { fontWeight?, fontStyle?, color? } }]，偏移是 UTF-16 下标",
    "- text.paragraph.set: { id: \"<文本节点 id>\", from, to, style: { listType?: \"bullet\" | \"ordered\" | \"none\", indent?: 0-4 } } —— 段落样式：列表类型与缩进级别；from/to 是 UTF-16 下标，命令会自动吸附到段落边界（选区落在段中时整段生效）",
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

/**
 * 给模型看的节点模板：node.create / component.instantiate 必须字段齐全。
 *
 * **必须连命令外壳一起给**，不能只给节点对象。
 * 只给节点对象时，模型要自己包一层 `{"type":"node.create","payload":{"node":{…}}}`，
 * 而它经常**少写一个闭合括号**——节点与 payload 各闭合一层，command 那层忘了，
 * 于是整份 JSON 括号失衡，解析器一个完整计划都扫不出来（实测一份整页计划少了 26 个 `}`）。
 * 把三层外壳完整写出来，模型照抄就不会数错。
 */
export function describeNodeTemplate(): string {
  return [
    "node.create 的完整写法（命令外壳 + 节点对象，三层括号都要闭合）：",
    "{",
    '  "type": "node.create",',
    '  "payload": {',
    '    "node": {',
    '      "id": "frame:unique-id",',
    '      "type": "frame",',
    '      "name": "显示名称",',
    '      "parentId": "<页面 id 或可容纳子节点的 frame id>",',
    '      "childIds": [],',
    '      "visible": true,',
    '      "locked": false,',
    '      "layout": { "mode": "absolute", "x": 48, "y": 48, "width": 240, "height": 140, "widthMode": "fixed", "heightMode": "fixed" },',
    '      "appearance": { "opacity": 1, "fills": [{ "type": "solid", "color": "#2563eb" }], "stroke": "#e2e8f0", "strokeWidth": 1, "cornerRadius": 12 }',
    "    }",
    "  }",
    "}",
  ].join("\n");
}

/**
 * 颜色的写法。
 *
 * 单独拎出来是因为这里错过一次：节点模板曾经写成 `appearance.fill`，而真正的字段是
 * `appearance.fills`（数组）。模型照着错模板建节点，节点**没有填充色**，画布上是空的；
 * 它自己再去改颜色时又会用 `text.patch` 的顶层 `color` 字段——那也是不存在的。
 * 两个错叠在一起，模型永远改不对颜色，只能反复提交无效改动，最后被判成震荡。
 */
export function describeColorUsage(): string {
  return [
    '颜色只能写在 appearance.fills 里："fills": [{ "type": "solid", "color": "#rrggbb" }]。',
    "appearance 里没有 fill 字段（那是旧格式，运行时已不认）。",
    '描边 stroke 是**颜色字符串**，不是 Paint 对象：写成 "stroke": "#e5e7eb"，',
    '不要写成 { "type": "solid", "color": "#e5e7eb" }——那样会被 schema 拒掉（expected string, received object）。',
    "改整个节点或整段文字的颜色：用 node.patch 的 appearance（整块替换，要把 opacity 与 fills 写全）。",
    '只改文字里的一段颜色：用 text.patch 的 runs，例如 "runs": [{ "from": 0, "to": 4, "style": { "color": "#1f2937" } }]；text.patch 的顶层没有 color 字段。',
  ].join("\n");
}
