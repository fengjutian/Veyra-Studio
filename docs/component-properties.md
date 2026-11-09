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
  | { id: string; name: string; type: "boolean"; defaultValue: boolean }
  | { id: string; name: string; type: "instance-swap"; defaultValue: string }
  | { id: string; name: string; type: "color"; defaultValue: string }
  | { id: string; name: string; type: "number"; defaultValue: number };

export interface ComponentDefinition {
  // …既有字段
  /** 对外暴露的属性；可选，旧文档没有它也不需要迁移。 */
  properties?: ComponentProperty[];
}
```

属性用**判别联合**而不是 `defaultValue: string | boolean`：
类型与默认值必须配对，写成联合会让「text 属性的默认值是 `false`」这种
错误数据也能通过 schema —— 校验器拦不住语义错误，只会成为下游的静默 bug。

属性值在实例上的存储形态统一为 `string | boolean | number`：

```ts
export type ComponentPropertyValue = string | boolean | number;
```

- `text` / `color` / `instance-swap` 的值是字符串；
- `boolean` 的值是布尔值；
- `number` 的值是数字。

值的**解析与校验**统一走 `packages/design-schema/src/component-properties.ts`：
那里的 `PROPERTY_TYPE_SPECS` 是这五种类型的规格表（值形态、缺省值、
可绑字段、面板控件），`validatePropertyValue` 按声明类型校验值，
`resolvePropertyValue` 返回对应形态的值。

### 2.2 绑定的字段

绑定放在**被绑定的节点**上，方向是「字段 → 属性 id」：

```ts
export interface ComponentPropertyBindings {
  /** 文本字段由哪个 text 属性驱动。 */
  text?: string;
  /** 可见性由哪个 boolean 属性驱动。 */
  visible?: string;
  /** 填充色由哪个 color 属性驱动。 */
  fill?: string;
  /** 字号由哪个 number 属性驱动。 */
  fontSize?: string;
  /** 内部实例由哪个 instance-swap 属性驱动。 */
  instance?: string;
}

export interface BaseNode {
  // …既有字段
  /** 组件属性绑定；只在组件定义子树里有意义。 */
  componentPropertyBindings?: ComponentPropertyBindings;
}
```

为什么绑定写在节点上而不是写在属性上：

- 一个节点最多绑每个字段一个属性，写成
  `node.componentPropertyBindings.text = "prop-id"` 天然满足；
- 属性定义（名字、类型、默认值）与绑定（连到哪个字段）是**两件事**，
  分开存才能表达「属性先声明、后绑定」；
- 节点删除时绑定随之消失，不会留下指向已删节点的悬空引用。

支持的字段有五个：

| 字段 | 属性类型 | 语义 | 节点要求 |
| --- | --- | --- | --- |
| `text` | `text` | 文本节点的内容被属性值取代 | 文本节点 |
| `visible` | `boolean` | 节点的可见性被属性值控制 | 任意 |
| `fill` | `color` | 节点的填充色被属性值取代 | 任意 |
| `fontSize` | `number` | 文本节点的字号被属性值取代 | 文本节点 |
| `instance` | `instance-swap` | 组件内部的实例被换成属性值指向的组件 | 实例节点 |

字段与属性类型的对应由 `design-schema` 的 `BINDING_REQUIREMENTS` 一张表决定：
命令层与文档校验层读**同一张表**，所以「把布尔属性绑到字号上」
在两处都会被拦住，不会只在一处生效。

> 为什么不允许绑定任意字段：一旦允许，属性就会退化成 override 的别名，
> 类型系统也拦不住「把布尔值绑到字号上」。五个字段覆盖了组件参数里
> 最常见的几类（内容、显隐、颜色、字号、实例），再多就该走 override。

### 2.3 实例上的属性值

```ts
export interface InstanceNode extends BaseNode {
  // …既有字段
  /** 实例显式设置过的属性值；键是属性 id。缺省表示跟随组件默认值。 */
  propValues?: Record<string, string | boolean | number>;
}
```

只存**显式改过**的值：没改过的实例不写任何东西，
这样组件默认值变化时这类实例会跟着变（和 Figma 一致）。

### 2.4 不升文档版本

三个新字段全是**可选**的，旧文档没有它们也完全合法，
读取时按「没有属性 / 没有绑定 / 没有实例值」处理。
因此 **schemaVersion 保持 4**，不登记迁移步骤 ——
只有「无法用默认值兼容」才需要升版本。

## 3. 属性类型的行为

每种类型都有固定的四件事：**值类型、默认值、校验规则、面板控件**。
它们集中在 `component-properties.ts` 的 `PROPERTY_TYPE_SPECS` 里，
面板与运行时都读同一张表，不允许各写一套。

| 类型 | 值类型 | 默认值 | 校验 | 面板控件 |
| --- | --- | --- | --- | --- |
| `text` | 字符串 | `""` | 必须是字符串 | 文本输入框 |
| `boolean` | 布尔值 | `false` | 必须是布尔值 | 开关 |
| `instance-swap` | 字符串（组件 id） | `""`（未设置） | 必须是字符串；非空时必须指向存在的组件 | 下拉选择候选组件 |
| `color` | 字符串（十六进制） | `"#000000"` | 必须是 `#rgb` 或 `#rrggbb` | 取色器（`input[type=color]`） |
| `number` | 数字 | `16` | 必须是有限数字 | 数字输入框 |

