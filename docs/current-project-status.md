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
  文档格式版本升到 **2**，并提供迁移引擎：`CURRENT_SCHEMA_VERSION` 声明当前版本，
  `MIGRATIONS` 是 `旧版本 → 新版本` 的步骤表（当前登记 v1 → v2），`migrateDocument()`
  把任意来源的数据升级到当前版本，失败抛 `MigrationError` 并带上原始版本号，
  成功则把迁移记录写进文档自带的 `migrations` 历史；`detectSchemaVersion()` 负责判断
  版本，高于当前版本或缺少版本的文档一律拒绝，不猜版本；
- `packages/design-runtime`：早期命令和运行时原型；`text.patch` 接受并校验上述文本样式字段；
- `packages/design-persistence`：文件系统快照、事务日志、资产存储，以及从最后有效快照
  连续重放已提交事务的崩溃恢复原型；仓库契约收敛为单一入口 `contract.ts`：
  `ProjectRepository` 接口、`ProjectNotFoundError`、快照与事务语义都由它定义，
  文件系统实现与浏览器实现共用 `loadDocumentPayload()`（迁移 + 校验）、
  `replayJournal()`（统一的重放与降级判定）、`assertSavableDocument()`、
  `normalizeAssetHash()`，两边的行为因此不会因为换了存储而改变；两个后端跑同一套
  契约测试（`contract-suite.ts`：快照往返、重放、断档降级、项目列表、删除、日志裁剪、
  资产去重、旧版本迁移）；保留策略统一为最近 3 份快照与 200 条事务，另有
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
- `packages/studio-web`：可运行的 React 工作台垂直切片，包含本地图层列表、DOM 画布、
  节点创建/选择/框选/拖动/缩放/吸附/删除、基础属性编辑、Dexie/IndexedDB 项目、事务
  和二进制资产存储，以及 AI 计划预览、过期提示、取消和确认提交界面；画布交互层
  已接入 Moveable/Selecto 并延迟加载，支持 Shift/框选、多节点批量拖动、缩放和删除，
  所有群组变换在交互结束时作为一个原子事务提交；浏览器存储支持快照后事务重放、
  revision 缺口降级报告、资产哈希校验和旧 localStorage 快照迁移；已提供 AI 服务地址、
  模型和密钥设置入口，但尚未完成真实 Provider 的生产级端到端验证、流式体验和支持矩阵；
  工作台顶部支持项目列表、新建、切换、通过领域命令重命名，以及原子清理项目快照、
  事务和资产的删除操作；
- 工作台支持自动保存：事务日志即时写入（恢复的依据），快照合并写入（停止输入
  800ms 后落盘，连续几次编辑只写一份），顶栏实时显示「待自动保存 / 自动保存中 /
  已自动保存 / 自动保存失败」，页面关闭或切到后台时立即冲刷待写快照；存储配额
  耗尽会被识别并单独提示（提示导出 JSON 备份），不会被当成普通异常吞掉；
- 浏览器存储升到格式版本 2：新增 `snapshotHistory` 表保存历史快照（IndexedDB 不允许
  在升级时改表主键，因此用新表而不是改主键），当前快照加上历史快照共保留最近 3 份，
  迁移升级前的原始快照不会被覆盖；旧版本数据库直接开库即升级，无需人工操作；
  打开项目时若存储里的文档是旧格式，会先迁移再回放事务，并在恢复报告里给出
  `migratedFrom`；文件系统仓库在迁移落盘前把原始文件备份到 `backups/`；
- JSON 导入带版本检查：旧格式文件会被升级后导入并提示来源版本，更高版本的文件
  明确拒绝而不是给一句看不懂的校验错误；导入文件与本地项目**同一个 id** 时
  （导出的 JSON 带着原 id 回来就是这种情况），会让用户在「覆盖原项目」和
  「作为新项目导入」之间选择，覆盖走仓库的 `replaceProject`，会清掉旧快照、
  旧日志和旧资产，不会让旧历史被重放到新内容上；
- 打开项目后会生成一份**恢复报告**：恢复自哪一版、重放了几条事务、最新已知
  修订、文档格式版本（被迁移过时写明来源版本）、是否降级恢复，逐行列在属性
  面板里，并可导出成 JSON 文件；
- 属性面板新增**历史版本**区块：列出存储保留的最近 3 个版本（版本号、落盘时间、
  「当前」标记，迁移前留下的旧格式版本单独标注），可以对任意旧版本发起「还原」；
  还原走运行时自带的 `history.restore` 命令——旧内容写回当前文档，但 revision
  继续单调递增，事务日志里也留一笔，所以这次还原本身还能再撤销回去；存储里的
  旧格式文档在读取时会被迁移到当前格式，因此「回滚升级」取回的是升级前的**内容**，
  而不是把整个应用退回旧格式；
- 弹窗层修掉一个静默缺陷：确认框的「确定」按钮此前会被 Radix 关闭弹窗的动作覆盖成
  `false`，导致「删除项目」这类确认流程点了也没反应；现在结算放在按钮的 onClick 里，
  并补了 jsdom 回归测试（真实 Radix + 真实 DOM 事件）；同时新增多选一弹窗，供导入
  冲突这类需要用户在几个动作之间选择的场景使用；
