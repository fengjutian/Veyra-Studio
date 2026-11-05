# AI Design Studio 独立化架构方案

> 基于 Vibma 1.1.5 源码与 GitNexus 调用图的架构决策稿<br>
> 状态：Draft v1.1<br>
> 更新日期：2026-11-05<br>
> 适用范围：产品 V1、Phase 0 技术验证与后续迁移评审

> [!IMPORTANT]
> **本文是目标架构与实施决策稿，不是当前功能说明。** 截至 2026-11-05，Vibma bridge
> 已停止使用，仅作为迁移参考保留。仓库仅实现了 `design-schema`、
> `design-runtime` 和 `design-persistence` 的早期 Phase 0 基础；独立 Studio UI、渲染器、
> 布局与文本引擎、AI 编排及完整导出链路尚未完成。判断实际能力时，以
> [`current-project-status.md`](./current-project-status.md)、源码和测试为准；本文中的目录树、
> V1 清单与 Phase 1—5 内容均不得视为已经实现。

## 1. 决策摘要

项目将建设为独立 AI 设计应用，但不能通过“给现有 Figma bridge 增加一个界面”实现。正确路径是在当前 monorepo 内建立隔离的新应用边界，以新的设计文档和命令运行时替代 Figma 提供的隐式能力。Vibma 产品链路停止使用，仅作为迁移期间的行为与设计规则参考。

本方案冻结以下方向：

1. **新建设计运行时，不模拟 Figma Runtime。** 场景图、布局、组件、token、历史、渲染与持久化均使用宿主无关模型。
2. **应用内部不依赖 MCP。** 画布、属性面板、内置 AI 和外部 MCP Agent 统一调用命令总线；MCP 只是协议适配器。
3. **优先复用机制，不直接搬迁实现。** 复用 Schema 编译思想、工具契约、批处理语义、结构化告警、设计规范和通用 utility；Figma handlers 仅作为行为样本。
4. **V1 聚焦结构化 Web/UI 设计。** 不承诺通用矢量编辑、Figma 文件完整兼容、多人实时协作或任意 React 工程双向同步。
5. **先验证核心风险，再建设完整工作台。** Phase 0 必须验证文档模型、事务、布局、文本测量、画布性能及预览—导出一致性。

成功标准不是“AI 能生成一张图”，而是人和 AI 能安全地共同维护一个可编辑、可验证、可恢复、可交付的设计工程。

## 2. 目标与边界

### 2.1 产品定位

AI Design Studio 是本地优先的 AI 原生界面设计环境。它维护的不是最终图片，而是一份包含节点、布局、设计 token、组件、资产、编辑历史和导出语义的结构化设计文档。

目标用户包括：

- 需要快速完成 Web 产品界面的设计师；
- 需要从需求生成结构化原型的产品经理；
- 需要获得 HTML/CSS 或前端骨架的开发者；
- 希望让本地或云端 Agent 安全操作设计工程的高级用户。

### 2.2 V1 范围

V1 必须交付：

- 本地项目的创建、打开、自动保存、恢复和导入导出；
- 页面、Frame、文本、图片、矩形、椭圆和容器节点；
- 图层树、选择、移动、缩放、复制、删除、重排和属性编辑；
- 横向/纵向自动布局，以及 fixed、fill、hug 尺寸策略；
- 颜色、字体、间距和圆角 token；
- 组件定义、实例和受限 override；
- 原子事务、撤销、重做和崩溃恢复；
- AI 页面生成、局部修改、结构审查、变更预览和回滚；
- HTML/CSS、PNG，以及受支持子集的 SVG 导出；
- 文档 Schema 版本迁移和导出能力诊断。

### 2.3 V1 不做

- Figma 文件格式的完整读写兼容；
- 钢笔、复杂布尔路径和专业插画工具；
- 多人实时协作及 CRDT；
- 任意 React 工程的无损双向同步；
- 完整原型动画和交互状态机；
- 插件市场、移动端编辑器或自有基础模型训练。

## 3. 当前架构与源码证据

### 3.1 当前运行链路

```text
MCP Client
    │ stdio
    ▼
packages/core                 工具注册、Schema、素材服务、请求关联
    │ WebSocket
    ▼
packages/tunnel               一对一通道、心跳、消息转发
    │ WebSocket
    ▼
packages/adapter-figma        命令分发、Figma API 操作、结果整形
    │
    ▼
Figma Runtime                 节点、布局、字体、组件、变量、渲染、导出
```

