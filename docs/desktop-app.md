# 桌面端（Tauri）

> 文档状态：生效中的实现规格
> 建立日期：2026-11-10
> 关联文档：`current-project-status.md`、`project-progress-and-version-roadmap.md`（`0.2.0`）

## 1. 桌面端解决什么

浏览器版把编辑器、数据、导出全关在浏览器沙箱里：

- 项目存在 IndexedDB，清站点数据就没了，换设备没法带走；
- 导出走 `<a download>`，文件落在浏览器的下载目录，用户既看不见路径也管不了落在哪；
- 应用没有自己的身份，只能开一个网页标签。

桌面端把这三件事收进原生外壳：**自己的窗口、自己的数据目录、自己的保存对话框**。

## 2. 结构

桌面端是独立包 `packages/studio-desktop`，**不复制** studio-web 的任何前端代码：

```
packages/studio-desktop/
  package.json              # tauri CLI 与构建脚本
  src-tauri/
    tauri.conf.json         # 窗口、构建产物、打包配置
    capabilities/default.json
    src/main.rs             # 原生命令：save_file
    icons/                  # 由仓库根目录 logo.svg 生成
```

前端资源直接复用 `packages/studio-web` 的构建产物（`packages/studio-web/dist`）：

- 开发：`devUrl` 指向 studio-web 的专用 Vite dev server（`http://localhost:15173`）；Vite 使用
  `strictPort`，端口被占用时会直接报错，不会静默切换端口导致桌面壳加载错误地址；
- 打包：`frontendDist` 指向 `packages/studio-web/dist`，由 `beforeBuildCommand` 先构建。

两份前端只有一份实现——桌面端不是「另一个编辑器」，是同一个编辑器的另一种宿主。

## 3. 桌面端与浏览器端的唯一行为差异：导出落盘

其余功能（画布、属性面板、AI 规划、导入、版本历史）在桌面端与浏览器端**完全一致**，
因为它们跑的是同一份前端代码、同一套 IndexedDB 持久化。

导出是唯一需要区分的地方：

| | 浏览器 | 桌面端 |
| --- | --- | --- |
| 落盘方式 | `<a download>`，落进浏览器下载目录 | 原生「另存为」对话框 |
| 用户能否选目录 | 不能 | 能 |
| 界面回报 | 无 | 真实落盘路径 |

分界点收在 `packages/studio-web/src/file-sink.ts`：桌面端走 `save_file` 命令，
浏览器走原来的 `<a download>`。调用方只问「存没存成、存在哪」。

### 3.1 为什么前端不依赖 `@tauri-apps/api`

studio-web 的同一份前端要同时跑在浏览器和桌面端，引入 Tauri 的 npm 包会把桌面
专用代码打进网页构建。桌面桥（`packages/studio-web/src/desktop-bridge.ts`）按鸭子
类型探测 `window.__TAURI__`，有就用、没有就走浏览器分支，网页构建里这段代码等于不存在。

### 3.2 为什么内容走 base64

IPC 的 JSON 通道只认文本，裸二进制会被展开成「数字数组」：一张 PNG 能顶到几十万个
数字。`save_file` 命令收 base64 字符串，Rust 侧解码后落盘。

### 3.3 取消保存要说实话

用户在「另存为」对话框点取消，文件并没有落盘。界面这时报「已取消导出」，
不报「已导出」——取消保存后说成功是骗人。

## 4. 开发与构建

```bash
npm install                 # 安装工作区依赖（含 @tauri-apps/cli）
npm run build:studio-web    # 前端构建产物（打包前会自动跑一遍）
npm run dev:desktop         # 开发模式：拉起 vite + 原生窗口
npm run build:desktop       # 打包：产出 exe 与 NSIS 安装包
```

产物位置：

- 可执行文件：`packages/studio-desktop/src-tauri/target/release/veyra-desktop.exe`
- 安装包：`packages/studio-desktop/src-tauri/target/release/bundle/nsis/`

单独跑 Rust 侧（需要 `packages/studio-web/dist` 已存在，`generate_context!` 会把它
打进二进制）：

```bash
cd packages/studio-desktop/src-tauri
cargo check
```

## 5. 依赖与已知限制

- **WebView2 运行时**：Windows 上必须装 Microsoft Edge WebView2 Runtime。缺运行时时
  窗口创建会失败（`拒绝访问。 (os error 5)`）。
  注意：`msedgewebview2.exe --version` 退出码 13 **不能**用来判断运行时是否可用——
  那个二进制不认这个开关，退出码 13 只说明"参数不认"。判据是**把应用跑起来看有没有窗口句柄**。
- **数据仍在 WebView2 里**：项目继续存在 IndexedDB，落在 WebView2 的用户数据目录，
  不是 Tauri 的 app data 目录。换成本地文件存储（`app_data_dir` + 原生仓储）是下一步，
  当前版本没有做。
- **导入仍用 `<input type="file">`**：WebView2 里它弹的就是 Windows 原生文件选择器，
  体验上已经是原生的，因此没有另写一套。
- **只出 Windows 包**：`targets` 配的是 `nsis`。macOS / Linux 的打包没有配置。
- **CI 没覆盖桌面端**：Studio CI 跑在 ubuntu-latest 上，桌面端的编译与打包目前只在本地验证过。
  要进 CI 需要单独的 Windows runner（Rust 工具链 + NSIS 下载）。
