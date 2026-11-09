# 可访问性自动化（键盘遍历 + 屏幕阅读器）

`0.7.0` 与 `0.9.0` 都欠着同一件事：**用机器证明键盘用户和读屏用户能真正用到 Studio**。
本文说明这套自动化怎么工作、判据是什么、覆盖到哪里、还差什么。

```bash
npm run visual:a11y:check            # 组件级：跑规则 + 与基线比较，出错即失败
npm run visual:a11y:check -- --require-browser   # CI 里让「没有浏览器」明确失败
npm run visual:a11y:baseline         # 语义有意变化后更新基线
npm run visual:a11y:check -- --url=http://127.0.0.1:5173/   # 临时查任意页面
npm run visual:a11y:app              # 整应用：对构建产物跑真实界面
npm run visual:a11y:app -- --verbose # 额外打印 Tab 落点序列与 DOM 顺序
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

## 两层检查

| | 组件级（`visual:a11y:check`） | 整应用（`visual:a11y:app`） |
| --- | --- | --- |
| 页面 | `harness/a11y-workbench.tsx` | 构建产物 `packages/studio-web/dist` |
| 覆盖 | 工具栏 / 画布 listbox / 属性面板的**组件** | 顶栏、图层面板、**五个检查器分段**（属性 / 导出 / 历史 / 数据 / AI）的真实界面 |
| 启动方式 | `file://` 直接打开 | `http://127.0.0.1:<随机端口>` 起静态服务 |
| 数据 | 固定 fixture | 用真实的「导入 JSON」入口灌一份 fixture 文档 |
| 基线 | 有（语义快照） | 无（对着真实界面跑规则） |

整应用必须走 http：`file://` 下浏览器禁掉 IndexedDB，而 Studio 的项目仓库是
Dexie + IndexedDB，`file://` 打开只能看到空壳。

## 规则清单

| 规则 | 级别 | 判据 |
| --- | --- | --- |
| `missing-accessible-name` | 错误 | Tab 落点没有可访问名（AX 名为空且 DOM 近似计算也为空） |
| `ax-name-missing` | 错误 | AX 树里交互角色（button / link / textbox / option …）没有名字 |
| `positive-tabindex` | 错误 | 存在 `tabindex > 0` |
| `focus-order-mismatch` | 错误 | Tab 顺序与 DOM 顺序不一致 |
| `unreachable-by-keyboard` | 错误 | DOM 里可聚焦，Tab 却到不了（只认遍历前后都存在的控件） |
| `ax-keyboard-mismatch` | 错误 | AX 标为可聚焦的同名节点比键盘能到的多 |
| `focus-trap` | 错误 | **同一个节点**被反复落点 |
| `arrow-traversal-incomplete` | 错误 | 复合控件内方向键没走完所有选项 |
| `arrow-traversal-escape` | 错误 | 方向键把焦点带出了控件 |
| `no-focus-indicator` | 警告 | 聚焦前后样式签名没有任何变化（看不到焦点在哪） |

`no-focus-indicator` 的判据是**比对聚焦前后的计算样式签名**（outline / box-shadow /
边框 / 背景），不是「有没有 outline」。Studio 的对话框输入框用边框变色表示聚焦，
只认 outline 会误报。

拿不到「聚焦前」基准时（元素是遍历途中才出现或才变得可 Tab 的），判据是**未知**
而不是「没变化」——把未知当成缺陷，就会把属性面板那批刚渲染出来的输入框全报一遍。

## 采集方式

- **键盘遍历**：`Input.dispatchKeyEvent` 派发真实 Tab 键（`rawKeyDown` + `keyUp`），
  每次读 `document.activeElement`。不是「模拟用户按 Tab 会怎样」，是浏览器真的按了 Tab。
- **读屏语义**：`Accessibility.getFullAXTree` 拿 AX 树，再把每个节点用
  `DOM.resolveNode` + `Runtime.callFunctionOn` 回查 DOM 元素，拿到节点身份与内容键。
- **复合控件**：画布给键盘/读屏用户的那条路径（视觉隐藏的 `listbox`）用方向键走一遍，
  确认每个画布节点都能被走到。

### 三套标识，各管一件事

真实界面里几十个图标按钮的文字都是空串，按文字拼标识会全部塌缩成同一个 id，
交叉验证就变成拿苹果比橘子。所以标识拆成三套：

| 标识 | 是什么 | 用来判断 |
| --- | --- | --- |
| `nodeKey` | DOM 节点身份（WeakMap 分配） | 是不是**同一个元素** |
| `key`（内容键） | 元素的可访问名 | 跨采集时刻**互相认领**（React 重渲染后仍然有效） |
| `auditId` | `data-audit-id` > `data-node-id` > `#id` > 内容键 | 报告里给人看的名字 |

焦点落点的**角色**以 AX 为准（读屏念的就是它）。只看 DOM 的 `role` 属性会把原生控件
记成「无角色」——`<button>` 并没有 `role="button"` 属性。

