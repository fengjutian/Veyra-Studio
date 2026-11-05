# AI Design Studio 独立化架构分析与实施建议

> 基于 Vibma 1.1.5 源码的初步审计结论  
> 文档状态：Draft v1.0  
> 日期：2026-11-05

## 1. 执行摘要

将 Vibma 发展为完全独立运行的 AI 设计应用是可行的，但这不是一次“给现有项目增加画布界面”的常规迭代，而是一次以 Vibma 为能力来源、以新设计文档模型为核心的产品重构。

建议采用以下总体策略：

1. 新建独立应用边界，保留现有 Vibma 作为 Figma 集成产品，不在原有三进程链路中强行加入独立画布。
2. 优先提取 Vibma 中与宿主无关的资产：Schema 编译器、工具契约、批处理语义、结构化告警、设计规范、颜色与可访问性工具。
3. 重建设计文档、场景图、命令事务、布局、组件、渲染与持久化能力。现有 Figma handler 只能作为行为参考，不能充当独立设计引擎。
4. 应用内部以领域命令总线为唯一写入口；AI、画布、属性面板、导入器都调用同一组命令。MCP 作为可选协议适配层，而不是应用内部运行的必要条件。
5. V1 聚焦“结构化网页与界面设计”，暂不承诺通用矢量编辑器、Figma 文件完整兼容、多人实时协作和任意 React 工程的高保真双向同步。

原始材料提出的产品方向基本成立，但对代码复用比例、渲染技术选型、数据模型、编辑事务和导出一致性的估计偏乐观。本方案将这些缺口收敛为可执行的架构边界和阶段验收条件。

## 2. 分析范围与证据

本次结论来自以下仓库事实：

- 当前仓库是 TypeScript monorepo，包含 `packages/core`、`packages/adapter-figma`、`packages/tunnel` 与 `schema`。
- 当前运行链路为：MCP Client → stdio MCP Server → WebSocket Relay → Figma Plugin。
- `packages/core/src` 约 5,669 行，负责 MCP 注册、访问级别、Schema 驱动的工具定义、外部素材服务和 WebSocket 命令转发。
- `packages/adapter-figma/src` 约 11,043 行；扫描到的 29 个源码文件均直接使用 `figma` 全局对象或 Figma 节点类型。
- `packages/tunnel/src` 约 337 行，仅负责一对一角色通道、心跳和消息转发。
- `schema/compiler` 约 2,403 行，`schema/tools` 约 2,468 行；YAML 可生成 Zod Schema、工具描述、帮助、参数 guard、响应类型和站点文档。
- 当前共有 18 个工具 Schema，覆盖 document、frames、text、components、instances、styles、variables、lint、selection、prototyping 等资源。
- `packages/core` 中仍有 14 个文件出现 Figma 语义，尤其是 WebSocket 连接、Figma REST library、提示词和生成工具定义，因此不能直接整体命名为“通用设计核心”。

本次是面向架构决策的初步源码审计，不等同于逐函数迁移清单。进入实施前仍需补充：第三方依赖许可证清单、工具级复用矩阵、关键 handler 行为测试和性能基线。

## 3. 对原始建议的评估

### 3.1 应保留的判断

- 产品应定位为 AI 与人共同编辑结构化设计工程，而不是图片生成工具。
- 设计数据模型必须独立于画布实现，不能保存 Konva、Fabric 或浏览器 DOM 的内部对象。
- 不应立即删除 Figma 代码，应先识别通用语义，再将 Figma 保留为独立适配器。
- 应先建设可人工操作的编辑器，再让 AI 通过受控工具修改同一份文档。
- 本地优先、可撤销、可恢复和可交付是产品成立的基础能力。
- Web 优先、后续使用 Tauri 桌面封装是合理路径。

### 3.2 需要修正的判断