`instance-swap` 的值是**组件 id**（不是实例节点 id）：实例交换的语义是
「把组件内部某个实例换成另一个组件的定义」，值指向组件最直接，
也让实例值在变体之间可以保持稳定。

`number` 的默认值取 `16` 而不是 `0`——它最常见的用途是字号，
`0` 不是合法字号。

## 4. 变体集共享声明

变体集（`ComponentSetDefinition`）上可以声明一组**所有成员共享**的属性：

```ts
export interface ComponentSetDefinition {
  id: string;
  name: string;
  /** 变体属性名，顺序即 UI 展示顺序。 */
  properties: string[];
  /** 变体集共享的组件属性声明；可选，旧集合没有它也完全合法。 */
  componentProperties?: ComponentProperty[];
}
```

共享声明解决的是「同一个变体集里的每个变体都要重复声明同一组属性」：
声明一次，集内所有变体都拿到。

### 4.1 合并规则与优先级

一个组件的**有效属性声明** = 变体集共享声明 + 该组件自己的声明，
按属性 id 合并：

- **同名 id：组件自己的声明优先**（覆盖共享声明的整条定义：名字、类型、默认值）。
  变体是更具体的一端，允许它特化共享属性（例如「危险」变体把 `danger` 默认值改成 `true`）。
- **只有共享声明有、组件自己没有的**：原样继承。
- **只有组件自己有的**：追加在继承来的声明之后。

顺序：先按共享声明的顺序输出（被覆盖的用组件自己的定义替换），
再追加组件独有的声明。这样同一变体集里所有变体的属性面板顺序一致。

**类型冲突要报错**：组件把共享属性的类型改了（例如共享是 `number`，
组件改成 `text`），属于破坏共享契约，文档校验必须报出来。

### 4.2 实例侧

实例绑定到具体变体后，属性定义随之解析：`resolveInstanceProperties`
先取变体的有效声明，再看实例自己有没有显式值。

## 5. 物化时的应用顺序

实例物化（`component.instantiate`）与变体切换（`component.switchVariant`）
都会重建实例子树，顺序固定为：

1. 复制组件根子树（生成 `instance--source` 形式的副本）；
2. 应用 override（`applyOverrides`）；
3. **应用属性值**（`applyPropertyValues`）。

属性值**在 override 之后**应用 —— 属性是更高层的契约，优先于字段级覆盖。
与之配套：`component.override` **拒绝**写入被属性绑定的字段
（提示「该字段由组件属性 X 控制」），避免出现「改完立刻被属性值盖掉」的死角。

### 5.1 文本属性与富文本

属性写入的是**纯文本**：被绑定的文本副本上的段内样式（`runs`）会被清掉。
原因：段内样式区间是按字符偏移定义的，换成一段新的文字后区间必然失效，
留着会让 `validateTextRuns` 判定文档非法。

### 5.2 变体之间

创建变体时，源组件的属性声明会被**复制**到新组件（属性 id 保持一致），
节点上的绑定随节点一起被复制。于是：

- 实例切换变体时，`propValues` 按属性 id 保留；
- 新变体没有的属性 id，其实例值会被丢弃（该变体里不存在这个属性）；
- 切换后按新组件的属性声明重新应用一次。

共享声明（§4）让「所有变体都有同一组属性」这件事不再依赖复制：
共享声明以变体集为作用域，切换变体时自然跟着走。

## 6. 命令