GitNexus 当前索引覆盖 153 个文件、3,257 个符号和 282 条执行流。调用图验证了以下边界：

- `packages/core/src/mcp.ts` 的 `main` 调用 `registerAllTools`，然后通过 WebSocket 把工具请求转发给 Figma 插件。
- `registerAllTools` 不只是工具注册器；它还直接编排 Figma REST library、Iconify、Pexels、图片预处理、样式解析和组件名称解析。
- `schema/compiler/gen-mcp.ts` 生成工具定义和方法 dispatch metadata，是现有单一事实源的重要部分。
- `packages/adapter-figma/src/handlers/registry.ts` 把 `endpoint.method` 映射到 Figma handlers。
- 典型更新链路为 `text.update → patchNodesBatch → batchHandler → sendBatchProgress`。
- `batchHandler` 被 frame、text、component、instance、variable 等大量创建和更新路径共享，统一承担参数 guard、逐项错误、进度、结果简化和 warning 汇总。

### 3.2 关键判断

当前系统并没有独立的设计引擎。设计状态和大部分行为由 Figma Runtime 提供：节点与引用存储、自动布局、文本测量、字体加载、组件、实例、样式、变量、选择、渲染、导出和版本历史。

因此“删除 Figma API 调用”不会留下一个可运行的编辑器，只会移除现有系统的执行后端。独立化的核心工作是重建这些能力中 V1 所需的受限子集。

## 4. 资产复用策略

### 4.1 复用矩阵

| 现有资产 | 决策 | 落点 |
| --- | --- | --- |
| `schema/compiler` | 抽取并演进 | 迁入 `tool-contracts`；继续生成 Schema、帮助、guard、类型和文档。 |
| `schema/tools/*.yaml` | 语义迁移 | 保留 endpoint 思想，按新文档模型重写字段，不复制 Figma 偶然语义。 |
| CRUD endpoint 契约 | 对外复用 | 适合 AI/MCP；内部命令不受 CRUD 形态限制。 |
| `batchHandler` | 复用行为，重写实现 | 把校验、进度和 warning 汇总迁入应用服务；原实现仍留在 Figma adapter。 |
| warnings、lint、guidelines | 高优先级迁移 | 改为对新文档模型运行，是产品差异化能力。 |
| color、WCAG、coercion | 小幅整理后复用 | 放入 `shared` 并补充单元测试。 |
| Iconify、Pexels | 适配后复用 | 放入资产 provider，增加缓存、许可和 attribution 元数据。 |
| `registerAllTools` | 拆解参考，不直接迁移 | 分离协议注册、素材 provider、参数预处理和宿主命令。 |
| Figma handlers | 行为与测试样本 | 用于提炼不变量和兼容测试，不进入 `design-runtime`。 |
| `packages/tunnel` | 主链路移除 | 独立应用不需要 relay；仅为旧 Figma 适配器保留。 |
| Figma REST library | 适配器内保留 | 只属于 Figma importer/integration。 |

### 4.2 禁止的迁移方式

- 不创建伪 `SceneNode` 来模拟 Figma API。
- 不把 `allFigmaHandlers` 改名后当作新运行时。
- 不让 React/Zustand store 成为设计文档的唯一事实源。
- 不把 Konva、Fabric、DOM 或 SVG 对象写入项目文件。
- 不用 Figma ID、plugin data 或远程 library key 作为内部主标识。
- 不让 AI 绕过人工编辑所使用的校验和事务入口。

### 4.3 开源能力引入需求

为缩短 Studio 工作台、导出与 AI 闭环的开发周期，项目优先复用成熟开源项目，但只复用通用机制，不让第三方库接管设计领域语义。所有候选依赖在进入生产代码前必须完成许可证、维护活跃度、包体积、安全公告、浏览器兼容性和退出成本审查，并记录到 ADR 与第三方软件清单。

强制边界如下：

