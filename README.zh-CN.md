# AI Design Studio

本地优先、宿主无关的 AI 界面设计环境。

> **Phase 0：** 独立 Studio 正在开发，但目前还不是可用的编辑器。
> MCP-to-Figma bridge 已转为遗留参考代码，不得作为产品运行时或默认开发路径。

## 当前范围

已经落地的基础：

- `packages/design-schema`：设计文档类型、Schema 与校验；
- `packages/design-runtime`：命令与事务运行时原型；
- `packages/design-persistence`：文件系统持久化原型。

独立 UI、交互画布、生产渲染器、导出链路和完整 AI 编辑闭环尚未实现。

实际实现状态以 [当前项目状态](./docs/current-project-status.md) 为准；目标设计参见
[AI Design Studio 架构方案](./docs/ai-design-studio-architecture-analysis.md)。

## 开发

```bash
npm install
npm run build:studio-core
npm run test:studio-core
npm run dev:studio-web
```

这些命令只验证 Phase 0 底层包。

## 桌面端

`packages/studio-desktop` 是 Tauri v2 桌面端外壳：跑的是同一份 studio-web 前端，
额外提供原生窗口与原生「另存为」（导出不再落到浏览器下载目录）。

```bash
npm run dev:desktop     # 开发模式
npm run build:desktop   # 产出 exe 与 NSIS 安装包
```

设计与取舍见 [桌面端文档](./docs/desktop-app.md)。

## 遗留 Vibma 代码

Vibma/Figma 相关包、relay、插件、Schema 和安装指南只保留用于受控迁移与行为参考。
新开发不要启动 relay、连接 Figma 插件、配置旧 MCP Server，也不要让 Studio 包依赖
Vibma/Figma 运行时代码。

## 许可证

[MIT](./LICENSE)
