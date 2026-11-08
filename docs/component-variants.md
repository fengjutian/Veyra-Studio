# 组件变体规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`figma-gap-roadmap.md`、`project-progress-and-version-roadmap.md`

## 1. 要解决的问题

在此之前组件只有「一个定义 ↔ 若干实例」，一个按钮的主态/悬停态/禁用态只能建成
N 个互不相关的组件：改一次圆角要改 N 次，实例也没法在状态之间切换。

本轮补上**变体集（component set）**：一组互斥的组件，实例可以在成员之间切换。

## 2. 数据模型

```ts
interface ComponentSetDefinition {
  id: string;
  name: string;
  /** 变体属性名，顺序即 UI 展示顺序。 */
  properties: string[];
}

interface ComponentDefinition {
  // 原有字段 …
  variantSetId?: string;              // 所属变体集；缺省 = 独立组件
  variant?: Record<string, string>;   // 取值，必须覆盖集合声明的全部属性
}

interface DesignDocument {
  componentSets?: Record<string, ComponentSetDefinition>;  // 可选，旧文档无需迁移
}
```

两个决定：

1. **集合只声明属性名，不存成员列表**。成员靠 `components[*].variantSetId` 反查——
   两处都存的话，删组件时一定有一边忘了改。
2. **可选字段、不升文档格式版本**。没有 `componentSets` 的旧文档行为不变。

## 3. 命令

| 命令 | 作用 | 校验 |
| --- | --- | --- |
| `component.setCreate` | 注册变体集 | id/名字非空、属性名唯一、集合不重名 |
| `component.setVariant` | 把已有组件登记为成员 | 集合存在、取值覆盖全部属性、同集合内不重复 |
| `component.createVariant` | 从现有组件复制出新变体 | 源组件必须已属于某个集合；新 id 不重复；取值合法 |
| `component.switchVariant` | 实例切换到同集成员 | 目标存在、两组件 belong 同一集合 |

**复制发生在运行时而不是 UI**：新组件的根子树需要全新且唯一的 id，统一用
`${新组件 id}--${源节点 id}` 生成，与实例物化的命名规则一致，便于回查来源。
新根挂在源根所在的容器里、紧跟源根之后，一次事务完成。

**切换语义**：删掉实例旧的物化子树 → 按新组件重新物化 → 覆盖按源节点 id 取交集后应用。
实例自身的 id、位置和尺寸不变，所以选中状态与撤销历史不会断。

**集合自动解散**：`component.remove` 删到只剩一个成员时，把最后那个成员退回普通组件
并删除集合——「只有一个变体」没有切换语义，留着只会让 UI 显示一个永远只有一项的下拉框。

## 4. UI

- **组件面板**：行内显示变体取值（如 `state=hover`）；「创建变体」按钮打开表单
  （属性名可逗号分隔多个；首次创建按属性填当前值/新值，已有集合只填新值），
  建立后集合属性不可修改，当前组件会登记为填写的「当前值」；
- **实例面板**：组件属于多成员集合时显示「变体」下拉框，切换即提交 `component.switchVariant`。

## 5. 已知限制（v1）

- 变体集属性在**建立时**确定（逗号分隔多个属性名），之后不可增删；
  新建变体按属性逐个填写新值，已有集合只填新值、当前值写在字段提示里。
- 切换变体时，由「复制为变体」产生的节点 id 与源不同，因此**旧覆盖无法映射到新变体**，
  会被清空。Figma 是按属性映射，那需要一套「属性 → 节点」对应表，留到后续。
- 变体之间没有「共享结构」的约束：复制出来的子树与源完全独立，改源不会同步到其它变体
  （与 Figma 的 component set 一致，但对比「只是换颜色」的场景略重）。
- 导出不区分变体：实例仍然导出物化子树，`component-instance` 诊断不变。

## 6. 测试

| 文件 | 覆盖 |
| --- | --- |
| `design-runtime/test/component.test.ts` | 复制变体、切换实例、旧子树清理、覆盖清空、重复/缺属性/跨集合拒绝、集合解散 |
| `studio-web/test/component-variants.test.ts` | 选项排序与激活标记、独立组件/单成员集合返回空、面板摘要带变体文案 |
| `design-schema/src/validate.ts` | 导入校验：缺失集合、未知/缺失属性、集合内取值重复 |
