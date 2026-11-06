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
    patch: Partial<Pick<DesignNode, "name" | "visible" | "locked" | "layout" | "appearance" | "bindings">>;
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
  | InstantiateComponentCommand;

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
