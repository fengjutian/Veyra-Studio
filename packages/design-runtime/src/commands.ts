import type {
  AssetMetadata,
  ComponentDefinition,
  ComponentProperty,
  ComponentPropertyField,
  ComponentSetDefinition,
  BooleanOperation,
  ComponentSetId,
  DesignDocument,
  DesignNode,
  DesignPage,
  DocumentFont,
  FontStyle,
  ImageNode,
  InstanceNode,
  Interaction,
  LayoutSpec,
  ListType,
  NodeId,
  PageId,
  TextPatch,
  TokenValue,
  VectorGeometry,
} from "@ufira/design-schema";

export interface CreateNodeCommand {
  type: "node.create";
  payload: { node: DesignNode; index?: number };
}

export interface RenameDocumentCommand {
  type: "document.rename";
  payload: { name: string };
}

export interface RestoreHistoryCommand {
  type: "history.restore";
  payload: { document: DesignDocument };
}

export interface PatchNodeCommand {
  type: "node.patch";
  payload: {
    id: NodeId;
    patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "bindings" | "slot" | "mask" | "constraints">>;
  };
}

/**
 * 往组件实例的插槽里填充内容。
 *
 * 模板是一棵"从别处复制过来的节点树"，运行时会给它重新分配 id 并挂到插槽下面；
 * 重复填充会先清空插槽旧内容，所以调用方不需要自己删除。
 */
export interface FillSlotCommand {
  type: "slot.fill";
  payload: {
    instanceId: NodeId;
    slotNodeId: NodeId;
    template: { roots: NodeId[]; nodes: Record<NodeId, DesignNode> };
  };
}
export interface PatchTextCommand {
  type: "text.patch";
  payload: {
    id: NodeId;
    patch: TextPatch;
  };
}

/**
 * 改文本节点的段落样式（列表类型 / 列表缩进级别）。
 *
 * 单独开一条命令而不是塞进 `TextPatch`：`TextPatch` 是「节点级字段」的整体替换，
 * 而段落样式是**带区间语义**的结构（区间必须对齐段落边界），两者的失效方式不同。
 *
 * `from` / `to` 是 UTF-16 下标（与 `runs` 同口径），命令会把区间吸附到段落边界：
 * 给到段落中间时，整段都受影响——与 Figma 一致。
 *
 * `style` 是增量：没写的字段沿用该段自己的原值；
 * `listType: "none"` 表示取消列表（缩进级别同时归零）；
 * `indentDelta` 是相对缩进（每一段按自己的级别加减），对应 Tab / Shift+Tab；
 * `paragraphIndent` 是段落整体右推的像素数（只对左对齐生效）；
 * `hanging` 让列表标记悬在文本框外（标记不再占正文宽度）；
 * `listSpacing` 是这一段之后的额外垂直间距。
 */
export interface SetParagraphStyleCommand {
  type: "text.paragraph.set";
  payload: {
    id: NodeId;
    from: number;
    to: number;
    style: {
      listType?: ListType | "none";
      indent?: number;
      indentDelta?: number;
      paragraphIndent?: number;
      hanging?: boolean;
      listSpacing?: number;
    };
  };
}

export interface DeleteNodeCommand {
  type: "node.delete";
  payload: { id: NodeId };
}

export interface ReparentNodeCommand {
  type: "node.reparent";
  payload: { id: NodeId; parentId: NodeId | PageId; index?: number };
}

/** 图片资源的显示方式。 */
export type ImageFit = ImageNode["fit"];

/**
 * 登记一份图片资源的元数据。
 *
 * 资源字节本身存在仓库里（按 SHA-256 去重），文档只保存元数据。图片节点必须
 * 先有对应的资源记录，`validateDocument()` 才不会判定它引用了不存在的资源，
 * 因此导入图片时这条命令和 `node.create` 必须落在同一个事务里。
 */
export interface UpsertAssetCommand {
  type: "asset.upsert";
  payload: { asset: AssetMetadata };
}