| 原建议 | 修正意见 |
| --- | --- |
| 将 `packages/core` 改造成 AI 工具引擎 | 不应原地改造。该包同时承担 MCP 协议、Figma 连接、外部资源与生成代码。应拆出 host-neutral 的 `tool-contracts` 和 `design-guidelines`，再新建设计运行时。 |
| “拆除 Figma 强依赖”即可得到设计引擎 | 不成立。Figma 当前提供了节点存储、布局、字体、渲染、组件、变量、选择、导出、历史等大量隐式运行时能力。这些都需要重新实现。 |
| 使用 Konva 或 Fabric.js 作为画布 | 选型过早。V1 以 UI/网页设计为目标时，DOM/SVG 更容易复用浏览器排版与导出语义；无限画布交互可单独实现。应先做技术验证再冻结。 |
| SQLite + 文件系统 | Web 首发无法直接使用 SQLite。应定义统一 `ProjectRepository`，Web 使用 IndexedDB/OPFS，Tauri 使用 SQLite/文件系统。 |
| MCP + Tool Registry 作为内部工具调用 | 内部应直接调用类型安全的命令服务，避免进程协议成为核心依赖。MCP 只为外部 Agent 暴露同一命令集。 |
| V1 同时导出 HTML、React、SVG、PNG、PDF | 范围过大。先保证 HTML/CSS 与 PNG/SVG；React 导出需要单独定义组件映射和支持矩阵，PDF 可通过浏览器打印链路后置。 |
| 初期拆成十余个 npm 包 | 容易形成空壳包和跨包摩擦。先按边界组织少量包，待 API 稳定后再细分。 |

### 3.3 原始材料缺少的关键能力

- 文档版本迁移与前向兼容。
- 命令、事务、补丁和撤销/重做模型。
- AI 修改的并发与冲突处理。
- 画布渲染与导出渲染的一致性策略。
- 字体加载、文本测量和跨平台排版差异。
- 组件定义、实例、覆盖和循环引用规则。
- 资源内容寻址、去重、缺失和垃圾回收。
- 自动保存、崩溃恢复和原子写入。
- 大文档的增量派生、空间索引与性能预算。
- AI 权限、成本预算、网络数据边界和密钥存储。

## 4. 产品边界

### 4.1 产品定位

AI Design Studio 是一个本地优先、AI 原生的结构化界面设计环境。用户和 AI 操作同一份可编辑、可验证、可版本化、可导出的设计文档。

核心价值不是“生成一张好看的图”，而是生成并维护：

- 有层级的节点树；
- 可解释的布局规则；
- 可复用的设计 token；
- 可实例化的组件；
- 可撤销的编辑历史；
- 可继续人工编辑的设计结果；
- 可运行或可渲染的交付物。

### 4.2 V1 目标用户

- 需要快速完成 Web 产品界面的产品设计师；
- 需要从需求生成结构化原型的产品经理；
- 需要将视觉稿交付为 HTML/CSS 或前端骨架的开发者；
- 希望让本地或云端 Agent 安全操作设计工程的高级用户。

### 4.3 V1 范围

V1 必须支持：

- 本地创建、打开、保存和恢复项目；
- 页面、Frame、文本、图片、基础图形和容器节点；
- 图层树、选择、移动、缩放、复制、删除、重排与属性编辑；
- 纵向/横向自动布局、间距、内边距、对齐、固定/填充/内容自适应尺寸；
- 颜色、字体、间距、圆角 token；
- 组件定义、实例与有限的实例覆盖；
- 统一命令历史、撤销与重做；
- AI 新建页面、局部修改、结构审查和修复建议；
- 修改预览、影响范围、确认提交与回滚；
- HTML/CSS 和 PNG/SVG 导出；
- 项目 JSON 的导入、导出与 Schema 迁移。

### 4.4 V1 明确不做

- Figma 文件格式的完整读写兼容；
- 钢笔工具、复杂布尔路径与专业插画能力；
- 多人实时协作和 CRDT；
- 任意 React 项目的无损双向同步；
- 完整原型动画和交互状态机；
- 插件市场；
- 移动端原生编辑器；
- 训练自有基础模型。

## 5. 现有 Vibma 的复用决策

### 5.1 复用矩阵

