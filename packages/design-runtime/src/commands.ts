import type { DesignDocument, DesignNode, NodeId, PageId, TokenValue } from "@ufira/design-schema";

export interface CreateNodeCommand {
  type: "node.create";
  payload: { node: DesignNode; index?: number };
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

export type DesignCommand =
  | CreateNodeCommand
  | PatchNodeCommand
  | DeleteNodeCommand
  | ReparentNodeCommand
  | UpsertTokenCommand;

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