### 真实界面会边走边变

采集端有三处专门对付「界面在遍历途中变」：

- **等界面稳定**：连续两次 DOM 扫描一致才采信（Radix 的 roving tabindex 会滞后一拍）。
- **遍历前 / 遍历后取交集**：只认前后都存在的控件。选中画布节点后属性面板才启用一批
  控件，Radix 的分段控件重渲染后 `tabindex` 会从 0 变成 -1——这些瞬时状态不算缺陷。
- **增量补采样式基准**：每次按 Tab 之前，把「刚变得可 Tab 的元素」的聚焦前样式补上。

### 焦点代理（Radix 的复合控件）

Radix 的分段栏自己 `tabindex=0`，但 Tab 落上去后焦点会转交给内部的标签页——键盘
**到得了**它，只是焦点没停在它身上。祖先链（祖先的**内容键**，不是节点身份，
React 重渲染后才不会失效）能认出这种「焦点被重定向到后代」的情况。

### 遍历起点按 Tab 顺序算

HTML 规定正 tabindex 的元素排在**所有** tabindex=0 的元素**前面**。用 DOM 顺序当
起点会直接跳过它们——上一轮就是因此漏掉了阴性对照里的 `tabindex=3` 元素，连带报出
两条假的「键盘到不了」。

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

## 整应用走查查出来的真实缺陷

整应用探针跑通之后，一口气查出三个**真实**缺陷（不是仪器假阳性）：

1. **AI 指令输入框没有可访问名**（`ax-name-missing`）。
   `main.tsx` 里的 `<textarea value={prompt} …>` 既没有 `aria-label`，也没有关联的
   `<label>`——读屏只会念「文本框」。修法是补 `aria-label="AI 指令"`。
2. **检查器分段栏聚焦时没有任何可见指示**（`no-focus-indicator`）。
   Radix 给分段栏容器写了**内联** `style="outline:none"`（它把焦点委托给内部的标签页），
   class 里的 `outline` 压不过内联样式。修法是用 `box-shadow` 画焦点环。
3. **图层搜索框聚焦时没有任何可见指示**。
   `.layer-search input{...outline:none}` 的特异度（0,1,1）压过了全局的
   `:focus-visible{outline:...}`（0,1,0）（WCAG 2.4.7 Focus Visible）。
   修法是补一条 `.layer-search input:focus-visible{outline:...}`。

后两条都是 WCAG 2.4.7 Focus Visible 的违反——键盘用户按完 Tab 不知道焦点在哪。

## 仪器自己的坑（每一条都踩过）

自动化本身也会骗人。下面几条都是这一轮实际踩出来的，写下来是为了下次别再踩：

- **基准拿不到 ≠ 没有焦点指示**。属性面板的输入框是选中节点后才渲染出来的，初始扫描
  里没有它们，于是「聚焦前后没变化」——其实它们有 2px 的焦点环。基准缺失要判**未知**。
- **基准不能在元素已经获得焦点之后采**。画布 option 的 roving tabindex 让它「先被选中
  才可 Tab」，采到的就是聚焦后的样式。
- **「DOM 顺序第一个」不是「Tab 顺序第一个」**。正 tabindex 排前面，用错会漏元素。
- **`.click()` 切不动 Radix 的分段**。它监听的是 `mousedown`，脚本 click 只派发 click
  事件——五个分段其实查的是同一个界面。必须用 CDP 派发真实鼠标事件。
- **label 的文本要排除控件自身**。`<label>对齐<select>…</select></label>` 的可访问名是
  「对齐」，不是「对齐左对齐居中右对齐」（HTML-AAM）。
- **Radix 的 roving focus 会在鼠标点过分段后把 `tabindex` 放回容器上**，于是容器成了
  一个额外的 Tab 停靠点——所以它必须有自己的焦点环。

## 覆盖范围与已知限制

**覆盖**

- 画布的隐藏 `listbox`（键盘/读屏进入画布结构的唯一路径）：Tab 能进、方向键能走完
  每个节点、每个选项都有名字
- 工具栏、图层面板、属性面板的控件：可访问名、焦点顺序、焦点可见性
- 五个检查器分段（属性 / 导出 / 历史 / 数据 / AI）的真实界面
- 阴性对照页面

**不覆盖（明确列出，避免误读）**

- **读屏器实测**：这里读的是 Chrome 的可访问性树（读屏器的数据来源），不是 NVDA /
  VoiceOver 的真实播报。真实读屏器的语音输出、快捷键冲突未覆盖。
- **只有 Chrome/Edge**：Firefox / Safari 的 AX 树细节与焦点行为未验证。
- **弹窗与右键菜单**：只查静态界面，弹窗（导入 token、AI 确认等）没有逐个走查。
- **对比度**：由 `packages/studio-application/src/accessibility.ts` 单独负责（按文档
  计算），此处不重复。
- **触屏与语音控制**：未覆盖。