| 现有资产 | 决策 | 原因与处理方式 |
| --- | --- | --- |
| `schema/tools/*.yaml` | 抽象后复用 | 工具语义有价值，但当前字段和 Figma 节点语义混合。复制到新版本命名空间，按独立文档模型改写。 |
| `schema/compiler` | 高优先级复用 | 单一事实源、Schema/帮助/guard/文档生成是成熟资产。先消除硬编码 shared types 和 Figma 文案。 |
| endpoint CRUD 契约 | 复用思想 | `create/get/list/update/delete` 和最小响应适合 AI 工具；内部命令不必被 CRUD 限制。 |
| `batchHandler` 语义 | 重新实现 | 项目级批处理、逐项错误、警告提升、进度上报值得保留；实现应从 Figma adapter 移入通用命令层。 |
| 结构化 warnings 与 lint | 高优先级迁移 | 这是 Vibma 的差异化能力。规则需面向新文档模型重写。 |
| guidelines/prompts | 复用并改写 | token、响应式、组件结构等内容可继续使用，移除 Figma 专属步骤。 |
| color、WCAG、coercion 工具 | 直接或小幅复用 | 宿主无关，应迁入共享 utility 包并补测试。 |
| Iconify、Pexels 集成 | 适配后复用 | 保留为资产提供器，不应放在设计核心中；增加缓存、许可和 attribution 元数据。 |
| `packages/core/src/mcp.ts` | 不直接复用 | 其生命周期围绕 stdio 和 Figma WebSocket。未来仅参考其 MCP adapter 与 capability gate。 |
| `packages/adapter-figma` handlers | 行为参考 | 直接依赖 Figma 节点、样式、变量、字体和导出 API。用于提炼测试用例与领域行为，不移入新核心。 |
| `packages/tunnel` | 独立产品主链路中移除 | 单进程 Web/Tauri 不需要 relay；如保留 Figma 适配器，可继续作为兼容链路。 |
| Figma REST library | 隔离保留 | 仅属于 Figma adapter/importer，不进入通用 library 模块。 |
| response types/docs | 迁移生成机制 | 保留 Schema 派生方式，响应模型改为新命令与查询模型。 |

### 5.2 必须避免的迁移方式

- 不用自建对象伪装 Figma `SceneNode`，这会把 Figma API 的偶然细节永久固化进新引擎。
- 不把 `allFigmaHandlers` 简单改名为 `allDesignHandlers`；handler 内部行为必须下沉到领域服务和命令。
- 不让 React/Zustand store 成为设计文档的唯一事实源。
- 不让渲染器对象反向承载持久化数据。
- 不在新 Schema 中继续使用无法迁移的 Figma ID、plugin data 或远程 library key 作为主标识。

## 6. 目标架构

```text
┌──────────────────────────────── Application Shell ────────────────────────────────┐
│ Workspace │ Layers │ Canvas │ Inspector │ Assets │ AI Chat │ History │ Export     │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ intents / queries
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│ Application Services                                                            │
│ Command Bus │ Query Service │ Transaction Manager │ Undo/Redo │ Selection/Viewport│
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ validated domain commands
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│ Design Runtime                                                                  │
│ Document │ Scene Graph │ Layout │ Components │ Tokens │ Assets │ Lint │ Migration │
└──────────────┬──────────────────────┬──────────────────────┬───────────────────────┘
               │                      │                      │
       ┌───────▼────────┐     ┌───────▼────────┐     ┌──────▼────────────────┐
       │ Render Adapters │     │ Persistence    │     │ Integration Adapters │
       │ Canvas / Export │     │ Web / Desktop  │     │ AI / MCP / Figma     │
       └─────────────────┘     └────────────────┘     └───────────────────────┘
```

### 6.1 依赖规则

1. `design-runtime` 不依赖 React、Zustand、Konva/Fabric、Tauri、MCP SDK 或 Figma 类型。
2. UI 只能通过应用服务读取快照和提交命令，不能直接修改领域对象。
3. AI 与人工操作使用相同命令和验证器，不存在“AI 专用后门”。
4. 持久化只保存规范化文档与必要历史，不保存渲染器运行时对象。
5. 渲染器消费派生后的布局结果，不拥有节点身份和业务状态。
6. 导出器消费同一设计文档，但可使用独立渲染目标；任何不支持特性必须产生显式诊断。
7. MCP、Figma 和未来插件均为适配器，可移除而不影响应用核心。

### 6.2 推荐的初期工程结构

```text
apps/
  studio-web/             # React 工作台与 Web 运行壳
  studio-desktop/         # Tauri 壳，Phase 5 再启用
packages/
  design-schema/          # 文档类型、Zod Schema、迁移器、序列化
  design-runtime/         # 场景图、命令、事务、布局、组件、token、lint
  design-renderer/        # 交互画布、预览与导出渲染适配
  ai-orchestrator/        # Provider、上下文、规划、工具执行和审批
  tool-contracts/         # 从 Vibma Schema 编译器演进而来
  integrations/           # MCP、Figma、Iconify、Pexels 等适配器
  shared/                 # color、WCAG、通用 utility
schema/
  tools/                  # 新设计运行时工具定义
docs/
```

