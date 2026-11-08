# 当前项目状态

> 状态日期：2026-11-06  
> 用途：为开发者和 AI 提供当前实现范围的单一事实入口

## 一句话结论

当前项目的唯一开发方向是 **独立 AI Design Studio**。Studio 仍处于 Phase 0，现有代码
只是底层原型，还不是可用的独立设计应用。原 Vibma MCP-to-Figma bridge 已停止使用，
只保留为迁移和行为研究的遗留代码；不得把它作为产品运行时或新功能后端。

## 当前开发范围

### 独立 Studio 的 Phase 0 基础

- `packages/design-schema`：早期设计文档类型、Schema 与校验；节点校验按 `type` 使用判别
  联合，字段级错误不再被吞成一句 "Invalid input"（例如 `textAlign: "justify"` 会直接
  报出 `nodes.<id>.textAlign`）；文本节点新增可选的 `fontWeight`（100–900）、`fontStyle`、
  `textAlign`、`letterSpacing`，缺省值统一由 `TEXT_DEFAULTS` 兜底，旧文档无需迁移；
  文档格式版本升到 **4**，并提供迁移引擎：`CURRENT_SCHEMA_VERSION` 声明当前版本，
  `MIGRATIONS` 是 `旧版本 → 新版本` 的步骤表（当前登记 v1 → v2、v2 → v3、v3 → v4），
  `migrateDocument()` 把任意来源的数据升级到当前版本，失败抛 `MigrationError` 并带上原始版本号，
  成功则把迁移记录写进文档自带的 `migrations` 历史；`detectSchemaVersion()` 负责判断
  版本，高于当前版本或缺少版本的文档一律拒绝，不猜版本；
- **Grid 布局**（文档格式 v4 新增）：`LayoutSpec.mode` 新增 `grid`，与 `absolute` / `stack`
  平级；轨道配置放在可选的 `layout.grid` 上（`columns` / `rows` 各是一组轨道，
  每条轨道有 `fixed` / `fraction` / `auto` / `min-content` / `max-content` 五种类型），
  子节点占哪一格由 `grid.cells` 按子节点 id 声明（可跨行跨列）。
  `design-layout/src/grid.ts` 是唯一求解入口：测轨道固有尺寸 → fraction 按权重分剩余空间
  → 按单元格定位 → 格子内对齐；子节点超出已声明轨道数时**补出隐式轨道**（CSS Grid 语义），
  不钳位造成重叠。属性面板提供轨道编辑器（类型 / 尺寸 / 权重 / 增删）。
  HTML 导出输出 CSS Grid，SVG/PNG 用布局引擎解出的绝对盒子。
  语义对齐 Penpot 的 grid-layout，见 `figma-gap-roadmap.md`；
  **尚未实现**：拖拽调整轨道、命名网格区域、自动轨道（`auto-fill` / `auto-fit`）；
- `packages/design-runtime`：早期命令和运行时原型；`text.patch` 接受并校验上述文本样式字段；
- `packages/design-persistence`：文件系统快照、事务日志、资产存储，以及从最后有效快照
  连续重放已提交事务的崩溃恢复原型；仓库契约收敛为单一入口 `contract.ts`：
  `ProjectRepository` 接口、`ProjectNotFoundError`、快照与事务语义都由它定义，
  文件系统实现与浏览器实现共用 `loadDocumentPayload()`（迁移 + 校验）、
  `replayJournal()`（统一的重放与降级判定）、`assertSavableDocument()`、
  `normalizeAssetHash()`，两边的行为因此不会因为换了存储而改变；两个后端跑同一套
  契约测试（`contract-suite.ts`：快照往返、重放、断档降级、项目列表、删除、日志裁剪、
  资产去重、旧版本迁移）；保留策略统一为最近 10 份快照与 200 条事务，另有
  `pruneJournal()` 主动裁剪；包入口拆成浏览器安全的根入口与
  `@ufira/design-persistence/filesystem` 子入口，node 内置模块不再进浏览器包；
- `packages/design-layout`：宿主无关的 absolute/stack 布局原型，支持 fixed、fill、hug、
  padding、gap、对齐、文本测量接口和结构化布局警告；文本测量提供确定性的字符宽度估算器
  与宿主可注入的测量契约（`createHostTextMeasurer`），修复了 hug 文本高度不随可用宽度换行
  的缺陷；文本换行后超出自身盒高时会报 `text-overflow` 警告（此前该警告码只声明未产生）；
  文本测量把字重和字间距计入宽度（字距按"每个字符后加一次"、字重 ≥600 视为加粗并放大
  6%），宿主测量契约 `TextMeasurementRequest` 同步带上 `fontWeight`/`fontStyle`/
  `letterSpacing`；
- `packages/design-export`：独立 HTML/CSS 导出原型，保留布局与 CSS Token 语义，并对
  不支持或降级的特性输出诊断；新增独立 SVG 导出，SVG 几何由布局引擎解析，stack、fill、
  hug 语义与画布一致；HTML 导出输出 `font-weight`/`font-style`/`text-align`/
  `letter-spacing`，SVG 用 `text-anchor` + `x` 表达盒内对齐，缺省样式不写进 CSS，
  旧文档的导出结果保持不变；导出支持按选区裁剪：`nodeIds` 只导出选中节点所在的分支
  （选中节点连同子树，以及通往它们的祖先链），`origin` 把导出坐标整体平移，让选区落在
  视口左上角；不传这两个参数时导出结果与原来逐字一致；
- `packages/studio-application`：串联项目创建、命令事务、日志与快照、恢复、布局和
  HTML/SVG 导出的应用服务原型，并提供不修改真实项目的命令预演入口，作为未来工作台与
  AI Orchestrator 的共同入口；
- `packages/ai-orchestrator`：AI 安全编辑闭环的第一阶段原型，包含可替换 Planner
  契约、临时运行时 dry-run、before/after 预览、影响节点、warnings、取消、显式确认
  提交，以及基于 `baseRevision` 的过期计划拒绝；已实现 OpenAI-compatible
  `/chat/completions` Planner、命令提示、文档摘要和 JSON 计划解析；
- AI 请求的失败处理：网络错误、408/429/5xx 按指数退避重试（默认最多两次，
  可配置），超时抛 `AiTimeoutError`、用户取消抛 `AiCancelledError`，这两类都不重试；
  取消信号从界面一路透传到 fetch（内部 AbortController 与外部信号联动），退避
  等待期间取消也会立刻结束。规划失败或取消不会改动项目——计划只有在 dry-run
  成功之后才进入待确认状态，失败后可以直接重试；工作台在生成过程中提供
  「取消生成」按钮，不再只能等请求超时；
- AI 计划的结构审查（Reviewer）：dry-run 之后再看一遍"该不该改"——删除锁定节点、
  删除页面、包含整篇 `history.restore` 三类直接阻断，`SafeAiEditor.confirm()` 会抛
  `AiReviewBlockedError` 并拒绝提交；大批量删除（>10 个节点）、一次性新建（>20 个）、
  硬编码填充色给警告。结论带节点 id，界面在确认卡片里逐条列出并禁掉「确认提交」；
- AI 流式响应：Planner 以 `stream: true` 请求 `/chat/completions`，按 SSE 逐段解析
  `delta.content`，通过 `onDelta(delta, fullText)` 回调边收边显示；解析时容忍心跳与
  不认识的 `event:` 行，缺 `[DONE]` 也能在流结束时收尾，响应没有 body 时自动退回
  非流式 `text()`。已经开始输出增量的请求不再重试（否则用户会看到重复的半截内容），
  中途取消仍然立即中断；工作台在生成过程中显示实时文本；
- AI 凭据存储：服务地址、模型名和启用开关落在 `localStorage`，**API Key 只写
  `sessionStorage`**，关闭标签页即失效；没有 sessionStorage 时退化为内存保存。
  读取旧版本数据时会把原先写进 localStorage 的密钥迁到会话存储，并把磁盘副本里的
  密钥抹掉；保存空密钥会主动清掉会话里的密钥。密钥不会进入设计文档、事务日志、
  导出文件或 IndexedDB；