/**
 * 改图片节点的显示内容或显示方式。
 *
 * 和 `text.patch` 一样单独开一条命令，而不是扩张通用的 `node.patch`：`fit` 和
 * `assetId` 只对图片有意义，混进通用 patch 会让其他节点也能收到这些字段。
 * 换图（`assetId`）要求新资源已经在同一个事务里登记过。
 */
export interface PatchImageCommand {
  type: "image.patch";
  payload: { id: NodeId; patch: { fit?: ImageFit; assetId?: string } };
}

/**
 * 改矢量节点的路径几何。
 *
 * 和 `text.patch` / `image.patch` 一样单独开一条命令，而不是扩张通用的 `node.patch`：
 * `geometry` 只对矢量节点有意义。而且改锚点会改变整条路径的包围盒，所以这条命令
 * 允许**同时**带上新的 `layout`——「几何变了、盒子必须跟着变」是这条命令的语义的一部分，
 * 拆成两条命令会让文档在两条命令之间处于「盒子不含图形」的非法中间态。
 *
 * 路径坐标是归一化的（在曲线上的点落在 [0,1]），因此调用方必须先算好新盒子再归一化；
 * 运行时用 `isValidVectorPath` 兜底，写进来的路径一定可渲染。
 */
export interface PatchVectorCommand {
  type: "vector.patch";
  payload: { id: NodeId; patch: { geometry: VectorGeometry; layout?: LayoutSpec } };
}

/**
 * 删除一份图片资源的元数据。
 *
 * 只允许删除没有被任何图片节点引用的资源：删掉正在被引用的元数据会让文档
 * 立刻不合法（节点指向一个不存在的资源）。字节的清理由仓库负责。
 */
export interface DeleteAssetCommand {
  type: "asset.delete";
  payload: { id: string };
}

export interface UpsertTokenCommand {
  type: "token.upsert";
  payload: { name: string; token: TokenValue };
}

export interface DeleteTokenCommand {
  type: "token.delete";
  payload: { name: string };
}

export interface CreatePageCommand {
  type: "page.create";
  payload: { page: DesignPage; index?: number };
}

export interface RenamePageCommand {
  type: "page.rename";
  payload: { id: PageId; name: string };
}

export interface DeletePageCommand {
  type: "page.delete";
  payload: { id: PageId };
}

export interface DefineComponentCommand {
  type: "component.define";
  payload: { component: ComponentDefinition };
}

export interface CreateComponentCommand {
  type: "component.create";
  payload: { id: string; nodeId: NodeId; name: string };
}

/**
 * 注册一个变体集。
 *
 * 只声明属性名；成员靠 `components[*].variantSetId` 反查，所以这里不需要成员列表。
 */
export interface CreateComponentSetCommand {
  type: "component.setCreate";
  payload: { set: ComponentSetDefinition };
}

/** 把已有组件登记为变体集成员，并写入它当前的变体取值。 */
export interface AssignComponentVariantCommand {
  type: "component.setVariant";
  payload: { id: string; variantSetId: ComponentSetId; variant: Record<string, string> };
}

/**
 * 从现有组件复制出一个新变体。
 *
 * 复制发生在命令里而不是 UI：新组件的根子树必须有唯一 id，交给运行时统一生成
 * `${新组件 id}--${源节点 id}`，与实例物化的命名规则一致，也便于回查来源。
 */
export interface CreateComponentVariantCommand {
  type: "component.createVariant";
  payload: { sourceComponentId: string; componentId: string; name: string; values: Record<string, string> };
}

/**
 * 把实例切换到同一变体集里的另一个组件。
 *
 * 实例子树会按新组件重新物化；覆盖按源节点 id 保留能对上的部分（v1 限制）。
 */
export interface SwitchComponentVariantCommand {
  type: "component.switchVariant";
  payload: { id: NodeId; componentId: string };
}