| 命令 | payload | 语义 |
| --- | --- | --- |
| `component.property.set` | `{ componentId, property }` | 声明或更新一个属性（按 `property.id` 覆盖） |
| `component.property.remove` | `{ componentId, propertyId }` | 删除属性，并清理绑定与实例值 |
| `component.property.bind` | `{ componentId, propertyId, nodeId, field }` | 把属性绑定到组件内某个节点的字段 |
| `component.property.unbind` | `{ componentId, propertyId, nodeId, field }` | 解除绑定，实例副本回到组件定义的原始值 |
| `component.setProperty.set` | `{ setId, property }` | 给变体集声明一个**共享**的属性 |
| `component.setProperty.remove` | `{ setId, propertyId }` | 删除变体集共享的属性（成员没有同名声明时连带清理绑定与实例值） |
| `instance.property.set` | `{ instanceId, propertyId, value }` | 设置实例的属性值并立即应用到副本 |
| `instance.property.reset` | `{ instanceId, propertyId }` | 删除实例的显式值，回到默认值 |

校验规则（命令层 + 文档校验层各拦一次）：

- 属性 id 在组件内唯一；属性名不能为空；
- `defaultValue` 的类型必须与 `type` 一致（见 §3 的表）；
- 绑定的节点必须**在组件根子树内部**（组件根本身不行 —— 它只是容器）；
- 绑定字段与属性类型、节点类型必须对得上（`BINDING_REQUIREMENTS` 一张表）；
- 实例的属性值必须对应实例所属组件**有效声明**过的属性，值类型必须匹配；
- `instance-swap` 的非空值必须指向**真实存在的组件**；
- 组件内同一字段只能绑一个属性（重复绑定是覆盖）；
- 组件覆盖共享属性时不得改变它的类型（§4.1）。

## 7. UI

### 7.1 实例侧

实例面板新增「组件属性」区：每个属性一行编辑器。

- `text` 属性 → 文本输入框；
- `boolean` 属性 → 开关；
- `color` 属性 → 取色器；
- `number` 属性 → 数字输入框；
- `instance-swap` 属性 → 下拉选择候选组件（默认项「未设置」）；
- 每行显示这个属性绑在哪个节点的哪个字段上；
- 实例显式改过的属性带「恢复默认」按钮。

按类型渲染控件的组件是 `packages/studio-web/src/component-prop-editor.tsx`
（`ComponentPropEditor`）：它接收属性类型、当前值与候选列表，
按 `PROPERTY_TYPE_SPECS` 的 `control` 字段选控件。

被属性绑定的**文本内容**不再出现在「实例覆盖」区 ——
它的内容归属性管，两处都能改会让人以为有一个改动没生效。
（绑 `fill` / `fontSize` / `instance` 的节点仍然出现在覆盖区：
那些字段归属性管，文本内容并没有。）

### 7.2 组件侧

属性面板（选中节点时）新增「组件属性」区，条件是**选中的节点属于某个组件**
（`findOwningComponentId` 能找到归属组件）：

- 列出该组件的属性、类型、绑定目标；来自变体集**共享声明**的属性标「（共享）」；
- 选中节点在组件内部时，可以「暴露为」五种属性之一：
  文本属性（文本节点）、布尔属性（任意节点，绑 `visible`）、
  颜色属性（任意节点，绑 `fill`）、字号属性（文本节点，绑 `fontSize`）、
  实例交换属性（实例节点，绑 `instance`）；
- 每个属性可删除。

绑定目标就是**当前选中的节点**——和 Figma 的
「选中图层 → Create component property」一致：先选图层，再暴露。

暴露出来的属性**默认值取自当前节点**（现在的文字、颜色、字号、组件）：
否则实例会先显示成别的值再被改回来。

## 8. 已知限制

- **`color` 只接受十六进制**（`#rgb` / `#rrggbb`），不支持 `rgba()` 或颜色名。
- **`instance-swap` 的值指向组件 id**，空串表示「未设置」；不支持指向实例节点 id。
- **属性声明默认按组件各存一份**，不是变体集共享；共享声明是可选能力（§4），
  两者可以并存，共享声明优先作为基线（§4.1）。
- **文本属性写纯文本**，会清掉被绑定文本节点的段内样式。
- **属性不能跨组件嵌套引用**：组件 A 的属性不会自动传给 A 内部 B 的实例。
- **不升 schema 版本**：字段全可选，旧文档无需迁移。

