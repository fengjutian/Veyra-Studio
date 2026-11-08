import type { DesignCommand } from "@ufira/design-runtime";

/**
 * Studio MCP adapter 的命令契约（不含传输层）。
 *
 * 这一层只回答三个问题：
 * 1. 外部 Agent 能看到哪些工具、每个工具接受什么输入；
 * 2. 一次调用在当前策略下能不能执行、需不需要人工确认；
 * 3. 执行完应该留下什么样的审计记录。
 *
 * 真正的 MCP server（stdio/HTTP）以后接在这份契约上；现在先把"权限与审计"的
 * 语义固定下来，避免以后每加一个传输层就重新发明一遍规则。
 */

/** 破坏性命令：即使策略关闭了人工确认，也必须先确认。 */
export const DESTRUCTIVE_COMMAND_TYPES = [
  "node.delete",
  "page.delete",
  "component.remove",
  "token.delete",
  "asset.delete",
  "font.remove",
  "history.restore",
] as const satisfies ReadonlyArray<DesignCommand["type"]>;

/**
 * 支持的命令类型。
 *
 * 用 `Record<DesignCommand["type"], true>` 而不是数组：运行时新增一条命令却忘了
 * 在这里登记时，TypeScript 会直接报错，不会让适配器悄悄少支持一个命令。
 */
const SUPPORTED_COMMANDS: Record<DesignCommand["type"], true> = {
  "document.rename": true,
  "node.create": true,
  "node.patch": true,
  "text.patch": true,
  "node.delete": true,
  "node.reparent": true,
  "asset.upsert": true,
  "image.patch": true,
  "vector.patch": true,
  "asset.delete": true,
  "token.upsert": true,
  "token.delete": true,
  "page.create": true,
  "page.rename": true,
  "page.delete": true,
  "component.define": true,
  "component.create": true,
  "component.setCreate": true,
  "component.setVariant": true,
  "component.createVariant": true,
  "component.switchVariant": true,
  "font.register": true,
  "font.remove": true,
  "component.remove": true,
  "component.instantiate": true,
  "component.detach": true,
  "component.detachMany": true,
  "component.override": true,
  "component.resetOverride": true,
  "component.resetOverrides": true,
  "slot.fill": true,
  "interaction.patch": true,
  "history.restore": true,
};

export const MCP_SUPPORTED_COMMAND_TYPES = Object.keys(SUPPORTED_COMMANDS) as DesignCommand["type"][];

export interface McpInputProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  items?: McpInputProperty;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  /** 这个工具允许承载的命令类型；空数组表示只读工具。 */
  commandTypes: DesignCommand["type"][];
  requiresApproval: boolean;
  inputSchema: { type: "object"; properties: Record<string, McpInputProperty>; required: string[] };
}

/**
 * 暴露给外部 Agent 的工具清单。
 *
 * 刻意保持很小：读取、预览、应用。更细的能力通过命令参数表达，而不是再拆十几个
 * 工具 —— MCP 的工具列表是给模型看的，越长越容易选错。
 */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "design.read",
    title: "读取设计文档",
    description: "返回当前文档的页面、节点、token 与组件摘要。只读，不需要确认。",
    commandTypes: [],
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "可选的页面 id；不传则返回全部页面摘要" },
      },
      required: [],
    },
  },
  {
    name: "design.preview",
    title: "预览命令",
    description: "在临时运行时里执行命令，返回变更前后与告警，不写入项目。只读，不需要确认。",
    commandTypes: [...MCP_SUPPORTED_COMMAND_TYPES],
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description: "要预览的命令数组",
          items: { type: "object", description: "与 design.apply 相同的命令结构" },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "design.apply",
    title: "应用命令",
    description: "把命令作为一次原子事务提交。是否放行由策略决定，破坏性命令必须人工确认。",
    commandTypes: [...MCP_SUPPORTED_COMMAND_TYPES],
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description: "要提交的命令数组",
          items: { type: "object", description: "领域命令（与 studio-application 一致）" },
        },
        baseRevision: { type: "number", description: "调用方看到的修订号；不一致时拒绝" },
        summary: { type: "string", description: "给审计记录看的一句话说明" },
      },
      required: ["commands", "baseRevision"],
    },
  },
];