/**
 * 登记字体声明。
 *
 * `assetId` 指向已上传的字体文件；缺省表示依赖系统字体（导入的文档常常如此）。
 * 同族名 + 字重 + 字形视为同一条记录，再次登记即替换。
 */
export interface RegisterFontCommand {
  type: "font.register";
  payload: { font: DocumentFont };
}

/** 把若干同级形状合成布尔组：子节点是操作数（第一个为基准层）。 */
export interface CreateBooleanCommand {
  type: "boolean.create";
  payload: { id: string; name?: string; operation: BooleanOperation; nodeIds: NodeId[] };
}

/** 切换布尔组的运算类型；几何在读取时重算，因此不需要重新烘焙。 */
export interface SetBooleanOperationCommand {
  type: "boolean.setOperation";
  payload: { id: NodeId; operation: BooleanOperation };
}

/** 解除布尔组：操作数回到原父级，坐标保持不变，布尔节点删除。 */
export interface ReleaseBooleanCommand {
  type: "boolean.release";
  payload: { id: NodeId };
}

/** 删除字体声明；还有文本节点在用这个族名时拒绝。 */
export interface RemoveFontCommand {
  type: "font.remove";
  payload: { family: string; weight?: number; style?: FontStyle };
}

export interface RemoveComponentCommand {
  type: "component.remove";
  payload: { id: string };
}

/**
 * 把组件实例脱离成普通 frame。
 *
 * 实例的子树本来就是真实节点，脱离只是去掉"这是某个组件的实例"这层身份：
 * 类型改为 frame，清掉 componentId 与 overrides，组件定义本身保留。
 */
export interface DetachComponentCommand {
  type: "component.detach";
  payload: { id: NodeId };
}
/**
 * 给实例里的某个物化节点写入覆盖值。
 *
 * 覆盖同时做两件事：改实例自己的副本（立刻可见），并把补丁记进
 * `instance.overrides[sourceNodeId]`（语义上属于这个实例，导出和后续读取都看它）。
 */
export interface ComponentOverrideCommand {
  type: "component.override";
  payload: {
    instanceId: NodeId;
    sourceNodeId: NodeId;
    patch: { text?: string; name?: string; visible?: boolean; appearance?: { fill?: string; stroke?: string; opacity?: number; cornerRadius?: number } };
  };
}

/**
 * 清除某个节点的覆盖，把实例副本恢复成组件定义里的样子。
 */
export interface ResetComponentOverrideCommand {
  type: "component.resetOverride";
  payload: { instanceId: NodeId; sourceNodeId: NodeId };
}
export interface InstantiateComponentCommand {
  type: "component.instantiate";
  payload: { node: InstanceNode; index?: number };
}

export type DesignCommand =
  | RestoreHistoryCommand
  | RenameDocumentCommand
  | CreateNodeCommand
  | PatchNodeCommand
  | PatchTextCommand
  | SetParagraphStyleCommand
  | DeleteNodeCommand
  | ReparentNodeCommand
  | UpsertAssetCommand
  | PatchImageCommand
  | PatchVectorCommand
  | DeleteAssetCommand
  | UpsertTokenCommand
  | DeleteTokenCommand
  | CreatePageCommand
  | RenamePageCommand
  | DeletePageCommand
  | DefineComponentCommand
  | CreateComponentCommand
  | CreateComponentSetCommand
  | AssignComponentVariantCommand
  | CreateComponentVariantCommand
  | SwitchComponentVariantCommand
  | RegisterFontCommand
  | RemoveFontCommand
  | CreateBooleanCommand
  | SetBooleanOperationCommand
  | ReleaseBooleanCommand
  | RemoveComponentCommand
  | InstantiateComponentCommand
  | DetachComponentCommand
  | FillSlotCommand
  | ComponentOverrideCommand
  | ResetComponentOverrideCommand
  | ResetAllComponentOverridesCommand
  | DetachManyComponentsCommand
  | PatchInteractionCommand
  | SetComponentPropertyCommand
  | RemoveComponentPropertyCommand
  | BindComponentPropertyCommand
  | UnbindComponentPropertyCommand
  | SetInstancePropertyCommand
  | ResetInstancePropertyCommand;

