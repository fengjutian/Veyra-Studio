# 设计 lint

> 文档状态：生效中的实现规格
> 建立日期：2026-11-09
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.7.0`）

## 1. 与校验的分工

| | `validateDocument()` | `lintDocument()` |
| --- | --- | --- |
| 管什么 | **合法性**：引用缺失、环、越界值 | **质量**：硬编码、未绑 token、栅格漂移、重名 |
| 失败后果 | 保存/导入被拒绝 | 只提示，不阻止任何操作 |
| 是否改文档 | 否 | 否 |
| 是否进事务 | 否 | 否 |

lint 结论在「数据 → 设计检查」里逐条列出，点一行选中对应节点——否则
「有 37 个硬编码颜色」这种提示没法用。

## 2. 规则

规则只在**文档确实有对应 token 体系**时才报告：没有任何颜色 token 的文档本来就
该用字面色，报硬编码只会制造噪声。

### 2.1 单节点规则（看一个节点自己）

| 规则 | 严重程度 | 触发条件 | 说明 |
| --- | --- | --- | --- |
| `hardcoded-fill` | info | 有颜色 token、填充是实色、且没有绑定（别名也算绑定） | 渐变不报——颜色 token 只能表达单色 |
| `hardcoded-stroke` | info | 有颜色 token、描边是字面色 | |
| `unbound-spacing` | info | 有数值 token、stack 容器 `gap > 0`、没有绑 `spacing` | |
| `off-grid` | warning | 绝对定位节点的 `x` / `y` 不是 `grid`（默认 8）的倍数 | **只看位置**：尺寸常由内容/图片决定，把宽高算进来会淹没「整页偏了 3px」这个真问题 |
| `duplicate-name` | info | 同一父级下有两个以上同名节点 | 跨页不算同级 |
| `empty-text` | info | 文本节点内容为空（只有空白也算） | 导出物里就是一个空标签，读屏器读不出任何东西 |
| `tiny-text` | warning | 文本字号 < 12px | 12px 是公认的「再小就读不清」下限；正文更常见的下限是 16px，但把 12–16px 一律报出来会淹没真正的 8px 事故 |
| `interactive-without-name` | warning | 节点有交互，但名字是空的或「Frame」「矩形」这类自动生成的通用名 | 读屏只会念出一个「框架」，用户不知道点它会发生什么 |

### 2.2 跨节点规则（看节点之间的关系）

单节点规则看不出设计系统腐坏——腐坏恰恰表现在**关系**上：同一个按钮在两个页面
长得不一样、变体集里有属性没被覆盖、实例设了组件没声明的属性。

| 规则 | 严重程度 | 触发条件 | 说明 |
| --- | --- | --- | --- |
| `page-size-mismatch` | warning | 两个以上页面的根框**固定尺寸**不一致 | `hug` / `fill` 的尺寸是算出来的，比了没意义 |
| `cross-page-inconsistency` | warning | **同名 + 同类型 + 跨页面**，且尺寸/填充色/字号有差异 | 位置不比——同一个组件在不同页面本来就该放在不同位置；同名但类型不同不比（叫「内容」的 frame 和 text 本来就不该一样） |
| `variant-property-missing` | warning | 变体集声明的属性，没在某个成员变体的 `variant` 上覆盖 | 少一个取值，那个变体在实例里就没法被正确区分 |
| `instance-unknown-property` | warning | 实例的 `propValues` 里有组件没声明的属性 | 组件删/改名属性后，旧值会留在文档里：既不生效也不会被自动清掉，用户改组件属性时看不见这个幽灵值 |
| `unused-component-property` | info | 组件声明了属性，但组件子树里没有任何节点绑定它 | 属性没接线：改它不会有任何视觉变化，留着只会让人以为「这个参数管用」 |

被布局引擎托管的位置不检查：stack / grid 容器的子节点坐标由布局算，
报它们没有意义。

每条结论带 `nodeId` 与可选的 `detail`（具体颜色、间距、坐标、重名节点列表、
差异的两侧节点 id 等），面板据此展示与定位。

## 3. 可配置项

```ts
lintDocument(document, {
  grid: 8,                       // 设成 1 等于关闭栅格规则
  rules: { "off-grid": false },  // 按规则关闭
});
```

默认值：`grid = 8`（与常见设计系统一致），所有规则开启。

## 4. 验收

### 4.1 单节点规则

- 没有颜色 token 的文档不报硬编码填充；有 token 时报告并给出颜色值；
- 绑定 token（含别名）后不再报告；
- stack 间距未绑数值 token 时报告，绑定后消失；无数值 token 时不报；
- `x = 13` 报告 `off-grid`，stack 子节点不报告；`grid: 1` 或按规则关闭时消失；
- 同级重名只报一条并列出全部节点；跨页同名不报；
- 空文本报 `empty-text`；字号 8px 报 `tiny-text`，16px 不报；
- 带交互且名字是「Frame」报 `interactive-without-name`，名字是「提交按钮」不报；
- 空文档没有结论。

### 4.2 跨节点规则

- 两个页面画板尺寸不一致报 `page-size-mismatch`；一致时不报；`hug` 尺寸不比；
- 同名同类型节点跨页尺寸不同报 `cross-page-inconsistency`，detail 给出两侧尺寸；
- 同名节点在同一页**不**报；同名但类型不同**不**报；
- 变体集的属性没被某个变体覆盖时报 `variant-property-missing`，detail 指出缺哪个；
- 实例设置组件没声明的属性时报 `instance-unknown-property`；
- 组件声明的属性没有绑定到任何节点时报 `unused-component-property`；
- 新规则都可以按 `rules` 逐条关掉。

## 4.3 哪些结论能交给模型自动改

体检层（`collectSelfCheck`）只把**有明确修法**的结论放进「待修清单」回喂给模型，
`lintIssueActionable(code)` 是这条分流的唯一依据：

| 结论 | 能自动修 | 为什么 |
| --- | --- | --- |
| `hardcoded-fill` / `hardcoded-stroke` / `unbound-spacing` | 是 | 绑到哪个 token 有唯一答案（同名 token） |
| `off-grid` / `duplicate-name` | 是 | 挪到栅格上、去掉重名 |
| `variant-property-missing` | 是 | 补上缺的变体取值 |
| `instance-unknown-property` | 是 | 删掉组件没声明的属性值 |
| `empty-text` / `tiny-text` / `interactive-without-name` | 是 | 填内容、放大字号、起个名字 |
| `page-size-mismatch` | **否** | 统一成多大？没有唯一答案 |
| `cross-page-inconsistency` | **否** | 以哪一边为准？没有唯一答案 |
| `unused-component-property` | **否** | 该删属性还是该加绑定？没有唯一答案 |

后三条**仍然显示在「设计检查」面板里**（人能看到、能自己处理），只是不进模型待修
清单——把没有唯一答案的问题丢给模型，它只能反复瞎猜，那正是编排循环「震荡」停止
条件的来源。

## 5. 仍未完成

- **没有自动修复**：所有结论只提示，不会批量替换成 token。
- **规则种类仍有限**：还没有「命名规范」「空容器」「组件脱离变体」等规则；
  可访问性这一组只覆盖设计稿**内容**能表达的东西（空文本、字号、交互节点的名字），
  导出的 HTML/SVG 里的 ARIA 语义还没有审查。
- **没有规则配置界面**：栅格与开关目前只能通过 API 传入。
- **不进导出诊断**：lint 是编辑器内的质量视图，不写进交付物。
- **跨页面一致性只看视觉属性**：结构上的不一致（比如两页的同名 frame 层级结构
  不同）没有覆盖。