export const MCP_TOOL_NAMES = MCP_TOOLS.map(tool => tool.name);

export interface McpPolicy {
  /** 白名单；不传表示所有支持的命令都允许。 */
  allowedCommandTypes?: DesignCommand["type"][];
  /** 黑名单，优先级高于白名单。 */
  deniedCommandTypes?: DesignCommand["type"][];
  /** 是否要求人工确认；破坏性命令无论如何都要确认。默认 true。 */
  requireApproval?: boolean;
  /** 单次调用的命令上限，默认 50。 */
  maxCommandsPerBatch?: number;
  /** 是否允许 history.restore（整篇覆盖），默认不允许。 */
  allowDocumentRestore?: boolean;
}

export interface McpDecision {
  allowed: boolean;
  requiresApproval: boolean;
  /** 拒绝原因；allowed 为 true 时为空。 */
  reasons: string[];
  /** 需要确认的原因（破坏性命令等）。 */
  approvalReasons: string[];
}

export const DEFAULT_MAX_COMMANDS = 50;

/**
 * 判断一次调用是否放行。
 *
 * 规则顺序很重要：先拒绝对话级的非法请求（空批量、超限、整篇还原），再看命令
 * 白/黑名单，最后决定要不要人工确认。任何一条拒绝都会让整批不执行——MCP 侧不做
 * "部分执行"，避免外部 Agent 在失败后反复重试半截操作。
 */
export function authorizeCommands(policy: McpPolicy | undefined, commands: DesignCommand[]): McpDecision {
  const rules = policy ?? {};
  const maxCommands = rules.maxCommandsPerBatch ?? DEFAULT_MAX_COMMANDS;
  const reasons: string[] = [];
  const approvalReasons: string[] = [];

  if (!commands.length) reasons.push("命令数组不能为空");
  if (commands.length > maxCommands) reasons.push(`一次最多 ${maxCommands} 条命令，收到 ${commands.length} 条`);

  const denied = new Set(rules.deniedCommandTypes ?? []);
  const allowed = rules.allowedCommandTypes ? new Set(rules.allowedCommandTypes) : undefined;
  for (const command of commands) {
    if (denied.has(command.type)) reasons.push(`命令 ${command.type} 在拒绝列表里`);
    else if (allowed && !allowed.has(command.type)) reasons.push(`命令 ${command.type} 不在允许列表里`);
    if (command.type === "history.restore" && !rules.allowDocumentRestore) reasons.push("不允许通过 MCP 做整篇还原（history.restore）");
  }

  const destructive = commands.filter(command => (DESTRUCTIVE_COMMAND_TYPES as readonly string[]).includes(command.type));
  if (destructive.length) approvalReasons.push(`包含破坏性命令：${[...new Set(destructive.map(command => command.type))].join("、")}`);
  if (rules.requireApproval ?? true) approvalReasons.push("策略要求人工确认");

  return {
    allowed: reasons.length === 0,
    requiresApproval: approvalReasons.length > 0,
    reasons: [...new Set(reasons)],
    approvalReasons: [...new Set(approvalReasons)],
  };
}

export interface McpAuditInput {
  tool: string;
  commandId: string;
  actor: string;
  revisionBefore: number;
  revisionAfter?: number;
  commands: DesignCommand[];
  decision: "applied" | "rejected";
  reason?: string;
  at?: string;
}

export interface McpAuditEntry {
  tool: string;
  commandId: string;
  actor: string;
  revisionBefore: number;
  revisionAfter?: number;
  commandTypes: string[];
  decision: "applied" | "rejected";
  reason?: string;
  at: string;
}

/** 审计记录：谁、通过哪个工具、改了什么、结果如何。 */
export function createAuditEntry(input: McpAuditInput): McpAuditEntry {
  return {
    tool: input.tool,
    commandId: input.commandId,
    actor: input.actor,
    revisionBefore: input.revisionBefore,
    ...(input.revisionAfter !== undefined ? { revisionAfter: input.revisionAfter } : {}),
    commandTypes: input.commands.map(command => command.type),
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
    at: input.at ?? new Date().toISOString(),
  };
}
