import type {
  ComponentDefinition,
  DesignDocument,
  DesignNode,
  DesignPage,
  InstanceNode,
  NodeId,
  PageId,
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

export interface DeleteNodeCommand {
  type: "node.delete";
  payload: { id: NodeId };
}

export interface ReparentNodeCommand {
  type: "node.reparent";
  payload: { id: NodeId; parentId: NodeId | PageId; index?: number };
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
  | DeleteNodeCommand
  | ReparentNodeCommand
  | UpsertTokenCommand
  | DeleteTokenCommand
  | CreatePageCommand
  | RenamePageCommand
  | DeletePageCommand
  | DefineComponentCommand
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