- AI 端点能力矩阵：`PROVIDER_PRESETS` 收录 OpenAI、DeepSeek、OpenRouter、Ollama、
  vLLM、LM Studio 的地址、默认模型与能力（是否支持 `json_object`、流式、鉴权方式），
  地址匹配支持大小写/尾斜杠归一化与「官方地址下挂代理」的更深路径；未收录的端点按
  通用协议处理，并保守地关闭 json 模式。设置面板会实时显示识别结果与能力标签，
  并可按预设一键填入地址和模型；`jsonMode` 现在由这张表决定，而不是写死；
- MCP adapter 的命令契约（无传输层）：`MCP_TOOLS` 只暴露三个工具——读取、预览、
  应用，避免工具列表过长让模型选错；命令类型用 `Record<DesignCommand["type"], true>`
  强制穷举，新增命令忘了登记会直接编译失败。`authorizeCommands()` 按策略判定
  放行与确认：白/黑名单、单次命令上限（默认 50）、整篇 `history.restore` 默认禁止
  （需显式 `allowDocumentRestore`）、破坏性命令即使关闭人工确认也仍然要确认；
  `createAuditEntry()` 记录工具、调用方、命令类型、修订号与结果，供审计；
- MCP stdio server：`npm run mcp:studio` 启动，读 `STUDIO_PROJECT_DIR` /
  `STUDIO_PROJECT_ID` 打开文件系统项目，处理 `initialize` / `tools/list` /
  `tools/call` / `ping`；`design.apply` 依次校验 revision、策略与审批，默认没有
  人工确认时返回 `approval_required` 而不是执行；审计记录写 stderr、stdout 只留
  JSON-RPC。`STUDIO_MCP_AUTO_APPROVE=1`、`STUDIO_MCP_ALLOWED_COMMANDS`、
  `STUDIO_MCP_ALLOW_RESTORE=1` 控制本会话的授权范围；
- MCP HTTP 传输：`npm run mcp:http` 提供 `POST /mcp` 与 `GET /healthz`，所有请求要求
  Bearer token，缺少令牌时拒绝启动（临时调试需显式 `STUDIO_MCP_HTTP_INSECURE=1`，
  此时随机生成一次性令牌并打印）；`initialize` 下发 `Mcp-Session-Id`，后续调用必须
  携带，会话按空闲时间过期，同一会话的请求串行执行；请求体上限 256 KB；
  未实现 SSE 服务端推送与 OAuth —— 当前工具都是请求-响应式，公网部署仍需反向代理
  再加一层鉴权；
- 画布渲染器：场景先压成纯数据的 `SceneNode` 树（`renderer/scene.ts`，布局盒 + 填充/描边/
  圆角/文字/图片，不碰 DOM），再由 Canvas 2D 渲染器按 `zoom × dpr` 绘制
  （`renderer/canvas-renderer.ts`），缩放时重绘而不是拉伸位图。分层借鉴 tldraw /
  Excalidraw：绘制走 Canvas，命中测试、选择框、拖拽手柄也走 Canvas，只有文本编辑保留
  DOM 覆盖层（所以输入法与文本选择行为不变）；图片走现有的对象 URL 缓存。
  渲染前按视口裁剪根节点
  （`renderer/culling.ts`，只裁根节点、保留子树，避免阴影/半截文本消失），视口随滚动
  与缩放更新；`npm run bench:paint` 测 200/1000/5000 节点的绘制耗时与绘制调用，并已并入
  `check:budgets`（1280×800 视口下 5000 节点只画 139 个根节点）；`npm run visual:canvas:paint`
  在真实 Chrome 里测绘制耗时（200/1000/5000 节点：完整 0.9/3.5/12.3 ms，裁剪后
  0.7/0.7/0.3 ms），并随 `check:visual` 做预算门禁。命中测试已有纯函数实现
  （`renderer/hit-test.ts`，最深命中 + 命中栈 + 裁剪/透明度/椭圆），选择层**已完全交给 Canvas**。
  选择框与手柄由 Canvas 绘制：`renderer/selection.ts` 提供包围盒合并、手柄命中与
  缩放后的盒子，`renderer/selection-overlay.ts` 负责轮廓/手柄绘制（随 zoom 保持屏幕尺寸）。
  由 Canvas 接管拖动与单节点缩放：预览盒子覆盖绘制、指针在捕获阶段处理，
  松手后按现有 `node.patch` 事务提交；空白处拖动可框选（Canvas 绘制选框、与顶层节点
  求交），松手直接更新选中集合。拖动时会按
  左/中/右、上/中/下对齐线做 6px（按 zoom 换算）吸附并绘制辅助线，松手按吸附后的
  位置提交。单击/Shift 单击、双击文本编辑（在布局盒上覆盖 `<textarea>`，提交走
  `text.patch`）与右键菜单都改用 Canvas 命中；**画布上不再有任何 DOM 节点副本**，
  只有一个 `<canvas>` 与按需出现的
  文本编辑框。为了不丢键盘与屏幕阅读器，画布同时挂载一个视觉隐藏的
  `listbox`（按图层顺序、支持上下/Home/End 移动并同步选中、Delete 删除、
  `aria-selected`/`aria-level`/`aria-disabled`）。旧的 Moveable/Selecto 交互层、
  DOM 节点副本与 `react-moveable` / `react-selecto` 依赖已随 Phase C 完成一并删除。
  场景构建与绘制调用都有单元测试
  （假 2D 上下文断言 fill/clip/drawImage/fillText），并另有真实 Chrome 里的像素回归
  （`visual:canvas:check`）与视口裁剪后的绘制耗时门禁（`visual:canvas:paint -- --budget`）。
  像素基线的 fixture 直接构造文档、不走 schema 校验，所以必须写 v3 的
  `appearance.fills`：此前它仍写 v2 时代的 `appearance.fill`，渐变落地后填充全部丢失，
  这条回归从那时起一直是红的（只是没人跑）。`harness/` 现已纳入 `studio-web` 的
  tsconfig include，fixture 与 schema 再漂移会直接编译失败，而不是静默丢渲染；
- `packages/studio-web`：可运行的 React 工作台垂直切片，包含本地图层列表、Canvas 画布、
  节点创建/选择/框选/拖动/缩放/吸附/删除、基础属性编辑、Dexie/IndexedDB 项目、事务
  和二进制资产存储，以及 AI 计划预览、过期提示、取消和确认提交界面；画布交互层
  完全走 Canvas（单击/双击编辑、拖拽/缩放、框选、吸附），
  支持 Shift/框选、多节点批量拖动、缩放和删除，
  所有群组变换在交互结束时作为一个原子事务提交；浏览器存储支持快照后事务重放、
  revision 缺口降级报告、资产哈希校验和旧 localStorage 快照迁移；已提供 AI 服务地址、
  模型和密钥设置入口，但尚未完成真实 Provider 的生产级端到端验证、流式体验和支持矩阵；
  工作台顶部支持项目列表、新建、切换、通过领域命令重命名，以及原子清理项目快照、
  事务和资产的删除操作；
- 工作台支持自动保存：事务日志即时写入（恢复的依据），快照合并写入（停止输入
  800ms 后落盘，连续几次编辑只写一份），顶栏实时显示「待自动保存 / 自动保存中 /
  已自动保存 / 自动保存失败」，页面关闭或切到后台时立即冲刷待写快照；存储配额
  耗尽会被识别并单独提示（提示导出 JSON 备份），不会被当成普通异常吞掉；
