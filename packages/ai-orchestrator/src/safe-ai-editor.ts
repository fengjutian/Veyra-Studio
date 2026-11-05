import type { DesignCommand, CommandEnvelope, CommandResult } from "@ufira/design-runtime";
import type { DesignDocument, NodeId } from "@ufira/design-schema";
import type { StudioExecuteResult, StudioProject } from "@ufira/studio-application";

export interface AiPlanRequest {
  prompt: string;
  document: DesignDocument;
  selectedNodeIds: NodeId[];
}

export interface AiCommandPlan {
  summary: string;
  commands: DesignCommand[];
  assumptions?: string[];
}

export interface AiPlanner {
  plan(request: AiPlanRequest): Promise<AiCommandPlan>;
}

export interface AiPlanPreview {
  planId: string;
  prompt: string;
  summary: string;
  assumptions: string[];
  baseRevision: number;
  affectedNodeIds: NodeId[];
  commands: DesignCommand[];
  before: DesignDocument;
  after: DesignDocument;
  warnings: string[];
}

export class AiPlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`AI plan ${planId} does not exist or is no longer pending`);
    this.name = "AiPlanNotFoundError";
  }
}

export class SafeAiEditor {
  private readonly pending = new Map<string, AiPlanPreview>();

  constructor(
    private readonly project: StudioProject,
    private readonly planner: AiPlanner,
    private readonly actorId = "studio-ai",
  ) {}

  async createPlan(prompt: string, selectedNodeIds: NodeId[] = []): Promise<AiPlanPreview> {
    if (!prompt.trim()) throw new Error("AI prompt cannot be empty");
    const document = this.project.snapshot();
    for (const id of selectedNodeIds) {
      if (!document.nodes[id]) throw new Error(`Selected node ${id} does not exist`);
    }

    const planned = await this.planner.plan({
      prompt,
      document: structuredClone(document),
      selectedNodeIds: [...selectedNodeIds],
    });
    if (!planned.summary.trim()) throw new Error("AI plan summary cannot be empty");
    if (planned.commands.length === 0) throw new Error("AI plan must contain at least one command");

    const planId = crypto.randomUUID();
    const envelope = this.envelope(planId, document, planned.commands);
    const preview = this.project.preview(envelope);
    const result: AiPlanPreview = {
      planId,
      prompt,
      summary: planned.summary,
      assumptions: [...(planned.assumptions ?? [])],
      baseRevision: document.revision,
      affectedNodeIds: collectAffectedNodeIds(planned.commands),
      commands: structuredClone(planned.commands),
      before: preview.before,
      after: preview.after,
      warnings: [...preview.result.warnings],
    };
    this.pending.set(planId, structuredClone(result));
    return structuredClone(result);
  }

  async confirm(planId: string): Promise<StudioExecuteResult> {
    const plan = this.requirePending(planId);
    const current = this.project.snapshot();
    const envelope = this.envelope(planId, current, plan.commands, plan.baseRevision);
    const committed = await this.project.execute(envelope);
    this.pending.delete(planId);
    return committed;
  }

  cancel(planId: string): void {
    this.requirePending(planId);
    this.pending.delete(planId);
  }

  getPending(planId: string): AiPlanPreview | undefined {
    const plan = this.pending.get(planId);
    return plan ? structuredClone(plan) : undefined;
  }

  private requirePending(planId: string): AiPlanPreview {
    const plan = this.pending.get(planId);
    if (!plan) throw new AiPlanNotFoundError(planId);
    return plan;
  }

  private envelope(planId: string, document: DesignDocument, commands: DesignCommand[], baseRevision = document.revision): CommandEnvelope {
    return {
      commandId: `ai:${planId}`,
      documentId: document.id,
      baseRevision,
      actor: { type: "ai", id: this.actorId },
      commands: structuredClone(commands),
    };
  }
}

function collectAffectedNodeIds(commands: DesignCommand[]): NodeId[] {
  const ids = new Set<NodeId>();
  for (const command of commands) {
    switch (command.type) {
      case "node.create":
      case "component.instantiate":
        ids.add(command.payload.node.id);
        break;
      case "node.patch":
      case "node.delete":
        ids.add(command.payload.id);
        break;
      case "node.reparent":
        ids.add(command.payload.id);
        break;
      case "component.define":
        ids.add(command.payload.component.rootNodeId);
        break;
      case "token.upsert":
      case "token.delete":
      case "page.create":
      case "page.rename":
      case "page.delete":
      case "component.remove":
        break;
    }
  }
  return [...ids];
}