- 画布几何改由 `design-layout` 解析，不再直接读取节点的 `layout` 原始值，因此 hug、fill、
  stack 在编辑器内与导出结果一致；文本测量通过宿主契约注入浏览器 Canvas 字体度量；
- 图层面板为嵌套树，支持折叠展开、节点类型图标、层级缩进，以及基于 dnd-kit 的拖拽排序
  （同级重排与拖入容器两种落点）；重排通过 `node.reparent` 命令提交，可撤销；
- 组件系统已接入 UI：可将选中节点提升为组件根（`component.create`），按需实例化
  （`component.instantiate`，实例会物化组件子树并支持 overrides），并在组件面板列出
  组件与实例计数；实例可正常参与布局、画布渲染与导出；
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
  （而非整块 960×680 画布）且只缩不放；缩放用 CSS `zoom` 实现，Moveable 读取
  offsetParent 的 `zoom` 并纳入矩阵栈，拖拽与手柄几何在缩放下保持正确；工作区过窄时
  控件按重要性用容器查询降级；
- 画布拖拽的根因修复：入口不再在模块顶层无条件 `createRoot`，而是在容器上缓存并复用
  root，Vite HMR 重新执行模块时只重新 render，不会出现两棵 React 树互相撕裂 DOM
  （此前表现为点击随机失效、拖拽坐标错乱）；
- 画布拖拽与缩放的坐标修复：Moveable 的 `bounds` 之前带 `position: "css"`，该模式下
  `right`/`bottom` 被当成 CSS 的 `right`/`bottom` 偏移反算，960×680 的画布因此退化成
  0×0 的边界框，于是任何一次拖拽或缩放都会把节点甩到 `left = -width`/`top = -height`；
  现在 `bounds` 固定为坐标语义的 `CANVAS_BOUNDS`，拖拽位移与指针位移一一对应，
  拖出画布时按画布边界正确钳制，缩放手柄同样恢复正常；
- 图层工具栏提供椭圆节点入口（`ellipse` 节点类型），形状由 `borderRadius: 50%` 表达；
- 布局引擎的 warnings 上浮到属性面板的「布局警告」区块，点击警告行可直接选中对应节点；
- 属性面板支持文本内容、字体、字号、行高、节点显隐和锁定；文本修改通过独立
  `text.patch` 命令校验类型和数值，不扩张通用节点 patch；
- 文本样式补齐粗细、字形、盒内对齐与字间距：属性面板「文字」区提供粗细（常规/中等/
  半粗/加粗）、字形（常规/斜体）、对齐（左/中/右）和字距四个控件，画布渲染与行内
  编辑（textarea）同步跟随；浏览器 Canvas 测量器把字重/字形写进 `context.font`、
  按字符数补上字距，缓存键带上样式，避免不同字重的文本共用一次测量结果；hug 宽度
  会随字重和字距变化（例如 8 个汉字在字距 4px 下比 0px 宽 32px）；
- 工作台可下载当前页面的独立 HTML、SVG 交付物和当前项目 JSON 备份，并报告导出诊断数量；
  PNG 交付物由 SVG 经浏览器 Canvas 光栅化生成；
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

- 生产可用的 `studio-web` 或桌面工作台；当前只有 Web 垂直切片；
- 生产可用的渲染系统；画布为 DOM 渲染，尚未引入 Canvas/SVG 渲染器与性能基线；
- 生产可用的文本测量；浏览器端测量依赖 Canvas 字体度量，未做跨平台字体基线与缓存策略；
- PNG 导出的独立交付链路；当前由 SVG 经浏览器 Canvas 光栅化生成，外部图片会污染画布；
- React、PDF 等后续导出格式；
- 生产级 AI Provider 体验、流式响应、凭据安全、Reviewer 和完整结构审查闭环；当前已有
  OpenAI-compatible Planner、安全计划、dry-run、可视化确认与提交原型；
- 独立 Studio 的 MCP adapter；
- 不依赖 Figma 的端到端设计工作流；
- 导入冲突策略目前只在"同一个项目 id"这一种情况下会询问用户；只撞名字不撞 id
  的文件一律当作新项目导入；
- 存储配额策略目前只有"识别并提示"，还没有配额监控、占用视图与清理引导；
- 备份目前只有手动导出的项目 JSON，还没有自动备份与备份轮转；
- 迁移只覆盖了文档格式这一条链路，存储布局版本（文件系统 manifest、浏览器
  IndexedDB）虽有版本号，但旧布局的迁移步骤尚未成体系。
- 回滚只到快照级：历史版本面板能还原到保留的旧版本，但没有事务级的逐条回退入口。

## 文档阅读优先级

1. 本文：确认当前实际能力；
2. `project-progress-and-version-roadmap.md`：确认功能对应的软件版本和发布门槛；
3. 根级 `AGENTS.md`：开发约束和当前边界；
4. 各包源码、测试及包级 `AGENTS.md`：确认实现细节；
5. `ai-design-studio-architecture-analysis.md`：了解目标架构和未来路线。

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
npm run build:studio-web
npm run test -w packages/studio-web
```

本地启动 Web 垂直切片：

```bash
npm run dev:studio-web
```

这些命令成功仅表示底层包能够构建并通过已有测试，不表示独立 Studio 已经可运行。

不要把 `npm run socket`、Figma 插件安装或 Vibma MCP 配置作为本项目的运行步骤。