- 右侧栏改为分段面板（属性 / 导出 / 历史 / 数据 / AI）：属性页放选中节点的布局、外观、
  文字、实例覆盖与批量编辑，导出页放交付物预览与诊断，历史页放历史版本、操作历史、
  自动备份与恢复报告，数据页放设计 Token、图片资源和组件，AI 页放模型设置与安全编辑；
  数据页同时放存储用量：浏览器总额度 + 按项目拆分的占用明细（版本/日志/资源/历史份数）
  与可直接执行的清理清单（裁历史版本、删除旧项目）；
  标题右侧显示当前上下文（选中对象、导出范围、当前版本、资源与组件数、模型名），标签
  角标只在有布局警告、导出诊断或缺失资源时出现；内容区独立滚动，底部固定自动保存状态
  与存储用量。分段定义与标题文案抽在 `inspector-tabs.ts` 纯函数层并有单元测试，取代了
  原来把全部区块堆进一条长滚动列的布局；分段交互用 `@radix-ui/react-tabs`（RovingFocus），
  方向键 / Home / End 切换、`aria-selected` / `aria-controls` 与焦点归还都由 Radix 负责，
  不再需要手写 tablist；
- 画布工具体系（P1）：创建入口从「瞬时插入按钮」升级为「工具模式」——`select` / `frame` /
  `rectangle` / `ellipse` / `line` / `polygon` / `star` / `text` / `hand`
  （`packages/studio-web/src/tools.ts`，纯函数层）。
  图元工具下在画布上拖拽即绘制（Shift 等比、Alt 以按下点为中心展开），松手提交一条
  `node.create`、选中新节点并自动回到选择工具；不拖拽的单击按默认尺寸创建；拖出范围会
  钳制在画板内。工具状态是纯视图状态：不进文档、不涨 revision、不写快照。快捷键
  `V/F/R/O/L/G/S/T/H`，`Esc` 回到选择（再按一次清空选区）。绘制预览是 Canvas 上的虚线框，
  与框选共用绘制流程，因此也修掉了此前「选区为空时框选矩形不绘制」的缺陷
  （`canvas-surface` 原先在选区判空之后才画选框）；
- 形状族与矢量基础（P2）：直线、多边形、星形都是 `vector` 节点 + **归一化路径**
  （`design-schema/src/geometry.ts`：坐标落在 [0,1]、只允许 `M/L/Z`，解析结果按 `d` 缓存）。
  归一化让改宽高直接等于缩放图形，不需要重写路径；只放行 M/L/Z 是因为含 `C` 的路径一旦
  混进来，画布会少画一段、导出会输出另一段。命中测试按真实路径判定——闭合路径走奇偶规则，
  开放路径（直线）走到线段距离，所以一条对角线不会让整个包围盒都可点击。
  画布用绝对坐标 `moveTo/lineTo` 而不是 `ctx.scale()`，避免非等比缩放把描边拉粗。
  导出侧 SVG 输出 `<path d>`、HTML 输出内联 `<svg viewBox>`，`vector` 的支持等级从
  `unsupported` 升为 `exact`；没有 geometry 的旧节点仍按原来的空容器 + 诊断导出，
  golden 产物未变。`AppearanceSpec.strokeWidth` 也随本相位落地（画布/SVG/HTML/属性面板），
  缺省 1px 时导出字符串与升级前逐字相同；
- 四角独立圆角：`AppearanceSpec.cornerRadii`（四元组，顺序同 CSS `border-radius`），
  `resolveCornerRadii` 是画布/HTML/SVG 的唯一解析入口。画布每角一次 `arcTo`（半径 0 的角
  退化成直线，并统一钳到短边一半）；HTML 直接输出四值 `border-radius`；SVG 的 `<rect rx>`
  只有单值，四角不同时改输出 `<path>` + `A` 圆弧——**圆弧只存在于导出产物，文档格式仍然
  只有 M/L/Z**。四角相同时继续走单值分支，导出产物与升级前一致。属性面板在单值与四角之间
  切换（拆分/合并），不做两套并行输入；
- 等距分布与多选对齐工具条：`arrangeNodes` 里的 `distributeX/Y`（等间隙、首尾不动）此前
  没有任何入口，现在接进右键「对齐」子菜单与多选浮出的工具条；工具条定位在未被缩放的
  `.canvas-stage` 里、位置按 `bounds × zoom` 换算，因此按钮始终是屏幕尺寸，滚动与缩放都
  跟随。少于 3 个对象时分布按钮禁用；
- 钢笔与曲线路径（P3.1/P3.2）：`vector` 路径支持 `C`（三次）与 `Q`（二次）贝塞尔，
  仍不支持 `A`——圆弧用贝塞尔近似即可。**在曲线上的点必须落在 [0,1]，控制点允许越界**，
  否则一条向外鼓的弧要先撑大盒子再缩回去，来回插值会丢精度；节点盒取离散化后的紧包围盒，
  所以弧顶不会被选择框切掉。画布用 `bezierCurveTo`/`quadraticCurveTo`，命中走
  `flattenPath`（每段 16 份），导出直接输出曲线命令（离散化只服务命中与包围盒，不进产物）。
  钢笔工具（`P`）支持：单击落角点、拖动拉出对称手柄、点回起点闭合、`Enter`/`Esc`/双击
  结束、`Shift` 把拖拽方向吸附到 45°。草稿是纯视图状态，**一次路径 = 一条 `node.create`
  = 一次撤销**；闭合路径给填充、开放路径只给描边。完整规格见 `pen-and-path-editing.md`；
- 矢量节点编辑（P3.3）：双击矢量节点或按 `Enter` 进入编辑态（`Esc` 或点空白退出），
  画布覆盖层画出锚点（白底方块，选中填色）与手柄（连线 + 圆点）。命中优先级为
  **手柄 > 锚点 > 图形本体 > 空白**；拖动锚点时两侧控制点跟着平移，拖手柄默认镜像对侧
  （`Alt` 断开对称、`Shift` 约束到 45°），`Delete` 删除选中锚点（开放路径保留 ≥2 个、
  闭合 ≥3 个）。拖动过程只改本地副本，**松手提交一条 `vector.patch`**——几何与布局写在
  同一条命令里，因为改锚点会改变包围盒，拆开会让文档在两条命令之间处于「盒子不含图形」
  的中间态。二次曲线在编辑时精确升阶成三次，手改 Q 路径不会跳形状；闭合路径的显式
  「回起点段」在读回时合并，不会每次进出编辑态都多一个重合锚点；
- 线段插点（P3.4）：编辑态里点路径线段即插入锚点，并直接进入拖动。曲线用 de Casteljau
  在 `t` 处切分，**形状完全不变**（新锚点拿中点、两侧锚点收下切分后的控制点）；直线段
  不生成控制点，避免把直线「插」成曲线。闭合边的新锚点追加到数组末尾，因为
  `commandsFromAnchors()` 的闭合段总是从最后一个锚点回到第一个。找点用「32 份粗采样 +
  24 轮三分搜索」，插点只需亚像素精度，不值得解三次方程。悬停线段时光标变 `copy`。
  双击锚点可切换**角点 / 平滑点**（没有新增字段：有无手柄即类型；平滑方向取前后邻居连线、
  长度各取到邻居 1/3，切换即时提交）。尚未实现：多选锚点、锚点吸附、带独立手柄的尖角；
- 布尔运算（P4.1）：合并/减去/交集/排除，入口在画布右键菜单的「布尔运算」子菜单
  （选中 ≥2 个对象时出现）。**不保留运算树**：应用时把操作数烘焙成一条 `vector` 路径，
  操作数删除，`node.create` + 若干 `node.delete` 在**同一个事务**里提交，一次撤销即还原；
  结果插在基准层原下标。基准层取 z 序最下面那一层（与 Figma 一致），结果外观也取它。
  算法用 `polygon-clipping`（MIT，Martinez–Rueda），依赖只加在 `studio-web`——核心包不引入
  几何依赖，文档里只存结果。代价是**结果不含曲线**：输入先按 16 段离散成折线。
  同时修掉带洞路径的命中：`flattenRings` 按子路径分环，命中改用**非零环绕数**
  （与 Canvas/SVG 默认填充规则一致），洞里不再被点中。规格见 `boolean-and-mask.md`；