初期保持 6—7 个有真实职责的包即可，不为每个概念提前创建独立包。

## 7. 设计文档模型

原始材料中的 `DesignNode.style: Record<string, unknown>` 只能用于概念演示，不能作为工程契约。建议使用版本化、可判别、可引用且可迁移的模型。

```ts
interface DesignDocument {
  schemaVersion: number;
  id: DocumentId;
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
  type: string;
  name: string;
  parentId: NodeId | PageId;
  childIds: NodeId[];
  visible: boolean;
  locked: boolean;
  layout: LayoutSpec;
  appearance: AppearanceSpec;
  bindings?: PropertyBindings;
}
```

### 7.1 模型原则

- 节点采用扁平记录加 `parentId/childIds`，避免深树整体复制，便于索引、局部补丁和引用完整性校验。
- 节点类型使用判别联合，不使用任意 `style` 字典承载全部属性。
- token 绑定与计算后的实际值分开保存；修改 token 后可追踪受影响节点。
- 布局输入与布局结果分离。持久化约束，布局结果是可重算缓存。
- 组件实例保存定义引用和显式 override，不复制整棵定义树作为事实源。
- 资源通过稳定 `AssetId` 引用，二进制内容使用内容哈希去重。
- 每个文件携带 `schemaVersion`；迁移必须是连续、可测试且不可跳过的纯函数。
- 任何外部来源 ID 只能进入 `externalRefs`，不能替代内部稳定 ID。

### 7.2 布局模型

V1 建议支持三种布局模式：

- `absolute`：自由定位，适用于画布级组合和装饰元素；
- `stack`：横向或纵向自动布局，对应常见 Flexbox 子集；
- `grid`：后置到 V1.x，除非目标模板明确需要。

尺寸策略至少包括 `fixed`、`fill`、`hug`，并定义 min/max、padding、gap、alignment、wrap 和 absolute child。布局引擎输出 `ComputedBox`，渲染器和命中测试都消费这一结果。

不建议在首版自研完整 CSS 布局算法。可以用浏览器布局作为验证基线，或评估 Yoga 等独立布局引擎；选型必须通过文本测量、嵌套自适应、跨平台一致性和导出一致性验证。

### 7.3 组件模型

组件至少区分：

- 定义：拥有结构、可暴露属性和 slot；
- 实例：引用定义并记录 overrides；
- 可覆盖属性：文本、布尔显隐、图片、token、实例替换；
- 不可覆盖结构：默认不允许实例任意改写定义树；
- detach：将解析后的实例物化为普通节点，形成新的身份。

必须禁止组件直接或间接循环引用，并在删除定义、移动节点、更新 slot 时执行引用完整性校验。

## 8. 命令、事务与历史

这是独立应用区别于“JSON 编辑器”的关键层。

### 8.1 统一命令模型

```ts
type DesignCommand =
  | { type: "node.create"; payload: CreateNodeInput }
  | { type: "node.patch"; payload: PatchNodeInput }
  | { type: "node.delete"; payload: DeleteNodeInput }
  | { type: "node.reparent"; payload: ReparentNodeInput }
  | { type: "token.upsert"; payload: UpsertTokenInput }
  | { type: "component.instantiate"; payload: InstantiateInput };

interface CommandResult {
  revision: number;
  changes: ChangeSet;
  inverse: ChangeSet;
  warnings: DesignWarning[];
}
```

命令执行顺序固定为：输入 Schema 校验 → 权限/能力校验 → 引用和领域约束校验 → 计算变更集 → 原子提交 → 计算告警 → 持久化日志 → 通知派生视图。

### 8.2 事务边界

- 一次拖拽过程只在 pointer up 时提交一个历史事务，中间状态作为 UI preview。
- 属性面板的连续输入合并为一个可撤销事务。
- AI 的一次用户确认对应一个事务，可包含多个命令。
- 批处理默认原子提交；若产品需要部分成功，必须在工具契约中显式声明，而不能沿用现有 handler 的隐式逐项容错。
- 所有提交基于 `baseRevision`。若文档已变化，先重新规划或产生冲突，不静默覆盖。

