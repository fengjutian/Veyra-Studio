# 原型运行时规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`figma-gap-roadmap.md`、`interactions.ts`

## 1. 范围

数据层（`design-schema/src/interactions.ts`）此前已经定义了事件、动作、动画与 overlay 定位，
但没有运行时——交互只是「写在文档里的意图」。本轮补上预览：

| 能力 | 状态 |
| --- | --- |
| 点击（含冒泡）、鼠标按下、悬停进入/离开、延迟触发 | ✅ |
| navigate / open-overlay / toggle-overlay / close-overlay / prev-screen / open-url | ✅ |
| overlay 定位（center / 四角 / manual）与背景遮罩、点外部关闭 | ✅ |
| dissolve / slide / push 动画 | ✅ |
| 滚动保持（`preserveScroll`） | ✅（见第 7 节） |
| 原型内滚动容器 | ✅（见第 8 节；节点字段 `overflow` 的 schema 补丁待合入） |
| 固定元素（sticky / fixed） | ❌ |

## 2. 分层

```
prototype/
  state.ts             纯状态机（Node 里可测，不依赖 DOM）
  overlay-position.ts  overlay 定位计算（纯函数）
  scene-build.ts       子树场景构建 + 整体平移
  preview-layer.tsx    单层 canvas（屏幕 / overlay）
  preview.tsx          React 外壳：布局、命中、计时器、动画、退出
```

**状态机与渲染分离**是这一层的核心决定：跳转规则可以在单元测试里穷举，
不必起浏览器；React 外壳只负责把状态画出来、把指针事件翻译成状态机事件。

滚动相关也按这条线分：宿主判定与滚动几何在 `scene-build.ts`（纯函数），
滚动状态与保存 / 恢复规则在 `state.ts`（纯函数），滚轮事件与画布重绘在 `preview.tsx`。

## 3. 状态机

```ts
interface PrototypeState {
  screenId: NodeId;            // 当前屏幕
  previousScreenId?: NodeId;   // 正在退出的上一屏（动画结束清掉）
  history: NodeId[];           // prev-screen / back 用
  overlays: Array<{ nodeId; interaction; triggerNodeId }>;
  transition?: { id: number; animation?: PrototypeAnimation };
  seq: number;
  scroll: Record<NodeId, ScrollOffset>;        // 各滚动宿主的当前偏移
  scrollMemory: Record<NodeId, ScrollOffset>;  // 各滚动宿主被记住的偏移
}
```

事件：`click` / `press` / `hover-in` / `hover-out` / `after-delay` / `click-outside` /
`back` / `animation-end` / `scroll`。
`dispatchPrototype()` 返回 `{ state, openUrl? }`——外链是**副作用而不是状态**，
由 React 外壳执行 `window.open`，状态机保持纯函数。

关键规则：

1. **命中向上冒泡**：从最深命中节点沿 `parentId` 找第一条匹配事件的交互，
   所以按钮里的文字不需要自己再挂一条交互；更深节点的交互优先。
2. **非法目标什么都不做**：目标不存在、缺 destination、动作与字段不匹配时原样返回——
   预览里的一次误点不该把运行时打崩或带到空白页。
3. **导航清空 overlay**：切屏时 overlay 一并关闭；`prev-screen` 回退历史栈。
4. **同一 overlay 不重复入栈**：重复点击 `open-overlay` 不会叠出两层一样的东西。

## 4. 渲染

- 每个层（屏 / overlay）一张 canvas，复用 `buildNode` + `createCanvas2DRenderer`；
- 屏幕按「自己的盒子左上角对齐视口原点」平移，overlay 按定位结果平移；
  布局仍由 `computePageLayout` 按页面坐标算一次，渲染层只做坐标变换；
- overlay 层用 `background: "transparent"` 绘制，否则会盖住下面的屏幕；
- 图片走与编辑器相同的对象 URL 加载路径。

## 5. 动画

用 DOM 层的 CSS keyframes，时长与缓动内联在图层上：

| 类型 | 进入屏 | 退出屏 |
| --- | --- | --- |
| dissolve | `proto-fade-in` | 静止（被淡入覆盖） |
| slide | `proto-slide-in-{direction}` | 静止（被覆盖） |
| push | `proto-push-in-{direction}` | `proto-push-out-{direction}` 的反向位移 |

`direction` 表示**新屏进入的方向**（right = 从右侧推入）。动画结束后
`animation-end` 事件清掉 `previousScreenId`，避免旧屏一直叠在下面。

## 6. 入口与退出

顶栏「预览」按钮：优先用当前选中的容器型节点（frame / component / instance）作为起始屏，
否则用当前页面的第一个根节点；页面为空时给状态栏提示而不是进入空白预览。
Esc 或工具栏「退出预览」关闭；「返回」按钮等价于 `back`。

## 7. 滚动保持

`Interaction.preserveScroll?: boolean` 在数据层早就建模了（`interactions.ts` / `schema.ts` 都有），
但此前**没有任何运行时消费它**——navigate 总是从新屏左上角开始。本轮把它接上。

### 7.1 语义

| `preserveScroll` | 到达目标屏时 |
| --- | --- |
| `true` | 恢复该屏**上次离开时记住的**滚动位置 |
| `false` / 缺省 | 滚动位置重置为 `0`（顶部） |