1. 画布交互库只能输出选择、移动、缩放、旋转和吸附意图；拖拽中的变化属于 preview，`pointerup` 后必须转换为 `DesignCommand` 并通过 `DesignRuntime.execute` 原子提交。
2. 状态、编辑器或渲染库的对象不得写入 `DesignDocument`，不得成为节点 ID、历史记录或持久化格式的一部分。
3. AI SDK 只负责模型 Provider、流式输出、结构化输出和工具调用；Planner、影响集、dry-run、审批、`baseRevision`、事务和回滚由 Studio 自己实现。
4. 持久化库必须实现 `ProjectRepository`，不得让 IndexedDB、OPFS、SQLite 或第三方数据结构泄漏到应用服务和领域层。
5. 布局、渲染与导出候选必须位于适配器之后，并以同一份 `DesignDocument`、同一套布局结果和支持矩阵为输入。
6. 引入依赖前必须准备退出路径：适配器契约、最小集成面、契约测试和可替换实现；禁止在 UI 中直接散布第三方 API 调用。

候选矩阵：

| 缺失能力 | 候选项目 | 决策 | 集成边界 |
| --- | --- | --- | --- |
| 拖拽、缩放、旋转、组合与吸附 | Moveable（MIT） | Phase 1/2 优先验证 | `CanvasInteractionAdapter`，只产生 preview 与命令意图 |
| 框选与多选 | Selecto（MIT） | 与 Moveable 配套验证 | 写入 Selection Service，不直接修改文档 |
| Web 项目持久化 | Dexie（Apache-2.0） | Phase 1 采用 | 实现 IndexedDB `ProjectRepository`；大资产可后接 OPFS |
| PNG/PDF 与视觉回归 | Playwright（Apache-2.0） | Phase 2 优先采用 | 加载隔离的 HTML/CSS 预览并截图；不作为领域渲染器 |
| 多模型 Provider 与流式 UI | Vercel AI SDK（Apache-2.0） | Phase 3 优先采用 | 位于 `ai-orchestrator` Provider 层，输出必须转为受校验的命令计划 |
| 增量变更与 inverse patch | Immer（MIT） | 先做 spike | 可作为 `ChangeSet` 内部实现，不作为公开日志协议 |
| 图层树和面板拖放 | dnd-kit（MIT） | Phase 1/2 采用 | 仅用于 UI 排序与拖放意图，最终通过 `node.reparent` 等命令提交 |
| Flex 布局 | Yoga（MIT） | 与当前布局器、浏览器做三方 spike | 位于 `LayoutEngine` 适配器之后，不持久化 Yoga 节点 |
| Token 跨平台转换 | Style Dictionary（Apache-2.0） | Phase 4 采用 | 只消费规范化 token 并生成 CSS/JSON 等交付物 |
| 大规模 WebGL 渲染 | PixiJS（MIT） | DOM 基准失败后再评估 | 仅实现 `RenderAdapter`，不得替代场景文档 |
| 多人协作 | Yjs（MIT） | V1 后置 | 同步命令/事务及 awareness，不把 Y 类型写入文档 Schema |

参考型项目不作为核心依赖：Puck 可借鉴 React 组件面板、slot 和属性配置；GrapesJS 可借鉴 Block、Style、Device 与 Asset Manager；Excalidraw 可借鉴无限画布、快捷键、复制粘贴和恢复体验。它们各自的数据模型不得替换 `DesignDocument`。tldraw 当前生产许可不符合“核心能力使用宽松开源许可证”的默认要求，只允许作为交互参考，除非后续 ADR 明确接受商业许可。

首批依赖目标限定为 `react-moveable`、`react-selecto`、`dexie`、`dnd-kit`、`playwright` 和 Vercel AI SDK。Immer 与 Yoga 必须先通过 spike；PixiJS 与 Yjs 只有在性能或协作需求被正式纳入范围后才可引入。

## 5. 目标架构

```text
┌──────────────────────────── Application Shell ────────────────────────────┐
│ Workspace │ Layers │ Canvas │ Inspector │ Assets │ AI Chat │ History     │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ intents / queries
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Application Services                                                      │
│ Command Bus │ Query Service │ Transaction Manager │ Selection │ Viewport  │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │ validated commands
┌──────────────────────────────────▼────────────────────────────────────────┐
│ Design Runtime                                                            │
│ Document │ Scene Graph │ Layout │ Components │ Tokens │ Assets │ Lint     │
└───────────────┬──────────────────────┬──────────────────────┬───────────────┘
                │                      │                      │
        ┌───────▼────────┐     ┌───────▼────────┐     ┌──────▼──────────────┐
        │ Render Adapters │     │ Persistence    │     │ Integrations       │
        │ Canvas / Export │     │ Web / Desktop  │     │ AI / MCP / Figma   │
        └─────────────────┘     └────────────────┘     └─────────────────────┘
```