### 8.3 AI 修改协议

AI 不直接输出完整文档，而输出受 Schema 约束的命令计划：

1. 读取与任务相关的最小上下文；
2. 生成目标、假设、命令列表和预期影响节点；
3. 在文档分支上 dry-run；
4. 返回视觉预览、结构 diff、告警和导出影响；
5. 用户确认后基于原 `baseRevision` 原子提交；
6. 若 revision 变化，则要求重新计算计划；
7. 整个事务可一次撤销。

低风险、可逆操作可以由用户配置为自动提交；删除大量节点、重建组件、覆盖 token 或调用网络服务必须进入确认流程。

## 9. 渲染与画布策略

### 9.1 技术决策建议

在冻结 Konva 或 Fabric.js 前，先实现 2—3 周的技术验证。候选方案：

| 方案 | 优点 | 风险 | 建议 |
| --- | --- | --- | --- |
| DOM + SVG overlay | 文本/CSS 布局与 HTML 导出接近，开发快 | 大量节点和任意缩放下性能需验证 | V1 首选验证 |
| Canvas/WebGL | 无限画布和大量节点性能较好 | 文本、可访问性、导出一致性成本高 | 性能不足时采用 |
| Konva/Fabric | 交互能力成熟 | 容易把库模型泄漏到领域层，复杂布局仍需自建 | 仅作为 renderer adapter 候选 |

### 9.2 必须通过的技术验证

- 2,000 个可见节点下，平移缩放保持目标帧率；
- 10,000 个总节点下，选择和图层操作无明显阻塞；
- 中英文混排、字体回退、行高和自动宽高稳定；
- 嵌套 20 层自动布局可增量重算；
- 画布预览与 HTML/PNG 导出的关键页面视觉差异可接受；
- 旋转、阴影、圆角、图片裁切和透明度行为一致；
- 高 DPI、缩放和截图输出稳定。

### 9.3 性能架构

- 规范化 store，按节点 ID 订阅，避免文档整体触发 React 重渲染；
- 视口裁剪与图层虚拟化；
- 使用 R-tree 或等价空间索引做命中测试和框选；
- 布局结果、文本测量和渲染资源缓存；
- 大批量命令放入 Worker 评估，主线程只提交结果；
- 在性能数据证明需要前，不引入 CRDT 或复杂 ECS。

## 10. AI 架构

### 10.1 分层

- `Provider`：统一模型调用、流式输出、工具调用、取消、重试和用量统计；
- `Context Builder`：根据选择、页面、组件和 token 构建最小上下文；
- `Planner`：把自然语言转为可审查的设计意图与命令计划；
- `Executor`：dry-run、权限检查、事务提交和回滚；
- `Reviewer`：运行确定性 lint、视觉规则和可选多模态检查；
- `Policy`：网络访问、密钥、成本、危险操作与自动确认规则。

不建议一开始实现多个自治 Agent。页面规划、布局、组件和审查可以先作为一个编排器中的阶段或工具；只有在评测证明独立上下文能显著改善结果时再拆分 Agent。

### 10.2 确定性能力优先

以下任务不应依赖 LLM 猜测：

- ID、引用与树结构校验；
- 自动布局计算；
- token 查找与绑定；
- 对比度计算；
- 命名、硬编码颜色、缺失自动布局等 lint；
- 变更影响范围；
- 命令反向补丁；
- 导出支持性检查。

LLM 负责意图理解、方案生成、内容创作和审美判断；设计引擎负责正确性。

### 10.3 MCP 的正确位置

新产品可以继续提供 MCP Server，但其职责是把外部 Agent 调用映射到应用命令：

```text
External Agent → MCP Adapter → Command Bus → Design Runtime
Studio AI Chat ───────────────→ Command Bus → Design Runtime
Inspector / Canvas ───────────→ Command Bus → Design Runtime
```

这样可保留 Vibma 的生态优势，同时保证无 MCP、无外部 Agent 时应用仍能完整工作。

## 11. 存储、恢复与安全

### 11.1 存储抽象

定义统一 `ProjectRepository`：

- `open(projectId)`；
- `saveSnapshot(document, revision)`；
- `appendTransactions(entries)`；
- `putAsset(hash, bytes, metadata)`；
- `checkpoint()`；
- `recover()`。

