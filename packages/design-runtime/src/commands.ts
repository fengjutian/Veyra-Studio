import type {
  AssetMetadata,
  ComponentDefinition,
  DesignDocument,
  DesignNode,
  DesignPage,
  ImageNode,
  InstanceNode,
  NodeId,
  PageId,
  TextPatch,
  TokenValue,
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
    patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "bindings" | "slot">>;
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
  | DeleteNodeCommand
  | ReparentNodeCommand
  | UpsertAssetCommand
  | PatchImageCommand
  | DeleteAssetCommand
  | UpsertTokenCommand
  | DeleteTokenCommand
  | CreatePageCommand
  | RenamePageCommand
  | DeletePageCommand
  | DefineComponentCommand
  | CreateComponentCommand
  | RemoveComponentCommand
  | InstantiateComponentCommand
  | DetachComponentCommand
  | FillSlotCommand
  | ComponentOverrideCommand
  | ResetComponentOverrideCommand;

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