## 9. 本轮落地的改动

| 文件 | 改动 |
| --- | --- |
| `packages/design-schema/src/types.ts` | `ComponentProperty` 加三种新分支；`ComponentPropertyValue`；`InstanceNode.propValues` 放宽到 `string \| boolean \| number`；`ComponentSetDefinition` 加 `componentProperties?: ComponentProperty[]`；`ComponentPropertyBindings` 加 `fill` / `fontSize` / `instance` |
| `packages/design-schema/src/component-properties.ts` | `PROPERTY_TYPE_SPECS` 类型表；`BINDING_REQUIREMENTS` 字段要求表；`effectiveComponentProperties` / `sharedComponentProperties` / `sharedPropertyTypeConflicts`；`validatePropertyValue` |
| `packages/design-schema/src/schema.ts` | `componentPropertySchema` 加三种新分支；`propValues` 记录值加 `z.number()`；`componentSets` 加 `componentProperties` 数组；绑定 schema 加三个键 |
| `packages/design-schema/src/validate.ts` | 实例属性值按类型校验；绑定字段与属性类型 / 节点类型匹配；共享属性被变体改类型时报错 |
| `packages/design-runtime/src/commands.ts` | `instance.property.set` 的 `value` 放宽；新增 `component.setProperty.set` / `component.setProperty.remove` |
| `packages/design-runtime/src/runtime.ts` | 值校验按类型分派；绑定校验读 `BINDING_REQUIREMENTS`；`applyInstanceProperties` 按字段分派（文本 / 显隐 / 填充色 / 字号 / 交换内部实例）；共享声明的增删 |
| `packages/studio-application/src/mcp.ts` | 新命令登记进 `SUPPORTED_COMMANDS` |
| `packages/studio-web/src/component-props.ts` | 视图类型放宽；改用**有效声明**（含共享声明） |
| `packages/studio-web/src/component-prop-editor.tsx` | 按类型渲染控件（新文件） |
| `packages/studio-web/src/instance-panel.tsx` | 用 `ComponentPropEditor` 渲染各类型控件 |
| `packages/studio-web/src/component-props-panel.tsx` | 类型标签、共享标记、五种「暴露为」按钮 |
| `packages/studio-web/src/main.tsx` | 暴露属性的默认值取自当前节点；取值命令放宽 |

**注意**：zod 的 `z.object` 默认**剥掉未声明的键**。共享声明
（`componentSets[*].componentProperties`）、`number` 实例值、三个新绑定键
如果没同步进 schema，会在 `validateDocument` 之后**静默消失**——不是报错，是丢数据。

### 9.1 实例交换的实现要点

`instance-swap` 绑的是组件**内部的一个实例节点**。交换时：

- 旧子树删掉（`removeSubtree`，不碰父节点的 `childIds`——父节点自己会被重写）；
- 新组件的根子树重新物化到副本下，副本 id 规则与实例物化一致
  （`${parentCopyId}--${sourceId}`）；
- 副本的 `componentId` 换成新组件，`overrides` 清空
  （旧组件的覆盖对不上新组件的源节点）。

物化逻辑从 `instantiateComponent` 里抽成了 `materializeNode`，
实例物化与实例交换共用同一套——两处各写一份 id 规则必然会漂。

## 10. 测试

- `design-schema/test/component-properties.test.ts`（21 条）
  —— 新类型的解析 / 校验 / 默认值、绑定字段与节点类型匹配、
  变体集共享声明的合并与优先级与类型冲突、旧行为（text / visible）回归。
- `studio-web/test/component-prop-editor.test.ts`（7 条）
  —— 各类型控件的渲染与回调（jsdom + react-dom/client）。
- `design-runtime/test/component-properties.test.ts`（26 条）
  —— 声明 / 绑定 / 解绑 / 删除属性、实例值的设置与重置、
  物化顺序（属性覆盖 override）、变体切换保留属性值、
  override 被属性绑定字段拒绝、新三类型的绑定与取值、
  实例交换真的换掉了内部实例、共享声明的增删与清理。

## 11. 参照来源

- Figma 组件属性（component properties）：
  <https://help.figma.com/hc/en-us/articles/15339657135383>
- Penpot 的变体属性实现（作为「变体属性 ≠ 组件属性」的对照）：
  `common/src/app/common/logic/variants.cljc`
- 本项目变体规格：`docs/component-variants.md`