- 蒙版（P4.2）：`mask?: boolean` 复用节点属性（**不是新节点类型**），裁剪同一父级里排在
  它**上面**的兄弟，蒙版自身不绘制、画布上也不可点（仍能在图层树选中）。
  画布在兄弟循环里 `save → clip → restore`，多层蒙版叠加；命中通过 `SceneNode.maskedBy`
  先检查所有蒙版，被裁掉的区域点不中。SVG 导出 `<clipPath clipPathUnits="userSpaceOnUse">`
  + `<g clip-path>`，HTML 用 CSS `clip-path:path()` 并套一层 `position:absolute; inset:0`
  的容器，让路径直接使用父级坐标。页面直属节点与容器子节点共用同一套兄弟遍历
  （`applySiblingMasks` / `renderSiblingList`），否则页面级蒙版会静默失效。
  入口：右键菜单与属性面板「外观」区的「用作蒙版 / 取消蒙版」，一条 `node.patch` 可撤销。
  运行时只允许 `vector` / `rectangle` / `ellipse` 当蒙版。
  已知限制：蒙版圆角被忽略、自动布局里的 HTML 蒙版位置可能不准、不支持 alpha 蒙版；
  保留布尔组与曲线级布尔仍未实现；
- 旋转（P5.1）：`LayoutSpec.rotation`（角度制、顺时针为正、绕节点中心），可选字段。
  画布在 `save()` 后按中心旋转，子树自动继承；命中每层把点**逆变换回本地**再判定，
  蒙版检查放在逆变换之前（蒙版是兄弟，活在上层坐标系）；选择框画旋转后的四边形与手柄；
  缩放先把增量换算到本地，再用「对角钉住」把盒子平移回去，否则一拉手柄图形会漂。
  SVG 输出 `transform="rotate(θ cx cy)"`，HTML 输出 `transform:rotate(θdeg)`，
  属性面板「尺寸」区可输入角度，画布上还有**框外旋转手柄**：挂在盒子正上方、跟随旋转，
  拖动即转、Shift 吸附 15 度，松手才提交（一次拖动 = 一条 `node.patch`），指针悬停换
  `grab` 光标。尚未实现：多选整体旋转、旋转后的自动布局重排；
- 约束（P5.2）：`constraints`（水平/垂直各 `start/end/center/stretch/scale`）作为可选字段，
  由**运行时在 `node.patch` 里应用**——属性面板、画布手柄缩放、AI 计划与外部 MCP 集成
  因此共享同一套行为，不会因为入口不同留下「子节点没跟着动」的文档。父级 patch 与子节点
  重排在同一条命令里，`inverse` 同时包含父子状态，撤销一次整体还原；子节点被拉伸/缩放
  改变尺寸时会继续向它自己的子节点传播。stack 父级与 `hug` 父级跳过（前者由布局引擎排，
  后者尺寸是结果不是输入，重排会形成回路）。属性面板「约束」区只在父级是绝对布局容器时
  出现。**拖动父级手柄时子节点按约束实时跟随**（`constrainLayout()` 由运行时导出，画布预览与
  提交共用同一套公式；预览只喂绘制层，提交仍是一条 `node.patch`）。尚未实现：
  组件实例里的约束覆盖、多选整体旋转；
- 阴影与模糊（P6.1）：`appearance.shadow?`（x/y/blur/color）与 `appearance.blur?`，纯新增
  可选字段、旧文档无需迁移。画布每个节点绘制前重置 shadow/filter（父节点效果不会被
  子节点继承），再用 `shadowBlur`/`ctx.filter` 绘制；SVG 走 `<filter>` +
  `feDropShadow`/`feGaussianBlur`，`stdDeviation` 取模糊半径的一半，且滤镜区域放大到
  200% 以免偏移的阴影被裁；HTML 走 `box-shadow`/`filter`。支持矩阵新增 `effects` 行。
  属性面板「外观」区可添加/移除投影、调图层模糊。尚未实现：`spread`、内阴影、
  子树整体模糊（需要离屏合成）；
- 渐变与 schema v3（P6.2）：填充从单值改为填充层 `appearance.fills: Paint[]`
  （`solid` 或 `linear`），**文档格式升到 v3**，`MIGRATIONS` 登记 v2 → v3，把旧文档的
  `appearance.fill` 改写成实色层并删除旧字段。`resolveFills()` 是唯一读取入口——颜色
  token 绑定生效时整组填充压成单一实色（一个 token 表达不了渐变）；`primaryFillColor()`
  服务只接受单色的地方（文本颜色、对比度、批量/实例面板）。`gradientLine()` 让画布
  `createLinearGradient`、HTML `linear-gradient()`、SVG `<linearGradient>` 共用同一套
  角度几何（CSS 约定：0deg 向上）。属性面板的填充编辑器支持纯色 ↔ 线性渐变互转、
  调角度与起止色；**多层填充**按数组顺序叠放——画布逐层填充（阴影只投一次）、HTML 用
  `background-color` + 倒序 `background-image`、SVG 逐层输出图元（描边只画一次），面板用
  数字按钮切换当前编辑层并可增删。**径向渐变**（`{ type: "radial", cx, cy, r, stops }`）与线性
  共用色标编辑，中心与半径都用百分比显示，`radialGeometry()` 统一三处几何。尚未实现：
  椭圆渐变、混合模式；文本节点只按第一层上色；
- 工作台外壳重做，布局对标 Figma / Penpot 一类编辑器：48px 顶栏把「创建工具、撤销重做、
  项目操作、导出/导入、自动保存状态」分组并用分隔线隔开；左侧栏拆成「页面」和「图层」两段，
  页面改用列表而不是下拉框，图层工具收成两行图标条（复制/粘贴/重复/编组/取消编组，以及
  置底/下移/上移/置顶），图层树独立滚动且搜索固定在顶部；中间画板带标题条（页面名 +
  960×680 尺寸），首次打开按工作区大小自动缩放到整页可见，画布在工作区里居中；窄屏按
  优先级隐藏品牌名、状态文案和顶栏自动保存徽标，避免顶栏溢出；
- 浏览器存储升到格式版本 2：新增 `snapshotHistory` 表保存历史快照（IndexedDB 不允许
  在升级时改表主键，因此用新表而不是改主键），当前快照加上历史快照共保留最近 10 份，
  迁移升级前的原始快照不会被覆盖；旧版本数据库直接开库即升级，无需人工操作；
  打开项目时若存储里的文档是旧格式，会先迁移再回放事务，并在恢复报告里给出
  `migratedFrom`；文件系统仓库在迁移落盘前把原始文件备份到 `backups/`；
- JSON 导入带版本检查：旧格式文件会被升级后导入并提示来源版本，更高版本的文件
  明确拒绝而不是给一句看不懂的校验错误；导入文件与本地项目**同一个 id** 时
  （导出的 JSON 带着原 id 回来就是这种情况），会让用户在「覆盖原项目」和
  「作为新项目导入」之间选择，覆盖走仓库的 `replaceProject`，会清掉旧快照、
  旧日志和旧资产，不会让旧历史被重放到新内容上；
- 打开项目后会生成一份**恢复报告**：恢复自哪一版、重放了几条事务、最新已知
  修订、文档格式版本（被迁移过时写明来源版本）、是否降级恢复，逐行列在「历史」
  分段的恢复报告里，并可导出成 JSON 文件；
- 「历史」分段列出**历史版本**：列出存储保留的最近 10 个版本（版本号、落盘时间、
  「当前」标记，迁移前留下的旧格式版本单独标注），可以对任意旧版本发起「还原」；
  还原走运行时自带的 `history.restore` 命令——旧内容写回当前文档，但 revision
  继续单调递增，事务日志里也留一笔，所以这次还原本身还能再撤销回去；存储里的
  旧格式文档在读取时会被迁移到当前格式，因此「回滚升级」取回的是升级前的**内容**，
  而不是把整个应用退回旧格式；
