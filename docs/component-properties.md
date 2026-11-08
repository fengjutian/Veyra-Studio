# 组件属性（component props）

> 文档状态：生效中的规格
> 建立日期：2026-11-08
> 关联文档：`figma-gap-roadmap.md`、`component-variants.md`、`current-project-status.md`

## 1. 要解决的问题

组件变体（`component-variants.md`）解决的是「同一个组件的几种固定形态」，
但它的取值是**封闭**的：变体集在创建时声明属性名，成员穷举每个属性的取值。
设计师要表达「标题文字可以任意改」「某个图标可以开关」这类参数，变体做不到。

Figma 的组件属性（component props）补的就是这一层：

- 组件对外声明**一组有类型、有默认值的属性**；
- 属性**绑定**到组件内部某个节点的具体字段（文本内容 / 可见性）；
- 实例改的是**属性值**，不碰结构，也不需要复制出新组件。

对本项目而言，这一层的价值比在 Figma 里更大：本项目的定位是
**本地优先 + 可被 Agent 驱动**。Agent 需要一种「改一个标题」的手段，
而现有 override 只能按「源节点 id + 字段」表达——对模型来说是无结构的黑话，
对人类来说也不是设计意图。属性是**有名字、有类型、有默认值**的契约。

举例：

```
组件「按钮」
  属性 title  : text    默认 "确定"   绑定到内部文本节点 button--label 的 text
  属性 danger : boolean 默认 true     绑定到内部形状 button--bg 的 visible

实例「确认按钮」
  title  = "提交"
  danger = false
```

## 2. 数据模型

### 2.1 属性声明

属性声明挂在**组件定义**上（不是挂在节点上），因为它是组件对外的契约：

```ts
export type ComponentProperty =
  | { id: string; name: string; type: "text"; defaultValue: string }
  | { id: string; name: string; type: "boolean"; defaultValue: boolean };

export interface ComponentDefinition {
  // …既有字段
  /** 对外暴露的属性；可选，旧文档没有它也不需要迁移。 */
  properties?: ComponentProperty[];
}
```

属性用**判别联合**而不是 `defaultValue: string | boolean`：
类型与默认值必须配对，写成联合会让「text 属性的默认值是 `false`」这种
错误数据也能通过 schema —— 校验器拦不住语义错误，只会成为下游的静默 bug。

### 2.2 绑定

绑定放在**被绑定的节点**上，方向是「字段 → 属性 id」：

```ts
export interface ComponentPropertyBindings {
  /** 文本字段由哪个 text 属性驱动。 */
  text?: string;
  /** 可见性由哪个 boolean 属性驱动。 */
  visible?: string;
}

export interface BaseNode {
  // …既有字段
  /** 组件属性绑定；只在组件定义子树里有意义。 */
  componentPropertyBindings?: ComponentPropertyBindings;
}
```

为什么绑定写在节点上而不是写在属性上：

- 一个节点最多绑一个 text 属性和一个 visible 属性，写成
  `node.componentPropertyBindings.text = "prop-id"` 天然满足；
- 属性定义（名字、类型、默认值）与绑定（连到哪个字段）是**两件事**，
  分开存才能表达「属性先声明、后绑定」；
- 节点删除时绑定随之消失，不会留下指向已删节点的悬空引用。

支持的字段只有两个：

| 字段 | 属性类型 | 语义 |
| --- | --- | --- |
| `text` | `text` | 文本节点的内容被属性值取代 |
| `visible` | `boolean` | 节点的可见性被属性值控制 |

其它字段（填充、字号、圆角……）**本轮不做** —— 一旦允许绑定任意字段，
属性就会退化成 override 的别名，类型系统也拦不住「把布尔值绑到字号上」。

### 2.3 实例上的属性值

```ts
export interface InstanceNode extends BaseNode {
  // …既有字段
  /** 实例显式设置过的属性值；键是属性 id。缺省表示跟随组件默认值。 */
  propValues?: Record<string, string | boolean>;
}
```

只存**显式改过**的值：没改过的实例不写任何东西，
这样组件默认值变化时这类实例会跟着变（和 Figma 一致）。

### 2.4 不升文档版本

三个新字段全是**可选**的，旧文档没有它们也完全合法，
读取时按「没有属性 / 没有绑定 / 没有实例值」处理。
因此 **schemaVersion 保持 4**，不登记迁移步骤 ——
只有「无法用默认值兼容」才需要升版本。

## 3. 物化时的应用顺序

实例物化（`component.instantiate`）与变体切换（`component.switchVariant`）
都会重建实例子树，顺序固定为：

1. 复制组件根子树（生成 `instanceId--sourceId` 形式的副本）；
2. 应用 override（`applyOverrides`）；
3. **应用属性值**（`applyPropertyValues`）。

属性值**在 override 之后**应用 —— 属性是更高层的契约，优先于字段级覆盖。
与之配套：`component.override` **拒绝**写入被属性绑定的字段
（提示「该字段由组件属性 X 控制」），避免出现「改完立刻被属性值盖掉」的死角。

