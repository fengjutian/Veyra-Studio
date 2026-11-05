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
  padding、gap、对齐、文本测量接口和结构化布局警告；
- `packages/design-export`：独立 HTML/CSS 导出原型，保留布局与 CSS Token 语义，并对
  不支持或降级的特性输出诊断；
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

- 独立的 `studio-web` 或桌面工作台；
- 可交互画布、图层面板和属性面板；
- 生产可用的布局、文本测量和渲染系统；
- 生产可用的 HTML/CSS，以及 PNG、SVG 的完整独立导出链路；
- AI Provider、Planner、dry-run、审批、Reviewer 的完整编辑闭环；
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
```

这些命令成功仅表示底层包能够构建并通过已有测试，不表示独立 Studio 已经可运行。

不要把 `npm run socket`、Figma 插件安装或 Vibma MCP 配置作为本项目的运行步骤。