export interface CommandEnvelope {
  commandId: string;
  documentId: string;
  baseRevision: number;
  actor: { type: "human" | "ai" | "integration"; id: string };
  commands: DesignCommand[];
}

export interface ChangeSet {
  before: DesignDocument;
  after: DesignDocument;
}

export interface CommandResult {
  revision: number;
  changes: ChangeSet;
  inverse: ChangeSet;
  warnings: string[];
}

export interface TransactionEntry {
  commandId: string;
  documentId: string;
  revision: number;
  committedAt: string;
  actor: CommandEnvelope["actor"];
  commands: DesignCommand[];
  warnings: string[];
}

/**
 * 批量清除覆盖。
 *
 * 不传 `sourceNodeIds` 时清掉这个实例的全部覆盖；传了就只清指定的几个。
 * 一次事务完成，撤销时一起回来。
 */
export interface ResetAllComponentOverridesCommand {
  type: "component.resetOverrides";
  payload: { instanceId: NodeId; sourceNodeIds?: NodeId[] };
}

/** 一次把多个实例脱离成普通 frame（同一个事务，任一失败整批回滚）。 */
export interface DetachManyComponentsCommand {
  type: "component.detachMany";
  payload: { ids: NodeId[] };
}

/**
 * 改节点的原型交互。
 *
 * 单独开一条命令而不是扩张通用 `node.patch`：`interactions` 只对「行为」有意义，
 * 而且它需要**语义级校验**（延迟是否合法、动画是否与动作匹配、跳转目标是否存在），
 * 这些不是形状校验能覆盖的。
 *
 * 交互是整组替换而不是增量合并——`node.patch` 的增量语义在这里会让
 * 「删掉某条交互」无法表达。
 */
export interface PatchInteractionCommand {
  type: "interaction.patch";
  payload: { id: NodeId; interactions: Interaction[] };
}

/**
 * 声明或更新一个组件属性。
 *
 * 按 `property.id` 覆盖：同一个 id 再次提交就是更新（改名 / 改默认值）。
 * 改默认值会立刻作用到该组件的所有实例——没显式改过值的实例跟着变，
 * 改过的实例保持自己的值。
 */
export interface SetComponentPropertyCommand {
  type: "component.property.set";
  payload: { componentId: string; property: ComponentProperty };
}

/**
 * 删除一个组件属性。
 *
 * 同时清掉：组件子树里指向它的绑定、各实例上的显式值。
 * 被绑定的字段会恢复成组件定义里的原始样子。
 */
export interface RemoveComponentPropertyCommand {
  type: "component.property.remove";
  payload: { componentId: string; propertyId: string };
}

/**
 * 把组件属性绑定到组件内部某个节点的字段。
 *
 * 字段只有 `text` 与 `visible` 两个：`text` 要求属性是 text 类型且节点是文本节点，
 * `visible` 要求属性是 boolean 类型。同一字段重复绑定是覆盖。
 */
export interface BindComponentPropertyCommand {
  type: "component.property.bind";
  payload: { componentId: string; propertyId: string; nodeId: NodeId; field: ComponentPropertyField };
}

/** 解除绑定；被绑定的字段恢复成组件定义里的原始样子。 */
export interface UnbindComponentPropertyCommand {
  type: "component.property.unbind";
  payload: { componentId: string; propertyId: string; nodeId: NodeId; field: ComponentPropertyField };
}

/** 设置实例上某个属性的值；立即作用到实例的物化副本。 */
export interface SetInstancePropertyCommand {
  type: "instance.property.set";
  payload: { instanceId: NodeId; propertyId: string; value: string | boolean };
}

/** 删掉实例的显式值，回到组件声明的默认值。 */
export interface ResetInstancePropertyCommand {
  type: "instance.property.reset";
  payload: { instanceId: NodeId; propertyId: string };
}