- 同一分段里的**操作历史**区块：把事务日志列成一条条可读的步骤（修订号、时间、
  「新建节点 ×2、修改文本」这样的摘要、AI 还是本地用户、还原类事务单独标色），
  可以把项目精确退回到任意一条事务之后的状态。目标版本没有快照时，按「不晚于
  目标的最近一份快照 + 顺序重放事务」重建文档，重建过程不写存储，回退本身仍然
  走 `history.restore`（revision 递增、可再撤销）；
- **重建基线**：事务日志按条数保留（200 条）、快照按份数保留（10 份），两者不对齐，
  于是早于最老快照的那段步骤只剩日志、没有起点可重放。现在每个项目额外保留一份
  **永不被裁剪**的基线文档，位置落在「事务日志起点的前一版」：裁日志之前先把新的
  起点前一版重放出来固化成新基线，裁剪因此始终安全，日志窗口里的每一步都能重建
  （基线也不受「裁历史版本」影响）。操作历史按真实可达性决定是否给回退入口，
  回不去的步骤标「无法回退」，不再误标成「当前」；重建失败时给出「起点快照被清理」
  或「事务日志断档」的人话提示；
- 弹窗层修掉一个静默缺陷：确认框的「确定」按钮此前会被 Radix 关闭弹窗的动作覆盖成
  `false`，导致「删除项目」这类确认流程点了也没反应；现在结算放在按钮的 onClick 里，
  并补了 jsdom 回归测试（真实 Radix + 真实 DOM 事件）；同时新增多选一弹窗，供导入
  冲突这类需要用户在几个动作之间选择的场景使用；
- 画布几何改由 `design-layout` 解析，不再直接读取节点的 `layout` 原始值，因此 hug、fill、
  stack 在编辑器内与导出结果一致；文本测量通过宿主契约注入浏览器 Canvas 字体度量；
- 图层面板为嵌套树，支持折叠展开、节点类型图标、层级缩进，以及基于 dnd-kit 的拖拽排序
  （同级重排与拖入容器两种落点）；重排通过 `node.reparent` 命令提交，可撤销；
- 支持编组与取消编组：同级多选可编组为一个不带填充的 frame，frame 的包围盒按布局引擎
  解出的绝对盒计算，子节点坐标随之换算成相对编组，视觉位置不变；`Ctrl/Cmd+G` 编组、
  `Shift+Ctrl/Cmd+G` 取消编组，右键菜单与图层面板按钮都有入口。两种操作都是单个
  原子事务（依次 `node.create` / `node.reparent` / `node.patch` / `node.delete`），
  可以撤销；跨父级选区不支持编组，单个对象也不编组；
- 锁定与隐藏的选择语义：锁定节点在画布上不接收指针事件（点击会穿透到下面/父级），
  框选结果会过滤掉锁定与隐藏节点，只能从图层面板选中它们；批量移动、对齐和删除
  会跳过锁定节点，并在状态栏说明跳过几个；属性面板仍然可以修改锁定节点——否则
  没有解锁的入口；复制/粘贴出来的根节点自动解锁，副本可以直接继续编辑；
- 自动布局容器里的键盘微移：stack 子节点的 x/y 由布局引擎计算，改坐标不会生效，
  所以方向键改为调整它在父容器里的顺序（左/上向前、右/下向后，到边界就停）；
  绝对定位节点仍然按像素微移。两类变更都提交在同一个事务里；
- 文本测量的一致性与缓存：测量器可以套一层有上限的 LRU 缓存（默认 512 条，键覆盖
  字体、字号、行高、字重、字形、字距、可用宽度和文本本身），并暴露命中/未命中统计
  供测试断言；浏览器测量器改用这层缓存，画布文字在字体缺失时走统一的回退栈
  （`system-ui / PingFang SC / Microsoft YaHei / sans-serif`），字体名会先去掉引号、
  分号等可能跳出 CSS 声明的字符；文档用到的字体会被异步加载，加载完成后清空测量
  缓存并触发一次重排，避免一直沿用回退字形的宽度；
- 视觉回归：`npm run visual:baseline` 用本机 Chrome/Edge headless 渲染 golden HTML，把
  截图存成 `test/golden/page.png`；`npm run visual:check` 重新截图并按像素比较，默认
  允许 0.5% 差异，超出则非零退出，并把差异图标红写到 `page.diff.png`。PNG 编解码与
  像素对比用 `node:zlib` 自实现，不引入原生图像库；画布另有像素回归：
  `npm run visual:canvas:baseline` / `visual:canvas:check` 用 esbuild 打包一个不依赖后端的
  harness（直接调用 scene + 渲染器，fixture 覆盖换行/对齐/圆角/裁剪/椭圆/图片/缺图/透明度），
  Chrome 截图后与 `packages/studio-web/visual/canvas.png` 比较，连续两次实测 0 差异；
  找不到浏览器时 check 会跳过并提示，
  加 `--require-browser` 则明确失败。基线绑定本机字体，跨机器更新需要显式
  `--update`；
- 可访问性（对比度）：`collectContrastIssues()` 从文档解析文本色与最近的背景色，
  按 WCAG 相对亮度公式算对比度（正文 4.5:1、大字号 3:1，大字号按 ≥24px 或
  ≥18.66px 加粗判定），token 绑定也算在内；属性面板列出不达标的文本节点，点击可
  定位。工作台补了全局 `:focus-visible` 描边；键盘遍历与屏幕阅读器路径还没有自动化
  检查；
- 布局性能基线：`npm run bench:layout` 用合成文档（文本节点 + 自动布局容器）测
  200/500/1000/2000 节点的中位数与 p95，支持 `--json` 与 `--budget`（超预算非零退出）；
  本机基线约 1.5 / 3 / 5-7 / 11-19 / 30-45 ms（5000 节点），接近线性。另有
  `npm run bench:export` 测 1000/5000 节点的 HTML 与 SVG 生成（本机 5000 节点约
  50-70ms），`npm run check:budgets` 把两条基线一起做门禁（超预算非零退出）。
  `test:studio-core` 里有 1000 节点布局与 5000 节点布局+导出的 smoke 测试，只拦截
  数量级退化，避免 CI 抖动误报；
- 设计 Token 扩展到三类：颜色 token 绑定填充/描边，数值 token 绑定圆角与自动布局
  间距；`resolveRadius` / `resolveGap` / `resolveStroke` 是唯一解析入口，画布渲染、
  布局引擎和 HTML/SVG 导出共用它，不会各算一套。Token 面板支持新增颜色/数值 token、
  下拉绑定、解绑、改值与删除，下拉里只列该类型真正生效的属性；token 被删除或类型
  不匹配时退回节点自身值，设计仍然可渲染，只是丢了绑定；
- 组件系统已接入 UI：可将选中节点提升为组件根（`component.create`），按需实例化
  （`component.instantiate`，实例会物化组件子树并支持 overrides），并在组件面板列出
  组件与实例计数；实例可正常参与布局、画布渲染与导出；
- 组件变体（component set）：`component.setCreate` 注册只声明属性名的变体集，
  `components[*].variantSetId` + `variant` 表达成员归属与取值（可选字段，旧文档不迁移）；
  `component.setVariant` 把已有组件登记为成员，`component.createVariant` 在命令层复制根子树
  （新节点 id 用 `${新组件 id}--${源节点 id}`，与实例物化同规则）并紧跟源根插入，
  `component.switchVariant` 让实例在同集成员之间切换——删旧物化子树、重新物化，
  实例 id/位置/尺寸不变，覆盖按结构路径迁移到新变体（同一角色换了 id 也不会丢）。
  集合只有一个成员时自动解散，
  避免留下永远只有一项的下拉框。组件面板显示变体取值（`state=hover`）并提供「创建变体」
  表单（首次自动建集合，属性可逗号分隔多个）；实例面板在多成员集合时显示变体下拉框。
  规格见 `component-variants.md`；
  **尚未实现**：变体间的结构共享；