### 5.1 依赖规则

1. `design-runtime` 不依赖 React、Zustand、Tauri、MCP SDK、Figma 或具体画布库。
2. UI、AI、导入器和外部 Agent 只能查询快照或提交命令，不能直接改写领域状态。
3. 持久化保存规范化文档、事务和资产，不保存渲染器运行时对象。
4. 布局结果是可重算派生数据；渲染器和命中测试消费同一结果。
5. 导出器使用同一设计文档；不支持的特性必须产生明确诊断。
6. MCP、Figma、素材服务和未来插件均为可替换适配器。

### 5.2 初期目录

```text
apps/
  studio-web/             # React 工作台
  studio-desktop/         # Tauri 壳，后续启用
packages/
  design-schema/          # 类型、Zod、序列化、迁移
  design-runtime/         # 场景图、命令、事务、布局、组件、token、lint
  design-renderer/        # 画布、预览和导出适配
  ai-orchestrator/        # Provider、上下文、规划、审批、执行
  tool-contracts/         # Schema 编译器与 AI/MCP 工具契约
  integrations/           # MCP、Figma、Iconify、Pexels
  shared/                 # color、WCAG 和通用 utility
schema/
  tools/
```

初期只创建有真实代码和稳定职责的包，不提前拆成十余个空壳模块。

## 6. 核心领域契约

### 6.1 设计文档

```ts
interface DesignDocument {
  schemaVersion: number;
  id: DocumentId;
  revision: number;
  meta: DocumentMeta;
  pages: PageId[];
  nodes: Record<NodeId, DesignNode>;
  components: Record<ComponentId, ComponentDefinition>;
  tokens: TokenStore;
  assets: Record<AssetId, AssetMetadata>;
}

type DesignNode =
  | FrameNode
  | TextNode
  | ImageNode
  | RectangleNode
  | EllipseNode
  | VectorNode
  | ComponentRootNode
  | InstanceNode;

interface BaseNode {
  id: NodeId;
  type: DesignNode["type"];
  name: string;
  parentId: NodeId | PageId;
  childIds: NodeId[];
  visible: boolean;
  locked: boolean;
  layout: LayoutSpec;
  appearance: AppearanceSpec;
  bindings?: PropertyBindings;
  externalRefs?: ExternalReference[];
}
```

文档模型遵循以下不变量：

- 节点使用扁平记录和显式父子引用，树中不存在孤儿、重复 child 或循环。
- 节点为判别联合，不用 `Record<string, unknown>` 承载全部样式。
- token 绑定与计算值分离，token 修改可追踪影响范围。
- 布局输入持久化，`ComputedBox` 作为可重算缓存。
- 组件实例保存定义引用和显式 override，不复制定义树作为事实源。
- 资产使用稳定 `AssetId`，二进制按内容哈希去重。
- 外部系统 ID 只能保存在 `externalRefs`。
- Schema 迁移是连续、可测试、失败不覆盖原文件的纯函数。

### 6.2 布局

V1 支持 `absolute`、横向或纵向 `stack`、fixed/fill/hug，以及 min/max、padding、gap、alignment、wrap 和 absolute child。`grid` 后置到 V1.x。

首版不自研完整 CSS 布局算法；Phase 0 需比较浏览器布局、Yoga 或其他独立引擎在文本测量、嵌套自适应、跨平台一致性和导出一致性上的表现。

### 6.3 组件

- 定义拥有结构、可暴露属性和 slot。
- 实例引用定义并保存 override。
- V1 override 限定为文本、显隐、图片、token 和实例替换。
- 实例默认不能任意改写定义树。
- detach 将解析后的实例物化为具有新 ID 的普通节点。
- 定义不得直接或间接循环引用。

### 6.4 命令和事务