Web 适配器使用 IndexedDB + OPFS；桌面适配器使用 SQLite 保存元数据与事务、文件系统保存大资源。项目导出包可采用 ZIP 容器：manifest、document JSON、assets、可选 history。

### 11.2 数据可靠性

- 原子保存：先写临时版本，再更新当前指针；
- 自动保存：事务日志持续写入，定期生成快照；
- 崩溃恢复：从最近快照重放已校验事务；
- 内容哈希：资源去重并检测损坏；
- 导入前验证 Schema、大小、路径和压缩炸弹风险；
- 迁移前保留原文件副本，失败不覆盖。

### 11.3 AI 安全边界

- API 密钥使用系统密钥链或等价安全存储，不写入项目文件；
- 默认只向模型发送任务相关节点，不上传整个项目；
- 清楚显示使用的模型、发送范围、费用和网络状态；
- 对外部 URL、图片和 SVG 做协议、大小、MIME 与脚本过滤；
- 导出的 HTML 默认不执行项目内未知脚本；
- MCP 保留 read/create/edit 能力级别，并增加 project scope。

## 12. 导出策略

### 12.1 支持矩阵先于代码生成

每种设计特性必须标注不同目标的支持状态：`exact`、`approximated`、`rasterized`、`unsupported`。导出前返回诊断，而不是静默丢失效果。

### 12.2 V1 导出顺序

1. HTML/CSS：作为结构化交付和渲染一致性基线；
2. PNG：通过稳定的 headless browser 或渲染快照生成；
3. SVG：仅对支持的矢量/文本子集承诺结构化输出；
4. React：V1.x 再提供，先限定目标运行时和组件映射；
5. PDF：通过页面编排与打印管线提供，避免把任意无限画布直接等同于 PDF 页面。

React 导出不应只是把 HTML 改成 JSX。必须先定义组件边界、props、token 输出、资源路径、响应式规则和代码格式，否则“可编译”不等于“可维护”。

## 13. 分阶段实施计划

### Phase 0：审计与架构验证（2—3 周）

交付物：

- 工具级复用矩阵；
- Figma API 能力替代清单；
- 第三方依赖与许可证清单；
- 设计文档 Schema v0；
- 命令/事务原型；
- 画布技术 spike；
- HTML 导出一致性 spike；
- 3 个基准设计样例和性能数据。

退出条件：关键 ADR 通过评审，画布、布局、文本和导出不存在阻断性风险。

### Phase 1：文档核心与应用骨架（4—6 周）

交付物：项目管理、文档加载保存、Schema 迁移、场景图、命令总线、历史、基础工作台和自动保存。

退出条件：无需 Figma 和 AI，可以创建项目、编辑节点、撤销重做、关闭并恢复。

### Phase 2：可用的人工设计器（6—10 周）

交付物：无限画布、图层树、属性面板、文本/图片/形状、自动布局、token、基础组件、lint 和 PNG/HTML 导出。

退出条件：可人工完成三个基准页面；重启后无数据丢失；导出结果通过视觉回归。

### Phase 3：AI 设计闭环（5—8 周）

交付物：Provider、上下文构建、命令工具、计划预览、局部修改、AI 历史、结构审查与成本控制。

退出条件：AI 能从需求生成结构化页面，能只修改指定范围，失败不破坏文档，所有操作可撤销。

### Phase 4：交付与质量（4—8 周）

交付物：导出诊断、模板、资产管理、React 限定导出、性能优化、无障碍检查和完整恢复测试。

退出条件：核心验收场景稳定，支持矩阵明确，项目和导出格式有版本策略。

### Phase 5：桌面化与兼容适配（按需求）

交付物：Tauri、系统文件集成、安全密钥存储、离线模型、MCP 外部接入和可选 Figma 导入/导出适配。

上述工期是假设 3—5 人熟悉 TypeScript/编辑器架构的小团队估算，必须在 Phase 0 后依据 spike 数据重新评估。

## 14. V1 验收标准

