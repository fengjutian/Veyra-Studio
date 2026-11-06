# 当前项目状态

> 状态日期：2026-11-05  
> 用途：为开发者和 AI 提供当前实现范围的单一事实入口

## 一句话结论

当前项目的唯一开发方向是 **独立 AI Design Studio**。Studio 仍处于 Phase 0，现有代码
只是底层原型，还不是可用的独立设计应用。原 Vibma MCP-to-Figma bridge 已停止使用，
只保留为迁移和行为研究的遗留代码；不得把它作为产品运行时或新功能后端。

## 当前开发范围

### 独立 Studio 的 Phase 0 基础

- `packages/design-schema`：早期设计文档类型、Schema 与校验；
- `packages/design-runtime`：早期命令和运行时原型；
- `packages/design-persistence`：文件系统快照、事务日志、资产存储，以及从最后有效快照
  连续重放已提交事务的崩溃恢复原型；
- `packages/design-layout`：宿主无关的 absolute/stack 布局原型，支持 fixed、fill、hug、
  padding、gap、对齐、文本测量接口和结构化布局警告；文本测量提供确定性的字符宽度估算器
  与宿主可注入的测量契约（`createHostTextMeasurer`），修复了 hug 文本高度不随可用宽度换行
  的缺陷；
- `packages/design-export`：独立 HTML/CSS 导出原型，保留布局与 CSS Token 语义，并对
  不支持或降级的特性输出诊断；新增独立 SVG 导出，SVG 几何由布局引擎解析，stack、fill、
  hug 语义与画布一致；
- `packages/studio-application`：串联项目创建、命令事务、日志与快照、恢复、布局和
  HTML/SVG 导出的应用服务原型，并提供不修改真实项目的命令预演入口，作为未来工作台与
  AI Orchestrator 的共同入口；
- `packages/ai-orchestrator`：AI 安全编辑闭环的第一阶段原型，包含可替换 Planner
  契约、临时运行时 dry-run、before/after 预览、影响节点、warnings、取消、显式确认
  提交，以及基于 `baseRevision` 的过期计划拒绝；尚未接入真实模型 Provider 和 UI；
- `packages/studio-web`：可运行的 React 工作台垂直切片，包含本地图层列表、DOM 画布、
  节点创建/选择/框选/拖动/缩放/吸附/删除、基础属性编辑、Dexie/IndexedDB 项目、事务
  和二进制资产存储，以及 AI 计划预览、过期提示、取消和确认提交界面；画布交互层
  已接入 Moveable/Selecto 并延迟加载，支持 Shift/框选、多节点批量拖动、缩放和删除，
  所有群组变换在交互结束时作为一个原子事务提交；浏览器存储支持快照后事务重放、
  revision 缺口降级报告、资产哈希校验和旧 localStorage 快照迁移；尚未接入真实 AI Provider；
  工作台顶部支持项目列表、新建、切换、通过领域命令重命名，以及原子清理项目快照、
  事务和资产的删除操作；
- 画布几何改由 `design-layout` 解析，不再直接读取节点的 `layout` 原始值，因此 hug、fill、
  stack 在编辑器内与导出结果一致；文本测量通过宿主契约注入浏览器 Canvas 字体度量；
- 图层面板为嵌套树，支持折叠展开、节点类型图标、层级缩进，以及基于 dnd-kit 的拖拽排序
  （同级重排与拖入容器两种落点）；重排通过 `node.reparent` 命令提交，可撤销；
- 组件系统已接入 UI：可将选中节点提升为组件根（`component.create`），按需实例化
  （`component.instantiate`，实例会物化组件子树并支持 overrides），并在组件面板列出
  组件与实例计数；实例可正常参与布局、画布渲染与导出；
- 人工编辑支持可持久化撤销/重做及 `Ctrl/Cmd+Z`、`Shift+Ctrl/Cmd+Z` 快捷键；历史操作
  以 `history.restore` 事务写入日志，revision 保持单调递增，并可在快照后连续重放；
- 属性面板支持文本内容、字体、字号、行高、节点显隐和锁定；文本修改通过独立
  `text.patch` 命令校验类型和数值，不扩张通用节点 patch；
- 工作台可下载当前页面的独立 HTML、SVG 交付物和当前项目 JSON 备份，并报告导出诊断数量；
  PNG 交付物由 SVG 经浏览器 Canvas 光栅化生成；
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
- AI Provider、真实 Planner、可视化审批、Reviewer 的完整编辑闭环；当前仅有安全计划、
  dry-run 与确认提交的应用层原型；
- 独立 Studio 的 MCP adapter；
- 不依赖 Figma 的端到端设计工作流。

## 文档阅读优先级

1. 本文：确认当前实际能力；
2. 根级 `AGENTS.md`：开发约束和当前边界；
3. 各包源码、测试及包级 `AGENTS.md`：确认实现细节；
4. `ai-design-studio-architecture-analysis.md`：了解目标架构和未来路线。

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
```

本地启动 Web 垂直切片：

```bash
npm run dev:studio-web
```

这些命令成功仅表示底层包能够构建并通过已有测试，不表示独立 Studio 已经可运行。

不要把 `npm run socket`、Figma 插件安装或 Vibma MCP 配置作为本项目的运行步骤。