```ts
type DesignCommand =
  | { type: "node.create"; payload: CreateNodeInput }
  | { type: "node.patch"; payload: PatchNodeInput }
  | { type: "node.delete"; payload: DeleteNodeInput }
  | { type: "node.reparent"; payload: ReparentNodeInput }
  | { type: "token.upsert"; payload: UpsertTokenInput }
  | { type: "component.instantiate"; payload: InstantiateInput };

interface CommandEnvelope {
  commandId: string;
  documentId: DocumentId;
  baseRevision: number;
  actor: { type: "human" | "ai" | "integration"; id: string };
  commands: DesignCommand[];
}

interface CommandResult {
  revision: number;
  changes: ChangeSet;
  inverse: ChangeSet;
  warnings: DesignWarning[];
}
```

执行顺序固定为：

```text
Schema 校验 → capability 校验 → 领域不变量校验
→ 计算 ChangeSet / inverse → 原子提交
→ lint 与 warnings → 追加事务日志 → 通知派生视图
```

事务边界：

- 一次拖拽只在 pointer up 时提交一个事务，中间状态属于 preview。
- 属性面板连续输入在时间窗口内合并。
- 一次 AI 确认对应一个可整体撤销的事务。
- 批处理默认原子提交；部分成功必须由工具契约显式声明。
- 所有写入携带 `baseRevision`，冲突时重新规划或明确报错，禁止静默覆盖。

## 7. AI 编辑闭环

### 7.1 分层

- `Provider`：模型调用、流式输出、取消、重试和用量统计；
- `Context Builder`：根据任务和选择构建最小上下文；
- `Planner`：生成意图、假设、命令计划和影响集合；
- `Executor`：dry-run、权限校验、提交与回滚；
- `Reviewer`：确定性 lint、视觉规则和可选多模态审查；
- `Policy`：网络、密钥、成本和危险操作规则。

首版使用一个编排器，不提前拆分多个自治 Agent。只有评测证明独立上下文能稳定提升质量时，才拆分专用 Agent。

### 7.2 修改协议

```text
用户意图 → 选择最小上下文 → 生成命令计划与影响节点
→ 在临时分支 dry-run → 展示视觉预览、结构 diff、warnings 和导出影响
→ 用户确认 → 检查 baseRevision → 原子提交或要求重新规划
```

AI 不输出整份文档，也不能绕过命令总线。低风险、可逆操作可由用户配置为自动提交；批量删除、重建组件、覆盖 token、联网或高成本调用必须确认。

### 7.3 确定性能力优先

ID、引用、树结构、组件循环、布局、token 解析、对比度、结构 lint、影响范围、revision 冲突、inverse change 和导出支持性均由设计运行时处理。LLM 负责意图理解、内容创作、方案生成和审美建议。

### 7.4 MCP 的位置

```text
External Agent ─→ MCP Adapter ─┐
Studio AI Chat ────────────────┼→ Command Bus → Design Runtime
Canvas / Inspector ────────────┘
```

这保留了 Vibma 的 Agent 生态，同时保证应用在没有 MCP、relay、Figma 或外部 Agent 时仍能完整工作。

## 8. 渲染、存储与导出

### 8.1 画布选型

| 方案 | 优点 | 风险 | 当前建议 |
| --- | --- | --- | --- |
| DOM + SVG overlay | 文本/CSS 布局和 HTML 导出接近 | 大量节点、缩放性能待验证 | V1 首选验证 |
| Canvas/WebGL | 无限画布和大量节点性能好 | 文本、可访问性、导出一致性成本高 | 性能不足时采用 |
| Konva/Fabric | 交互能力成熟 | 容易泄漏库模型，布局仍需自建 | 仅作为适配器候选 |

技术验证覆盖 2,000 个可见节点、10,000 个总节点、中英文排版、20 层嵌套布局、画布—HTML—PNG 差异、旋转/阴影/裁切和高 DPI。

性能策略包括规范化 store、按 ID 订阅、视口裁剪、图层虚拟化、空间索引、文本与布局缓存，以及必要时使用 Worker。没有数据证明前不引入 CRDT 或复杂 ECS。

### 8.2 存储与恢复

```ts
interface ProjectRepository {
  open(projectId: ProjectId): Promise<ProjectSnapshot>;
  saveSnapshot(document: DesignDocument): Promise<void>;
  appendTransactions(entries: TransactionEntry[]): Promise<void>;
  putAsset(hash: string, bytes: Uint8Array, meta: AssetMetadata): Promise<void>;
  checkpoint(): Promise<void>;
  recover(projectId: ProjectId): Promise<ProjectSnapshot>;
}
```