- 组件的生命周期边界：实例可以「脱离组件」（`component.detach`）变成普通 frame，
  子树与物化出来的文字原样保留，组件定义本身不动，之后如果没人引用就可以删除定义；
  依赖环在编辑期就拦住：把引用了组件 A 的节点（或 A 的实例）移进 A 的子树时，
  按传递闭包判定并报 `component cycle`，把节点提升为组件根时也会自检，
  不再等到提交时才抛校验错误；
- 组件插槽：组件子树里可以声明 `slot: true` 的 frame（属性面板「作为插槽」），
  实例化时插槽同样被物化；选中实例后可以把剪贴板内容填进插槽（多个插槽时先选一个），
  `slot.fill` 会在实例自己的子树里重建节点 id，重复填充先清空旧内容，不影响组件
  定义和其它实例；非插槽节点、别的实例的插槽都会被拒绝；
- 实例覆盖：组件物化出来的文本节点在实例选中时列进「实例覆盖」面板，改文字会通过
  `component.override` 同时更新实例自己的副本并记进 `instance.overrides[sourceNodeId]`，
  组件定义和其它实例不受影响；插槽内容按前缀排除，不会把用户填进去的文字误当成
  组件覆盖。命令层同时支持外观覆盖（填充/描边/圆角/透明度），也可以
  `component.resetOverride` 把某个节点恢复成组件定义里的样子（直接抄源节点字段，
  不重新实例化，节点 id 与布局保持稳定）；也能 `component.resetOverrides` 一次清空或
  只清指定节点，撤销时整批回来。可覆盖字段有明确契约（`overridableFields`）：文本节点
  多一个 `text`，其它节点只能覆盖 `name` / `visible` / `appearance`；未知字段、空补丁、
  越界的透明度与圆角都会被命令层拒绝。`exposedOverrideTargets()` 把这份契约变成可查询
  的清单（源节点 id、类型、默认文本、允许字段），供 UI、AI 与外部集成共用；
  实例也支持 `component.detachMany` 批量脱离，任一目标不是实例就整批失败并回滚。
  「实例覆盖」面板已接上这些能力：每个文本副本可改文字、填充色与透明度，可单条重置；
  顶部有「全部重置」与「脱离组件」，多选全是实例时还有「批量脱离」。
- 人工编辑支持可持久化撤销/重做及 `Ctrl/Cmd+Z`、`Shift+Ctrl/Cmd+Z` 快捷键；历史操作
  以 `history.restore` 事务写入日志，revision 保持单调递增，并可在快照后连续重放；
- 属性面板是独立的 `PropertyPanel` 组件，覆盖布局引擎已支持的完整词汇：布局模式
  （绝对/自动布局）、方向、对齐、间距、X/Y/宽/高、宽高模式（固定/填充/适应）、四边内边距、
  填充/描边/圆角/透明度，以及文本内容/字体/字号/行高；模式切换与内边距、透明度等纯逻辑
  抽在 `layout-edit.ts` 纯函数层并有单元测试，UI 只负责收集输入；
- 画布渲染补齐了描边、椭圆形状（`border-radius: 50%`）和文本字体样式（字体/字号/行高/
  对齐/换行），画布上的几何与外观与属性面板改动的结果一致；
- 画布内可直接编辑文字：双击文本节点进入行内编辑，Enter 提交、Shift+Enter 换行、Esc 取消，
  提交通过既有 `text.patch` 命令写入，未变化的编辑不会空涨 revision；
- 支持多选与批量属性编辑：图层面板提供「全选」按钮（`Ctrl/Cmd+A`）选中页面顶层对象，
  属性面板在多选时切换为批量面板，可一次性改填充/描边/圆角/透明度与宽高模式/宽高；
  各字段显示所选节点的共同值，值不一致时留空并标注「混合」，用户键入新值即应用到全部
  所选节点；批量改动按节点各自原值合并后逐条 `node.patch`，全部落在同一个事务里，
  未发生变化的节点不发补丁；批量改填充会解除该节点的填充 token 绑定，否则新颜色不生效；
  批量填写宽/高会把该轴的尺寸模式切到「固定」，因为布局引擎只在固定模式下读取存储尺寸；
  合并与补丁规则抽在 `batch-edit.ts` 纯函数层并有单元测试；
- 画布支持缩放与适应内容：缩放是纯视图状态（不写文档、不涨 revision），由
  `canvas-zoom.ts` 纯函数层提供 `clampZoom`/`zoomStep`/`fitZoom`/`zoomPercent`/
  `contentBounds`，缩放范围 10%–400%；`Ctrl/Cmd + 滚轮` 与右下角控件（缩小、百分比
  回到 100%、放大、适应内容）都可调整；「适应内容」按布局引擎解出的内容包围盒计算
  （而非整块 960×680 画布）且只缩不放；缩放用 CSS `zoom` 实现，画布命中、拖拽与
  手柄几何都按 `zoom` 换算，因此选择框与手柄始终保持屏幕尺寸；工作区过窄时
  控件按重要性用容器查询降级；
- 画布拖拽的根因修复：入口不再在模块顶层无条件 `createRoot`，而是在容器上缓存并复用
  root，Vite HMR 重新执行模块时只重新 render，不会出现两棵 React 树互相撕裂 DOM
  （此前表现为点击随机失效、拖拽坐标错乱）；
- 画布拖拽与缩放的坐标：指针事件先按 `zoom` 换算成 960×680 的画布坐标
  （`pointFromEvent`，见 `renderer/hit-test.ts`），拖出画布时按画布边界钳制；
  拖拽、框选、缩放手柄与旋转手柄共用 `renderer/selection.ts` 的同一套盒子计算，
  因此几何在任意缩放下都一致；
- 图层工具栏提供椭圆节点入口（`ellipse` 节点类型），形状由 `borderRadius: 50%` 表达；
- 布局引擎的 warnings 上浮到「属性」分段的「布局警告」区块，点击警告行可直接选中对应节点；
- 属性面板支持文本内容、字体、字号、行高、节点显隐和锁定；文本修改通过独立
  `text.patch` 命令校验类型和数值，不扩张通用节点 patch；
- 文本样式补齐粗细、字形、盒内对齐与字间距：属性面板「文字」区提供粗细（常规/中等/
  半粗/加粗）、字形（常规/斜体）、对齐（左/中/右）和字距四个控件，画布渲染与行内
  编辑（textarea）同步跟随；浏览器 Canvas 测量器把字重/字形写进 `context.font`、
  按字符数补上字距，缓存键带上样式，避免不同字重的文本共用一次测量结果；hug 宽度
  会随字重和字距变化（例如 8 个汉字在字距 4px 下比 0px 宽 32px）；
- **富文本（段内样式）**：`TextNode.runs?: TextRun[]` 用「UTF-16 偏移区间 + 样式」表达
  段内加粗/斜体/变色，`text` 仍是唯一的内容真相（可选字段，旧文档不需要迁移）。
  `validateTextRuns()` 是唯一校验入口（越界、重叠、切断代理对、空样式都拒绝），
  schema 的 `superRefine` 与 `text.patch` 共用它；文本被改写却没给新 runs 时走
  `remapTextRuns()`，按公共前后缀平移区间，段首插字不会让加粗整体错位。
  换行统一由 `design-layout` 的 `layoutRichText()` 决定（按空格优先断行、行尾空格不计宽），
  画布、估算测量器、浏览器 Canvas 测量器、测量缓存键全部共用它，避免「画布 3 行、
  布局以为 2 行」；画布逐段设置字体与颜色，HTML 输出 `<span>`、SVG 输出 `<tspan>`，
  没有 runs 时导出产物与升级前逐字一致（视觉基线仍是 0 差异）。
  属性面板的多行文本框会记录选区，选中文字后改粗细/字形/选区字号/选区颜色只作用于选区，
  「清除选区样式」恢复节点级样式。规格见 `rich-text.md`；
  **尚未实现**：段内行高覆盖、段落级样式、画布内联编辑器里的样式可视化；
