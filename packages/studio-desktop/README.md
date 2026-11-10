# @ufira/studio-desktop

AI Design Studio 的 Tauri 桌面端外壳。

前端**不是**这里的一份副本：桌面端直接加载 `packages/studio-web` 的构建产物，
跑的仍是同一份编辑器代码。桌面端负责三件事：原生窗口、原生「另存为」、以及把
导出落盘的真实路径回报给界面。

## 用法

```bash
npm run dev:desktop     # 仓库根目录：拉起 vite + 原生窗口
npm run build:desktop   # 仓库根目录：产出 exe 与 NSIS 安装包
```

包内直接跑：

```bash
npm run build           # tauri build（先跑 beforeBuildCommand 构建前端）
npm run tauri -- --help
npm run icons           # 从仓库根目录的 logo.svg 重新生成图标
```

## 结构

| 路径 | 作用 |
| --- | --- |
| `src-tauri/tauri.conf.json` | 窗口、构建产物、打包配置 |
| `src-tauri/capabilities/default.json` | 权限表：只要核心 API |
| `src-tauri/src/main.rs` | 原生命令 `save_file` |
| `src-tauri/icons/` | 应用图标 |

## 原生命令

| 命令 | 入参 | 返回 |
| --- | --- | --- |
| `save_file` | `name: string`、`contents: string`（base64） | 落盘路径；用户取消返回 `null` |

前端侧的桥接在 `packages/studio-web/src/desktop-bridge.ts` 与
`packages/studio-web/src/file-sink.ts`，细节见 [桌面端文档](../../docs/desktop-app.md)。
