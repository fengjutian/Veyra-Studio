import type { DesignCommand } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";
import { MCP_SUPPORTED_COMMAND_TYPES, MCP_TOOLS, authorizeCommands, createAuditEntry, type McpPolicy, type McpToolDefinition } from "./mcp";
import type { StudioProject } from "./studio-project";

/**
 * MCP 传输无关的请求处理器。
 *
 * 真正的 stdio server 只负责读写 JSON-RPC 行；所有语义都在这里，因此可以用
 * 内存仓库直接测，不需要 spawn 子进程。stdout 只写协议消息，审计走 stderr 回调。
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpServerOptions {
  policy?: McpPolicy;
  /**
   * 是否跳过人工确认。
   *
   * CLI 场景没有 UI，只能靠环境变量显式声明"本次会话已获授权"；默认 false，
   * 需要确认的调用会返回 `approval_required`，而不是偷偷执行。
   */
  autoApprove?: boolean;
  /** 审计回调；stdio 版本写到 stderr。 */
  onAudit?(entry: ReturnType<typeof createAuditEntry>): void;
  serverVersion?: string;
}

export interface McpServer {
  handle(message: unknown): Promise<JsonRpcResponse | undefined>;
}

const PROTOCOL_VERSION = "2024-11-05";

export function createMcpServer(project: StudioProject, options: McpServerOptions = {}): McpServer {
  return {
    async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
      if (!isRequest(message)) return errorResponse(null, -32600, "Invalid JSON-RPC request");
      const { id = null, method } = message;
      // 通知消息没有 id，也不需要响应。
      if (method === "notifications/initialized") return undefined;

      try {
        switch (method) {
          case "initialize": return { jsonrpc: "2.0", id, result: initializeResult(options.serverVersion) };
          case "ping": return { jsonrpc: "2.0", id, result: {} };
          case "tools/list": return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS.map(toToolSchema) } };
          case "tools/call": return await callTool(project, options, id, message.params);
          default: return errorResponse(id, -32601, `Method not found: ${method}`);
        }
      } catch (error) {
        return errorResponse(id, -32603, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function initializeResult(serverVersion = "0.1.0"): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "ufira-studio-mcp", version: serverVersion },
  };
}

/** 契约里的输入 schema 转成 MCP/JSON Schema。 */
function toToolSchema(tool: McpToolDefinition): unknown {
  return {
    name: tool.name,
    description: `${tool.title}：${tool.description}`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([name, property]) => [name, propertySchema(property)])),
      required: tool.inputSchema.required,
    },
  };
}

function propertySchema(property: McpToolDefinition["inputSchema"]["properties"][string]): unknown {
  const schema: Record<string, unknown> = { type: property.type, description: property.description };
  if (property.items) schema.items = propertySchema(property.items);
  return schema;
}

async function callTool(project: StudioProject, options: McpServerOptions, id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
  if (!isRecord(params) || typeof params.name !== "string") return errorResponse(id, -32602, "tools/call 需要 name");
  const args = isRecord(params.arguments) ? params.arguments : {};

  switch (params.name) {
    case "design.read": return ok(id, readDocument(project, args));
    case "design.preview": return ok(id, previewCommands(project, args));
    case "design.apply": return await applyCommands(project, options, id, args);
    default: return errorResponse(id, -32602, `Unknown tool: ${params.name}`);
  }
}

function readDocument(project: StudioProject, args: Record<string, unknown>): unknown {
  const document = project.snapshot();
  const pageId = typeof args.pageId === "string" ? args.pageId : undefined;
  const pages = document.pageOrder
    .filter(id => !pageId || id === pageId)
    .map(id => ({ id, name: document.pages[id]?.name, childCount: document.pages[id]?.childIds.length ?? 0 }));
  return toolResult({
    id: document.id,
    revision: document.revision,
    name: document.meta.name,
    schemaVersion: document.schemaVersion,
    pages,
    counts: { nodes: Object.keys(document.nodes).length, components: Object.keys(document.components).length, tokens: Object.keys(document.tokens).length, assets: Object.keys(document.assets).length },
    tokens: document.tokens,
  });
}

