# 原型运行时规格

> 文档状态：生效中的实现规格
> 建立日期：2026-11-08
> 关联文档：`current-project-status.md`、`figma-gap-roadmap.md`、`interactions.ts`

## 1. 范围

数据层（`design-schema/src/interactions.ts`）此前已经定义了事件、动作、动画与 overlay 定位，
但没有运行时——交互只是「写在文档里的意图」。本轮补上预览：

| 能力 | 状态 |
| --- | --- |
| 点击（含冒泡）、悬停进入、延迟触发 | ✅ |
| navigate / open-overlay / toggle-overlay / close-overlay / prev-screen / open-url | ✅ |
| overlay 定位（center / 四角 / manual）与背景遮罩、点外部关闭 | ✅ |
| dissolve / slide / push 动画 | ✅ |
| 鼠标按下、悬停离开（mouse-press / mouse-over / mouse-leave） | ❌ |
| `preserveScroll`、原型内滚动容器、固定元素 | ❌ |

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

## 3. 状态机

```ts
interface PrototypeState {
  screenId: NodeId;            // 当前屏幕
  previousScreenId?: NodeId;   // 正在退出的上一屏（动画结束清掉）
  history: NodeId[];           // prev-screen / back 用
  overlays: Array<{ nodeId; interaction; triggerNodeId }>;
  transition?: { id: number; animation?: PrototypeAnimation };
  seq: number;
}
```

事件：`click` / `enter` / `after-delay` / `click-outside` / `back` / `animation-end`。
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

## 7. 已知限制

- `mouse-press` / `mouse-over` / `mouse-leave` 事件没有接线（数据可写、预览不响应）；
- `preserveScroll` 已建模但未消费：navigate 总是从新屏左上开始；
- 原型内没有滚动容器与固定元素的概念，长页面只能靠画板尺寸容纳；
- push 的位移量按视口宽度整屏计算，不做「部分推入」；
- 预览固定 960×680、不缩放（窗口小时外层滚动）。

## 8. 测试

| 文件 | 覆盖 |
| --- | --- |
| `studio-web/test/prototype-state.test.ts` | 起始校验、冒泡与最深层优先、非法目标无操作、导航历史、overlay 开关/点外部、返回、外链副作用、动画结束、after-delay 排程、辅助函数、状态不可变 |
| `studio-web/test/prototype-overlay-position.test.ts` | 居中、四角、manual 相对触发节点、无基准兜底 |