- Web 使用 IndexedDB + OPFS。
- Tauri 使用 SQLite 保存元数据与事务、文件系统保存大资源。
- 项目交换格式采用 ZIP：manifest、document JSON、assets 和可选 history。
- 保存使用快照加事务日志；先写临时版本，再原子更新当前指针。
- 导入时校验 Schema、路径、大小、MIME 和压缩炸弹风险。
- API 密钥存入系统密钥链或等价安全存储，不进入项目文件。

### 8.3 导出

每种设计特性针对每个目标标注 `exact`、`approximated`、`rasterized` 或 `unsupported`。导出前返回诊断，禁止静默丢失效果。

交付顺序：HTML/CSS → PNG → 受限 SVG → V1.x React → PDF。React 导出前必须冻结组件映射、props、token、资源路径和目标运行时。

## 9. 实施路线

### Phase 0：审计与技术验证（2—3 周）

交付工具逐方法复用矩阵、Figma 能力替代清单、开源依赖与许可证清单、`DesignDocument v0`、核心命令、事务恢复原型、Moveable/Selecto 交互 spike、当前布局器/Yoga/浏览器三方布局 spike、DOM 与 Canvas 两类渲染 spike、Playwright 导出一致性 spike、三个基准页面和 ADR 初稿。

退出条件：关键 ADR 通过评审，布局、文本、画布、持久化和导出没有阻断性风险。

### Phase 1：文档核心与应用骨架（4—6 周）

交付项目管理、Schema 迁移、场景图、命令总线、历史、基础工作台、基于 Dexie 的 Web Repository、图层树拖放和自动保存。

退出条件：无需 Figma 和 AI，可以创建项目、编辑节点、撤销重做、关闭并恢复。

### Phase 2：人工设计闭环（6—10 周）

交付画布、图层树、属性面板、基础节点、Moveable/Selecto 交互适配器、自动布局、token、组件、lint，以及 HTML 与基于 Playwright 的 PNG 导出。

退出条件：可人工完成三个基准页面；重启后无数据丢失；导出通过视觉回归。

### Phase 3：AI 设计闭环（5—8 周）

交付基于 Vercel AI SDK 的 Provider 与流式 UI、上下文构建、命令工具、计划预览、局部修改、AI 历史、审查和成本控制。AI SDK 不承担领域事务、审批和回滚。

退出条件：AI 可生成结构化页面并只修改指定范围；失败不破坏文档；所有修改可整体撤销。

### Phase 4：交付与质量（4—8 周）

交付导出诊断、模板、资产管理、限定 React 导出、性能优化、无障碍检查和完整恢复测试。

退出条件：核心场景稳定，文档和导出格式有版本策略，支持矩阵公开明确。

### Phase 5：桌面化与兼容适配（按需求）

交付 Tauri、系统文件集成、密钥存储、离线模型、MCP 外部接入和可选 Figma 适配。

工期基于 3—5 人、熟悉 TypeScript 和编辑器架构的团队估算；Phase 0 后必须依据 spike 数据重新排期。

## 10. V1 验收标准

| 场景 | 可验证标准 |
| --- | --- |
| 独立运行 | 断开 Figma、relay 和 MCP 后，人工编辑、保存、恢复与导出仍可用。 |
| 文档完整性 | 所有提交通过引用和树结构校验，不产生孤儿节点或组件循环。 |
| 历史与恢复 | 已提交事务可撤销/重做；异常退出后恢复到最后确认事务。 |
| AI 页面生成 | 输出全部通过 Schema 与领域不变量校验。 |
| AI 局部修改 | 影响集合之外节点不变；revision 冲突不静默覆盖。 |
| 自动布局 | 基准页面在目标宽度下不溢出，fixed/fill/hug 符合定义。 |
| Token | 修改 token 后绑定节点更新，HTML 导出保留 CSS variable 语义。 |
| 组件 | 定义更新传播至实例，合法 override 保留，循环引用被拒绝。 |
| 性能 | 目标设备上 2,000 个可见节点达到团队冻结的帧率预算。 |
| 导出 | 三个基准页面 HTML 可运行；PNG 与画布差异低于冻结阈值。 |
| 迁移 | 至少两版测试 Schema 可连续迁移；失败不覆盖原文件。 |
| 可观测性 | AI 调用记录模型、耗时、用量、费用、命令和失败阶段。 |