- **字体管理**：字体文件走与图片同一套资产管线（SHA-256 落库、去重、随文档备份），
  `document.fonts` 记录族名 + `assetId`（缺省表示依赖系统字体）+ 字重/字形，可选字段、
  旧文档不迁移。`font.register` 同键替换、`font.remove` 在族名仍被文本使用时拒绝，
  `asset.delete` 也会保护字体引用的字节。加载侧 `loadDocumentFonts()` 用 FontFace API
  注册上传文件，`prepareFonts()` 返回真正可用的族名，`collectMissingFonts()` 得出
  「文本用到但没有任何来源」的族名——在「数据 → 字体」里用橙色提示条明确列出，
  不再静默回退。属性面板的字体输入带 datalist 建议（已加载 + 文档声明过的族名）。
  规格见 `font-management.md`；
  **尚未实现**：字体子集化与导出内联、从文件解析真实族名/字重、字体 token 的渲染语义；
- 图片资产闭环：可从本地插入 PNG/JPEG/GIF/WebP 图片，字节按 SHA-256 写进仓库并去重，
  文档里先登记资源元数据（`asset.upsert`）再在同一个事务里创建 `image` 节点，两步不会
  只成一半；画布按 `fit`（覆盖/适应/拉伸）用对象 URL 渲染，资源缺失时画占位框并标注
  「图片资源缺失」，不会留一个空白；HTML/SVG/PNG 导出都会把图片内联成 data URL，
  PNG 光栅化因此不再被外部资源污染画布；导入别人的 JSON 时会逐份核对资源是否在本地
  存储里，缺失的数量和名字写进状态提示，也单独列进恢复报告；
- 「数据」分段列出**图片资源**：列出每份资源的大小、被几个图片节点引用，以及是否缺失；
  缺失资源可以「重新关联」——只接受内容哈希一致的原文件，补字节不动文档，所以已经
  渲染出来的缺失节点会立刻恢复，revision 也不会因为补文件而上涨；没有被引用的资源
  可以清理，元数据走 `asset.delete` 进入事务，字节在没有别的记录共享同一个哈希时才
  从仓库删除；
- 图片节点可以整张替换：「替换图片…」把新图按哈希落库、登记元数据，再用
  `image.patch` 把节点的 `assetId` 指过去，节点 id、位置、尺寸和 `fit` 都不变，
  因此选中状态、布局和撤销历史都不会断；换图与换 `fit` 共用同一条
  `image.patch`，指向未登记的资源会被命令层拒绝；
- 存储用量面板：读取 `navigator.storage.estimate()`，给出已用/额度、百分比和进度条，
  70% 提示、90% 告警，并给出「导出 JSON 备份」和「清理旧项目」两条出路；
  环境不支持估算时显示「无法获取」而不是报错；
- 自动备份与轮转：每次自动保存落盘后最多每 10 分钟写一份完整文档备份，按项目保留
  最近 3 份（独立于快照和事务日志的 IndexedDB 库）；面板可以下载任意一份为 JSON，
  也可以还原——还原沿用 `history.restore`，revision 继续递增、可再撤销；删除项目
  会连它的备份一起清掉；
- 工作台可下载当前页面的独立 HTML、SVG 交付物和当前项目 JSON 备份，并报告导出诊断数量；
  PNG 交付物由 SVG 经浏览器 Canvas 光栅化生成；
- 导出诊断面板：最近一次导出的每条诊断都列成一行（特性、支持程度、原始说明），
  带节点 id 的诊断可以点击直接选中对应节点；面板里还有一张随导出器一起维护的
  **支持矩阵**（`EXPORT_SUPPORT_MATRIX`：绝对/自动布局、尺寸策略、文字样式与换行、
  Token、基础形状、图片、组件实例、矢量、隐藏节点、PNG 光栅化），逐项写明在
  HTML / SVG / PNG 三种交付物里的支持程度。矩阵和诊断共用同一套特性 id，并有测试
  保证导出器发出的每一种诊断都能在矩阵里找到对应行。组件实例的覆盖有单独的
  `component-override` 诊断（说明这个实例导出了几个被覆盖的节点），和"实例只导出
  物化子树"的近似诊断分开显示；
- 导出基线（golden files）：`design-export` 的测试里锁住了 HTML 交付物、SVG 交付物、
  选区导出产物和布局包围盒——字体走纯字符估算器，因此结果跨平台确定。任何无意的
  几何、CSS 或 token 变量变化都会变成测试 diff；确认改动后用 `UPDATE_GOLDEN=1` 重新
  生成基线。这套基线当场抓到一个真缺陷：SVG 导出给 token 变量多补了一个 `--` 前缀，
  写成 `----color-primary`，而节点引用的是 `var(--color-primary)`，颜色在 SVG 里静默
  失效；已修复并补了专门断言定义与引用两侧的测试；
- 隔离预览：诊断面板旁可以「预览 HTML / SVG / PNG」。HTML 交付物渲染在
  `sandbox=""` 的 iframe 里（不执行脚本、不给同源权限），SVG 和 PNG 走 data URL 的
  `<img>`；预览和下载用的是同一次导出的产物，不会出现"预览好看、下载走样"；
- 导出范围可切「整页 / 选区」：选区导出用选中节点的包围盒作为视口，只导出与选中节点
  相关的分支，文件名和状态文案都会标注范围；选区为空时自动退回整页；
- 编辑器外围补齐四项：① 多选时可批量改文字样式（字体/字号/行高/粗细/字形/对齐/字距），
  只作用于选中的文本节点，逐条走 `text.patch`，值没变的节点不发补丁；② 图层面板支持按名称或文本内容
  搜索，命中项的祖先层同样保留可见，搜索时自动展开折叠的层级；③ 左右面板可折叠，
  收起后画布拿到全部宽度；④ 画布支持抓手平移（工具栏切换，或按住中键拖动），平移只改
  视口滚动位置，不写文档也不涨 revision；
- 对应包已有有限的单元测试，并被根级 `build:studio-core` 和
  `test:studio-core` 脚本覆盖。

这些包证明部分领域边界可以脱离 Figma，但不构成完整产品。

## 遗留代码：禁止作为新功能基础

- `packages/core`：原 Vibma MCP Server；
- `packages/tunnel`：原 WebSocket relay；
- `packages/adapter-figma`：原 Figma 插件与 handlers；
- `schema`、`plugin`、`dist` 及 Vibma 安装指南。

除非任务明确要求迁移或维护遗留代码，否则不得启动、配置、测试或扩展这些模块。新代码
不得依赖 Figma Runtime、Vibma relay 或旧 MCP 工具实现。

## 尚未实现或尚未达到可用状态

- 矢量能力完成到「能画、能改节点、能做布尔」：`vector` 节点已有归一化 `M/L/C/Q` 路径
  （画布、命中、SVG、HTML 共用同一套几何），钢笔能画折线与曲线，编辑态能拖锚点/手柄、
  断对称、删锚点，布尔运算能合并/减去/交集/排除并把结果烘焙成路径；
  尚未实现：锚点类型切换（corner/smooth）、多选锚点、锚点吸附、
  保留布尔组、曲线级布尔；相位划分见 `editor-tooling-roadmap.md`，
  P3 见 `pen-and-path-editing.md`，P4 见 `boolean-and-mask.md`；
- **原型已有运行时**：`interaction.patch` 的数据层 + `studio-web/src/prototype/` 的预览，
  支持点击/悬停/延迟三种事件、navigate/overlay/prev-screen/open-url 五类动作、
  dissolve/slide/push 动画与 overlay 定位（详见下方「原型预览」条目）；
  仍未实现：滚动保持（`preserveScroll` 字段已建模未消费）、
  原型内的固定元素与滚动容器；协作（实时多人、评论、分享）完全空缺；