### 3.1 文本属性与富文本

属性写入的是**纯文本**：被绑定的文本副本上的段内样式（`runs`）会被清掉。
原因：段内样式区间是按字符偏移定义的，换成一段新的文字后区间必然失效，
留着会让 `validateTextRuns` 判定文档非法。

### 3.2 变体之间

创建变体时，源组件的属性声明会被**复制**到新组件（属性 id 保持一致），
节点上的绑定随节点一起被复制。于是：

- 实例切换变体时，`propValues` 按属性 id 保留；
- 新变体没有的属性 id，其实例值会被丢弃（该变体里不存在这个属性）；
- 切换后按新组件的属性声明重新应用一次。

代价：属性声明是**每个组件一份**，不是变体集共享。
在源组件上改默认值不会同步到已经存在的变体（变体是复制出来的独立组件）。
这是本轮的已知限制，见 §6。

## 4. 命令

| 命令 | payload | 语义 |
| --- | --- | --- |
| `component.property.set` | `{ componentId, property }` | 声明或更新一个属性（按 `property.id` 覆盖） |
| `component.property.remove` | `{ componentId, propertyId }` | 删除属性，并清理绑定与实例值 |
| `component.property.bind` | `{ componentId, propertyId, nodeId, field }` | 把属性绑定到组件内某个节点的字段 |
| `component.property.unbind` | `{ componentId, propertyId, nodeId, field }` | 解除绑定，实例副本回到组件定义的原始值 |
| `instance.property.set` | `{ instanceId, propertyId, value }` | 设置实例的属性值并立即应用到副本 |
| `instance.property.reset` | `{ instanceId, propertyId }` | 删除实例的显式值，回到默认值 |

校验规则（命令层 + 文档校验层各拦一次）：

- 属性 id 在组件内唯一；属性名不能为空；
- `defaultValue` 的类型必须与 `type` 一致；
- 绑定的节点必须**在组件根子树内部**（组件根本身不行 —— 它只是容器）；
- `text` 绑定要求属性是 `text` 且节点是文本节点；
- `visible` 绑定要求属性是 `boolean`；
- 实例的属性值必须对应实例所属组件声明过的属性，值类型必须匹配；
- 组件内同一字段只能绑一个属性（重复绑定是覆盖）。

## 5. UI

### 5.1 实例侧

实例面板新增「组件属性」区：每个属性一行编辑器。

- `text` 属性 → 文本输入框；
- `boolean` 属性 → 勾选框；
- 每行显示这个属性绑在哪个节点的哪个字段上；
- 实例显式改过的属性带「恢复默认」按钮。

被属性绑定的文本节点**不再出现在「实例覆盖」区** ——
它的内容归属性管，两处都能改会让人以为有一个改动没生效。

### 5.2 组件侧

属性面板（选中节点时）新增「组件属性」区，条件是**选中的节点属于某个组件**
（`findOwningComponentId` 能找到归属组件）：

- 列出该组件的属性、类型、绑定目标；
- 选中节点在组件内部时，可以「暴露为文本属性」（文本节点）或
  「暴露为布尔属性」（任意节点，绑 `visible`）；
- 每个属性可删除。

绑定目标就是**当前选中的节点**——和 Figma 的
「选中图层 → Create component property」一致：先选图层，再暴露。

## 6. 已知限制

- **属性只支持两种类型**（text / boolean），不支持实例交换、颜色、字号等。
- **属性声明按组件各存一份**，不是变体集共享；源组件改默认值不会同步到已有变体。
- **文本属性写纯文本**，会清掉被绑定文本节点的段内样式。
- **绑定只支持 `text` 与 `visible` 两个字段**，其余字段仍只能靠 override。
- **属性不能跨组件嵌套引用**：组件 A 的属性不会自动传给 A 内部 B 的实例。
- **不升 schema 版本**：字段全可选，旧文档无需迁移。

## 7. 测试

- `design-schema/test/component-properties.test.ts`
  —— schema 接受新字段、拒绝类型不匹配的默认值、
  文档校验能发现悬空绑定 / 未知属性 id / 实例值类型错误。
- `design-runtime/test/component-properties.test.ts`
  —— 声明 / 绑定 / 解绑 / 删除属性、实例值的设置与重置、
  物化顺序（属性覆盖 override）、变体切换保留属性值、
  override 被属性绑定字段拒绝。
- `studio-web/test/component-props.test.ts`
  —— 实例属性视图（含显式值标记、绑定标签）、被绑定的文本节点不出现在覆盖列表。

## 8. 参照来源

- Figma 组件属性（component properties）：
  <https://help.figma.com/hc/en-us/articles/15339657135383>
- Penpot 的变体属性实现（作为「变体属性 ≠ 组件属性」的对照）：
  `common/src/app/common/logic/variants.cljc`
- 本项目变体规格：`docs/component-variants.md`