## 11. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 低估 Figma 的隐式能力 | Phase 0 建立替代清单；严格限制 V1 节点和布局子集。 |
| 画布与导出不一致 | 共享布局结果；建立支持矩阵和视觉回归。 |
| 文本跨平台差异 | 固定字体资产、缓存测量并做目标平台基线测试。 |
| AI 大范围误改 | dry-run、影响集合、baseRevision、确认、原子事务和回滚。 |
| 过早拆包和抽象 | 初期少量包；API 经两个真实调用方验证后再抽取。 |
| React 导出承诺过宽 | 限定支持子集和目标运行时；对降级显式诊断。 |
| 浏览器存储受限 | 监测配额、使用 OPFS、提供项目备份，桌面版使用文件系统。 |
| 许可证与素材授权 | 生成 SBOM；记录来源、许可和 attribution；发布前审查。 |

## 12. 待冻结 ADR

| ADR | 决策主题 | 当前倾向 |
| --- | --- | --- |
| ADR-001 | 新仓库或当前 monorepo | 先在当前 monorepo 隔离验证，边界稳定后再决定拆仓。 |
| ADR-002 | 文档模型与 ID/引用 | 规范化记录、内部稳定 ID、外部引用隔离。 |
| ADR-003 | ChangeSet、事务与撤销 | 命令生成正向/反向变更，按 revision 原子提交。 |
| ADR-004 | 画布 renderer | 优先验证 DOM + SVG overlay，同时建立 Canvas 基线。 |
| ADR-005 | 布局与文本测量 | 不自研完整 CSS；通过 spike 决定浏览器或独立引擎。 |
| ADR-006 | Web/Tauri 持久化 | 统一 Repository 接口，多后端适配。 |
| ADR-007 | 组件与 override | 定义引用加显式 override，禁止循环。 |
| ADR-008 | AI 权限与冲突 | capability、影响集合、审批和 `baseRevision`。 |
| ADR-009 | 导出支持矩阵 | HTML/PNG 优先，React/PDF 后置。 |
| ADR-010 | Schema 编译器迁移 | 抽取生成机制，工具定义按新领域模型版本化。 |
| ADR-011 | 画布交互开源组件 | 优先验证 Moveable + Selecto；事件经适配器转为 preview 和领域命令。 |
| ADR-012 | Web 持久化实现 | Dexie 实现 IndexedDB Repository，大资产按基准决定是否接入 OPFS。 |
| ADR-013 | PNG/PDF 导出链路 | 优先复用 HTML/CSS 渲染结果，通过 Playwright 截图与生成 PDF。 |
| ADR-014 | AI Provider SDK | Vercel AI SDK 只负责 Provider、流式输出和工具协议，领域闭环保持自有。 |
| ADR-015 | Patch 与布局引擎评估 | 分别评估 Immer 和 Yoga，不在 spike 通过前替换现有 ChangeSet 与布局实现。 |

## 13. 下一步

下一轮只执行 Phase 0：

1. 选择一个真实 SaaS Dashboard 作为贯穿样例，冻结页面、组件、响应式和导出要求。
2. 将现有工具逐方法分为：直接抽象、语义迁移、Figma 专属、V1 暂缓。
3. 实现 `DesignDocument v0`、核心命令和领域不变量测试。
4. 用同一文档同时驱动画布预览和 HTML/PNG 输出。
5. 对比 DOM/SVG 与 Canvas 候选，不让 renderer 对象进入文档模型。
6. 从 Schema 编译器抽取最小闭环，为 `node.create`、`node.patch`、`node.delete` 和 `node.reparent` 生成校验、帮助和类型。
7. 用基准数据完成 ADR 评审，再冻结 V1 范围、团队配置和里程碑。
8. 完成首批第三方依赖的许可证、安全、包体积、维护状态与退出成本审查，并建立 `CanvasInteractionAdapter`、`IndexedDbProjectRepository`、`AiProvider` 和 `BrowserExportAdapter` 契约测试。

最终结论：Vibma 为新产品提供的是经过验证的工具契约、结构化设计规则和 Agent 交互经验，而不是现成的独立设计引擎。AI Design Studio 的核心资产必须是宿主无关的设计文档、命令事务、布局组件系统，以及人和 AI 共用的安全编辑闭环。