function previewCommands(project: StudioProject, args: Record<string, unknown>): unknown {
  const commands = parseCommands(args.commands);
  const document = project.snapshot();
  const preview = project.preview({
    commandId: `mcp:preview:${globalThis.crypto.randomUUID()}`,
    documentId: document.id,
    baseRevision: document.revision,
    actor: { type: "integration", id: "mcp:preview" },
    commands,
  });
  return toolResult({
    baseRevision: document.revision,
    commands: commands.map(command => command.type),
    changedNodeIds: changedNodeIds(preview.before, preview.after),
    warnings: preview.result.warnings,
    beforeCounts: countNodes(preview.before),
    afterCounts: countNodes(preview.after),
  });
}

async function applyCommands(project: StudioProject, options: McpServerOptions, id: string | number | null, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const commands = parseCommands(args.commands);
  if (typeof args.baseRevision !== "number") return errorResponse(id, -32602, "design.apply 需要 baseRevision");
  const document = project.snapshot();
  if (args.baseRevision !== document.revision) {
    return ok(id, toolError(`revision_mismatch：调用方基于 r${args.baseRevision}，当前是 r${document.revision}`));
  }

  const decision = authorizeCommands(options.policy, commands);
  if (!decision.allowed) {
    options.onAudit?.(createAuditEntry({ tool: "design.apply", commandId: `mcp:${globalThis.crypto.randomUUID()}`, actor: "mcp:client", revisionBefore: document.revision, commands, decision: "rejected", reason: decision.reasons.join("；") }));
    return ok(id, toolError(`policy_rejected：${decision.reasons.join("；")}`));
  }
  if (decision.requiresApproval && !options.autoApprove) {
    options.onAudit?.(createAuditEntry({ tool: "design.apply", commandId: `mcp:${globalThis.crypto.randomUUID()}`, actor: "mcp:client", revisionBefore: document.revision, commands, decision: "rejected", reason: "approval_required" }));
    return ok(id, toolError(`approval_required：${decision.approvalReasons.join("；")}`));
  }

  const commandId = `mcp:${globalThis.crypto.randomUUID()}`;
  try {
    const committed = await project.execute({
      commandId,
      documentId: document.id,
      baseRevision: document.revision,
      actor: { type: "integration", id: "mcp:client" },
      commands,
    });
    options.onAudit?.(createAuditEntry({
      tool: "design.apply",
      commandId,
      actor: "mcp:client",
      revisionBefore: document.revision,
      revisionAfter: committed.result.revision,
      commands,
      decision: "applied",
    }));
    return ok(id, toolResult({ revision: committed.result.revision, checkpointed: committed.checkpointed, warnings: committed.result.warnings, summary: typeof args.summary === "string" ? args.summary : undefined }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onAudit?.(createAuditEntry({ tool: "design.apply", commandId, actor: "mcp:client", revisionBefore: document.revision, commands, decision: "rejected", reason: message }));
    return ok(id, toolError(`apply_failed：${message}`));
  }
}

function parseCommands(value: unknown): DesignCommand[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("commands 必须是非空数组");
  for (const command of value) {
    if (!isRecord(command) || typeof command.type !== "string") throw new Error("每条命令都需要 type");
    if (!(MCP_SUPPORTED_COMMAND_TYPES as readonly string[]).includes(command.type)) throw new Error(`不支持的命令：${command.type}`);
  }
  return value as DesignCommand[];
}

function toolResult(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countNodes(document: DesignDocument): number {
  return Object.keys(document.nodes).length;
}

function changedNodeIds(before: DesignDocument, after: DesignDocument): string[] {
  const changed = new Set<string>();
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    if (!before.nodes[id] || !after.nodes[id] || before.nodes[id] !== after.nodes[id]) {
      if (JSON.stringify(before.nodes[id]) !== JSON.stringify(after.nodes[id])) changed.add(id);
    }
  }
  return [...changed];
}