交互配置示例：

```ts
// 点击「查看详情」：跳到详情页，并保留详情页上次的滚动位置
{
  eventType: "click",
  actionType: "navigate",
  destination: "screen:detail",
  preserveScroll: true,
}
```

### 7.2 与 Figma 的命名差异

Figma 那边**默认保留**滚动位置，交互面板里的复选框叫「Reset scroll position」——
勾上才重置。本项目反过来：`preserveScroll` 是**正向**开关，缺省 `false` 等于重置。

理由：

- 默认值写死在数据层（`defaultInteraction()` 直接返回 `preserveScroll: false`），
  命令层不必再推断「用户到底勾没勾过那个反向复选框」；
- 正向字段能整体进 schema 与 MCP 命令（「跳过去并保持滚动」是一个完整意图），
  反向复选框需要一个额外的「未设置」态。

### 7.3 记忆范围与时机

- 记忆的单位是**滚动宿主**（顶层 frame + 显式声明可滚动的容器），按节点 id 记；
- **保存**：离开一屏时（`navigate` / `prev-screen` / `back`）把该屏内各宿主的当前偏移写进 `scrollMemory`；
- **恢复**：到达目标屏时，`preserveScroll: true` 读 `scrollMemory`（没有记忆就是 `0`），
  否则把目标屏各宿主的当前偏移直接清零；
- `back` / `prev-screen` 一律**保持**：「返回」就是回到刚才待过的地方，
  所以它们按 `preserveScroll: true` 处理；
- 到达时的「重置」只改**当前偏移**，记忆要等离开这一屏时才被当前偏移覆盖。

### 7.4 夹紧

恢复出来的位置要按**当前**内容的最大可滚动距离夹紧（`clampScroll`）：
内容在这一轮里变短了，就不能停在一片空白上。

## 8. 原型内滚动容器

### 8.1 声明

滚动容器靠节点上的可选字段 `overflow` 声明：

| 值 | 语义 |
| --- | --- |
| `"scroll"` | 内容超出盒子时可以滚动，超出部分被裁切 |
| `"hidden"` | 裁切但不滚动（**缺省**，与现有 frame 的裁剪行为一致） |
| `"visible"` | 不裁切，内容溢出可见 |

顶层 frame **默认**是滚动宿主——Figma 的原型语义就是画板内容溢出时可以滚，
不需要额外声明；显式写 `overflow: "hidden"` / `"visible"` 才放弃这个身份。
其余容器必须显式 `overflow: "scroll"` 才是滚动宿主。

> ⚠️ `overflow` 字段还没进 `design-schema` 的类型与 schema（`types.ts` / `schema.ts` 不在本轮改动范围内），
> 需要父级应用补丁，片段见交付报告。在补丁落地前，运行时读不到这个字段
> （zod 会剥掉未声明的键），滚动容器能力只对**已经在内存里**的文档生效。

### 8.2 滚动行为

- 滚轮落在哪个宿主上就滚哪个：从命中路径**最深往上**找第一个「能滚」的宿主；
- 滚不动的宿主（内容没超出盒子）会被跳过，继续往外找；
- 偏移夹紧在 `[0, maxScroll]`，`maxScroll` 由子节点相对宿主盒子的超出量算出来；
- 超出盒子的内容仍然被裁切（容器照常 clip），滚动只是把内容在盒子里挪动；
- 偏移模型是二维的（`deltaX` / `deltaY`），滚轮主要给纵向。

滚轮事件用**非被动**监听器（`passive: false`）接：React 的 `onWheel` 在根容器上是被动监听，
`preventDefault()` 不生效，浏览器会把外层预览区一起滚走。

### 8.3 限制

- 没有滚动条 UI，也没有惯性 / 平滑滚动；
- 不支持固定元素（sticky / fixed）；
- 滚动只影响原型预览，不影响编辑画布；
- `overflow: "visible"` 只影响原型预览里的裁切，编辑画布的裁切行为另有实现。

## 9. 已知限制

- `mouse-over` 只在进入节点时触发一次（不做每帧触发，否则悬停动作会自我循环）；`mouse-enter` 优先于它；
- 滚动保持只认 `navigate` 动作上的 `preserveScroll`；`open-overlay` 等动作带着这个字段只是残留，不生效；
- 滚动容器没有滚动条 UI、没有惯性滚动，也不支持固定元素（sticky / fixed）；
- `overflow` 字段的 schema 补丁未合入前，滚动容器只在内存文档里可用（第 8.1 节）；
- push 的位移量按视口宽度整屏计算，不做「部分推入」；
- 预览固定 960×680、不缩放（窗口小时外层滚动）。

## 10. 测试

| 文件 | 覆盖 |
| --- | --- |
| `studio-web/test/prototype-state.test.ts` | 起始校验、冒泡与最深层优先、非法目标无操作、导航历史、overlay 开关/点外部、返回、外链副作用、动画结束、after-delay 排程、辅助函数、状态不可变 |
| `studio-web/test/prototype-overlay-position.test.ts` | 居中、四角、manual 相对触发节点、无基准兜底 |
| `studio-web/test/prototype-scroll.test.ts` | 滚动位置保存、返回时恢复、不保留时重置为 0、偏移边界夹紧、最大可滚动距离、场景平移、滚轮命中滚动宿主（jsdom） |
