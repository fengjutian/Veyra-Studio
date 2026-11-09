# 可访问性自动化（键盘遍历 + 屏幕阅读器）

`0.7.0` 与 `0.9.0` 都欠着同一件事：**用机器证明键盘用户和读屏用户能真正用到 Studio**。
本文说明这套自动化怎么工作、判据是什么、覆盖到哪里、还差什么。

```bash
npm run visual:a11y:check            # 跑规则 + 与基线比较，出错即失败
npm run visual:a11y:check -- --require-browser   # CI 里让「没有浏览器」明确失败
npm run visual:a11y:baseline         # 语义有意变化后更新基线
npm run visual:a11y:check -- --url=http://127.0.0.1:5173/   # 临时查任意页面
```

## 一句话概括

用 CDP 派发**真实的 Tab 键**，读 Chrome 的**可访问性树（AX tree）**，把两边的结果
互相交叉验证，再和一份语义基线比对。

## 为什么要交叉验证

只看键盘或只看读屏都会漏：

| 情况 | 键盘看得见 | 读屏看得见 | 判定 |
| --- | --- | --- | --- |
| 正常控件 | ✓ | ✓ | 通过 |
| 空按钮（无 `aria-label`） | ✓ | 只有角色，没有名字 | **错误**：读屏只会念「按钮」 |
| `tabindex=3` | 顺序被顶到最前 | ✓ | **错误**：焦点顺序不可预测 |
| AX 说可聚焦，Tab 到不了 | ✗ | ✓ | **错误**：读屏能进、键盘进不去 |
| DOM 可聚焦，Tab 到不了 | ✗ | ✓ | **错误**：键盘用户够不着 |

规则层在 `packages/studio-web/src/renderer/a11y-audit.ts`，是纯函数：输入是采集到的
抽象数据，输出是 issue 列表。每条规则都有单测（含阴性对照）。

## 规则清单

| 规则 | 级别 | 判据 |
| --- | --- | --- |
| `missing-accessible-name` | 错误 | Tab 落点没有可访问名（AX 名为空且 DOM 近似计算也为空） |
| `ax-name-missing` | 错误 | AX 树里交互角色（button / link / textbox / option …）没有名字 |
| `positive-tabindex` | 错误 | 存在 `tabindex > 0` |
| `focus-order-mismatch` | 错误 | Tab 顺序与 DOM 顺序不一致 |
| `unreachable-by-keyboard` | 错误 | DOM 里可聚焦，Tab 却到不了 |
| `ax-keyboard-mismatch` | 错误 | AX 标为可聚焦，Tab 到不了 |
| `focus-trap` | 错误 | 同一个元素被反复落点，或落点数超过 DOM 里的可聚焦元素数 |
| `arrow-traversal-incomplete` | 错误 | 复合控件内方向键没走完所有选项 |
| `arrow-traversal-escape` | 错误 | 方向键把焦点带出了控件 |
| `no-focus-indicator` | 警告 | 聚焦前后样式签名没有任何变化（看不到焦点在哪） |

`no-focus-indicator` 的判据是**比对聚焦前后的计算样式签名**（outline / box-shadow /
边框 / 背景），不是「有没有 outline」。Studio 的对话框输入框用边框变色表示聚焦，
只认 outline 会误报。

## 采集方式

- **键盘遍历**：`Input.dispatchKeyEvent` 派发真实 Tab 键（`rawKeyDown` + `keyUp`），
  每次读 `document.activeElement`。不是「模拟用户按 Tab 会怎样」，是浏览器真的按了 Tab。
- **读屏语义**：`Accessibility.getFullAXTree` 拿 AX 树，再把每个节点用
  `DOM.resolveNode` + `Runtime.callFunctionOn` 回查 DOM 元素，拿到稳定标识。
- **复合控件**：画布给键盘/读屏用户的那条路径（视觉隐藏的 `listbox`）用方向键走一遍，
  确认每个画布节点都能被走到。

三处必须用**同一套标识规则**（`data-audit-id` > `data-node-id` > `#id` > `角色:文字`），
否则交叉验证就是拿苹果比橘子。这套规则集中在 `visual/a11y-page.ts`，有单测。

### 为什么不装 Playwright

只需要三件事：执行页面脚本、派发按键、读 AX 树。Node 24 自带 WebSocket，直接说 CDP
就够了，全仓库零新依赖。`visual/cdp.ts` 是手写的薄客户端（约 200 行）。

## 阴性对照

`harness/a11y-defects.tsx` 是一个**故意有缺陷**的页面：

1. 空按钮（没有可访问名）
2. `tabindex=3`（打乱 Tab 顺序）
3. 可聚焦但没有可见焦点指示的 div

探针每次都会跑这个页面，并断言这 5 条规则**确实报出来了**。规则要是没生效（页面改了、
采集断了、判定写错了），这里就会红——否则「检查通过」只是因为什么都没检查。

## 基线

`packages/studio-web/visual/a11y-baseline.json` 记的是**语义快照**，不是像素：

- `focusOrder`：Tab 落点顺序，每一步的标识、角色、可访问名
- `announcements`：AX 树里交互节点的「角色：名称」，也就是读屏会念的内容

语义变了（按钮改名、焦点顺序调整、控件丢了 `aria-label`）基线会抓住，而这类改动
在像素基线里完全看不出来。

基线**不绑定平台**（语义与字体、操作系统无关），所以可以直接进 `check:visual`；
字体度量基线绑平台，所以没进。

## 覆盖范围与已知限制

**覆盖**

- 画布的隐藏 `listbox`（键盘/读屏进入画布结构的唯一路径）：Tab 能进、方向键能走完
  每个节点、每个选项都有名字
- 工具栏、图层面板、属性面板的控件：可访问名、焦点顺序、焦点可见性
- 阴性对照页面

**不覆盖（明确列出，避免误读）**

- **整应用端到端**：harness 是组件级工作台（用真实组件与真实标记），不是把整个
  Studio 跑起来逐控件检查。整应用检查需要先起服务并灌入项目数据，目前未做。
- **读屏器实测**：这里读的是 Chrome 的可访问性树（读屏器的数据来源），不是 NVDA /
  VoiceOver 的真实播报。真实读屏器的语音输出、快捷键冲突未覆盖。
- **只有 Chrome/Edge**：Firefox / Safari 的 AX 树细节与焦点行为未验证。
- **对比度**：由 `packages/studio-application/src/accessibility.ts` 单独负责（按文档
  计算），此处不重复。
- **触屏与语音控制**：未覆盖。

## 顺手修掉的一个真实缺陷

`.layer-search input{...outline:none}` 的特异度（0,1,1）压过了全局的
`:focus-visible{outline:...}`（0,1,0），图层搜索框聚焦时**没有任何可见的焦点指示**
（WCAG 2.4.7 Focus Visible）。自动化第一次跑出来时它就在报告里；修法是补一条
`.layer-search input:focus-visible{outline:...}`。

这也说明为什么判据要比对「聚焦前后的样式签名」：只看 outline 会漏掉「用边框变色
表示聚焦」这种合规做法，也会误报它们。