| 场景 | 可验证标准 |
| --- | --- |
| 本地独立运行 | 断开 Figma、relay 和 MCP 后，人工编辑、保存、恢复与导出仍完整可用。 |
| 文档可靠性 | 任意已提交事务可撤销/重做；模拟异常退出后恢复到最后已确认事务。 |
| AI 页面生成 | 输出全部通过 Schema 和引用校验，不产生孤儿节点或循环树。 |
| AI 局部修改 | 未在计划影响集合内的节点保持不变；revision 冲突不静默覆盖。 |
| 自动布局 | 基准样例在常见宽度下不溢出，hug/fill/fixed 结果符合规范。 |
| 设计 token | 修改 token 后所有绑定节点更新；导出保留 CSS variable 语义。 |
| 组件 | 定义更新可传播至实例，合法 override 保留，循环引用被拒绝。 |
| 性能 | 目标设备上 2,000 个可见节点平移缩放达到团队设定帧率预算。 |
| 导出 | 三个基准页面的 HTML 可运行；PNG 与画布预览通过像素差阈值。 |
| 可观测性 | 每次 AI 调用记录模型、耗时、token/费用、工具命令与失败阶段。 |
| 迁移 | 至少两版测试 Schema 可连续迁移；失败时原文件保持不变。 |

## 15. 主要风险与缓解措施

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 低估 Figma 提供的隐式能力 | 工期大幅扩张 | Phase 0 建立能力替代清单；严格限制 V1 节点和布局子集。 |
| 画布与导出不一致 | 用户无法信任交付结果 | 同一布局结果、多目标渲染；建立视觉回归和支持矩阵。 |
| 文本排版跨平台差异 | 页面错位、截图差异 | 固定字体资产、缓存测量、目标平台基准测试。 |
| AI 大范围误改 | 数据损坏、用户不信任 | dry-run、revision、影响集合、确认、原子事务和一键回滚。 |
| 过早拆包与抽象 | 开发速度下降 | 初期少量包，API 经两处真实调用后再抽象。 |
| React 导出承诺过宽 | 输出不可维护 | 限定支持子集、目标运行时和组件映射，显式诊断降级。 |
| 浏览器本地存储限制 | 大项目失败 | 存储配额监测、OPFS、项目导出备份，桌面版使用文件系统。 |
| 许可证与素材授权 | 商业发布风险 | 自动生成 SBOM；保存素材来源、许可和 attribution；发布前法律审查。 |

## 16. 需要冻结的架构决策（ADR）

进入大规模开发前至少完成：

1. ADR-001：新仓库还是 monorepo 内新应用。建议先在当前 monorepo 建隔离包验证，产品边界稳定后再决定拆仓。
2. ADR-002：规范化文档模型与 ID/引用策略。
3. ADR-003：命令、ChangeSet、事务和撤销模型。
4. ADR-004：DOM/SVG、Canvas 或混合渲染器。
5. ADR-005：布局引擎与文本测量策略。
6. ADR-006：Web 与 Tauri 的统一持久化接口。
7. ADR-007：组件实例和 override 语义。
8. ADR-008：AI 审批、revision 冲突和能力权限。
9. ADR-009：HTML/React 导出支持矩阵。
10. ADR-010：Vibma Schema 编译器的抽取和版本兼容策略。

## 17. 建议的下一步

不要立即搭建完整工作台。下一轮应只完成 Phase 0，并按以下顺序推进：

1. 选择一个真实的 SaaS Dashboard 作为贯穿样例，固定页面、组件、响应式和导出要求。
2. 把现有 18 个工具按“可直接抽象、语义可迁移、Figma 专属、V1 暂缓”逐方法分类。
3. 写出 `DesignDocument v0`、10—15 个核心命令和不变量测试。
4. 同时验证 DOM/SVG 与一个 Canvas 方案，不将任何渲染器对象写入文档。
5. 用同一文档生成画布预览和 HTML，测量视觉差异、文本差异和性能。
6. 抽取 Schema 编译器最小闭环，为 `node.create`、`node.patch`、`node.delete`、`node.reparent` 生成验证、帮助和文档。
7. 形成 Phase 0 审计报告后再冻结 V1 范围、团队配置与里程碑。

最终判断：Vibma 可以成为独立 AI 设计应用的重要技术基础，但“基础”主要指其工具契约、结构化设计规则和 Agent 交互经验，而不是现成的设计引擎。新产品的真正核心资产将是宿主无关的设计文档、命令事务、布局组件系统，以及人和 AI 共用的安全编辑闭环。