- **Grid 只有数据模型与求解，没有可视化编辑**：轨道能通过属性面板录入，
  但拖拽调整轨道宽度、命名网格区域（`grid-template-areas`）、
  自动轨道（`auto-fill` / `auto-fit`）都未实现；
  与 Figma 的差距清单见 `figma-gap-roadmap.md`；
- SVG 路径导入：`design-schema/src/svg-path.ts` 按 Penpot 的解析语义支持
  `M/L/C/Q/A/H/V/S/T/Z` 及小写相对形式与隐式命令（`M` 之后省略命令字母按 `L` 处理），
  `A`（椭圆弧）用搬来的 MIT 算法转成贝塞尔；导入产物统一归一化成 `[0,1]` 相对路径，
  因此 `vector.geometry` 的「改宽高即缩放图形」不变式继续成立。
  非法输入让**整条路径作废**，不做部分解析；
  弧线算法与上游逐字节对拍（`test/arc-parity.test.ts`）。
  语义来源与许可证边界见 `penpot-porting.md`；
- 原型交互模型：`design-schema/src/interactions.ts` 按 Penpot 的
  interactions 语义定义事件（click / mouse-press / mouse-over / mouse-enter /
  mouse-leave / after-delay）、动作（navigate / open-overlay / toggle-overlay /
  close-overlay / prev-screen / open-url）、动画（dissolve / slide / push）与
  overlay 定位；节点上以可选 `interactions` 数组承载，
  运行时 `interaction.patch` 命令校验语义自洽与跳转目标存在性；
- 原型预览（运行时）：顶栏「预览」从选中容器或页面第一个根节点进入全屏预览，
  Esc 退出。状态机在 `studio-web/src/prototype/state.ts`（纯函数，Node 里可测）：
  点击命中从最深节点向上冒泡找交互；`mouse-press` 在按下时触发，`mouse-enter` /
  `mouse-over` 在进入节点时各触发一次（enter 优先，over 不做每帧触发以免自我循环），
  `mouse-leave` 在离开时触发；`after-delay` 按屏幕排计时器；
  navigate/back/prev-screen 维护屏幕历史；overlay 支持中心与四角定位、manual 相对触发节点、
  背景遮罩与点外部关闭（`closeClickOutside`）；动画用 DOM 层的 CSS keyframes 实现
  （dissolve 淡入、slide 入场、push 新旧两屏同步位移），每层一张 canvas，
  图片仍走与编辑器同一套对象 URL。规格见 `prototype-runtime.md`；
  **尚未实现**：`preserveScroll` 的滚动保持、
  原型内滚动容器与固定元素；
- 生产可用的 `studio-web` 或桌面工作台；当前只有 Web 垂直切片；
- 生产可用的渲染系统；画布已切到 Canvas 2D 场景渲染（`renderer/scene.ts` +
  `renderer/canvas-renderer.ts`），有根节点级视口裁剪、像素回归和绘制耗时基线，
  选择层也**已完全交给 Canvas**（单击/双击编辑、拖拽/缩放、框选、吸附、可访问性列表
  全部走 Canvas，DOM 副本已清空）；旧的 Moveable/Selecto 交互层代码与依赖
  已随 Phase C 完成删除；
- 生产可用的文本测量；浏览器端测量依赖 Canvas 字体度量，已有有上限的测量缓存、
  统一回退栈和字体加载后的缓存失效，但还没有跨平台字体基线、CI 截图对比，也没有
  服务端/无 Canvas 环境的真实度量；
- PNG 导出的独立交付链路；当前由 SVG 经浏览器 Canvas 光栅化生成，外部图片会污染画布
  （工作台自己插入的图片已内联为 data URL，不会触发这个问题）；
- React、PDF 等后续导出格式；
- Token 体系仍不完整：字体（typography）token 只有 schema 字段、没有渲染语义；
  没有 token 分组、别名/派生和主题切换，也没有从样式表或 Figma 导入 token 的入口；
- 生产级 AI Provider 体验的其余部分：真实 Provider 的逐家验收（能力矩阵目前是
  文档 + 能力表，尚未在每家的真实服务上跑通）、密钥轮换与作用域管理（当前密钥只活
  一个标签页，刷新后需要重新输入）；结构审查目前覆盖删除、锁定、页面、历史还原、
  批量规模和硬编码颜色，跨页面一致性、组件语义与可访问性审查尚未覆盖；流式响应、
  超时、取消、重试、凭据不落盘和失败恢复已实现；
- 独立 Studio MCP adapter 的 OAuth / 多租户隔离与 SSE 服务端推送；stdio 与 HTTP
  传输、Bearer 校验、会话隔离、命令契约、权限与审计已实现；
- 不依赖 Figma 的端到端设计工作流；
- 导入冲突：id 相同会询问覆盖还是另存，重名会给「原名（2）」的建议名，并弹出输入框
  让用户自己改名（校验空名字与重名）；支持一次多选多个 JSON 文件批量导入，批量时
  一律按新项目导入、不覆盖任何现有项目，弹表格让用户逐个确认名字；
- 图片还缺三块：SVG 图片不支持插入（导出器的资源 URL 白名单只接受 PNG/JPEG/GIF/WebP），
  资源没有来源/授权等元数据，清理未引用资源时如果多条记录共享同一份字节，字节会
  保留到最后一条记录被清理；
- 存储配额只做了用量视图与告警，还没有配额上限策略；
- 自动备份是浏览器的本地 IndexedDB 备份：没有导出到磁盘的定时备份、没有加密、
  也不能跨设备同步，清空站点数据依然会一起丢失；
- 迁移只覆盖了文档格式这一条链路，存储布局版本（文件系统 manifest、浏览器
  IndexedDB）虽有版本号，但旧布局的迁移步骤尚未成体系。

## 文档阅读优先级

1. 本文：确认当前实际能力；
2. `project-progress-and-version-roadmap.md`：确认功能对应的软件版本和发布门槛；
3. `editor-tooling-roadmap.md`：确认编辑器工具能力的现状与后续相位；
4. 根级 `AGENTS.md`：开发约束和当前边界；
5. 各包源码、测试及包级 `AGENTS.md`：确认实现细节；
6. `ai-design-studio-architecture-analysis.md`：了解目标架构和未来路线。

架构文档中的 V1 功能、目标目录和 Phase 1—5 都是规划内容。名称出现在文档中，不代表
相应目录、包或能力已经存在。

## AI 操作规则

- 回答“项目目前是否支持某功能”时，必须先检查源码、测试和构建脚本，不能只引用架构稿；
- 不得把目标目录树描述成当前目录树；
- 不得宣称独立 Studio 已经完成；
- 不得建议用户启动 Vibma relay、导入 Figma 插件或配置旧 MCP Server；
- 只有明确的遗留迁移任务才允许修改 bridge，并继续遵守其既有边界；
- 修改独立 Studio 原型时，不得引入 Figma、React、MCP SDK 或具体 renderer 到
  `design-runtime`；
- 新增已实现能力后，应同步更新本文，避免状态文档再次落后。

## 当前验证命令

独立 Studio 底层原型：

```bash
npm run build:studio-core
npm run test:studio-core
npm run bench:layout
npm run build:studio-web
npm run test:studio-web
```

本地启动 Web 垂直切片：

```bash
npm run dev:studio-web
```

这些命令成功仅表示底层包能够构建并通过已有测试，不表示独立 Studio 已经可运行。

上述构建、测试与 `npm run check:budgets` 已由 `.github/workflows/studio-ci.yml` 在
push / PR 上执行；视觉回归（`npm run check:visual`）单独成 job 且允许失败，因为产物
基线绑定本机字体，Linux runner 上的像素差异来自字体而不是代码。legacy Vibma 的发布
仍走 `release.yml`，与 Studio 无关。

不要把 `npm run socket`、Figma 插件安装或 Vibma MCP 配置作为本项目的运行步骤。
