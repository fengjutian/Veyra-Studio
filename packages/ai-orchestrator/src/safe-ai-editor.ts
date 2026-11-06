import type { DesignCommand, CommandEnvelope } from "@ufira/design-runtime";
import type { DesignDocument, NodeId } from "@ufira/design-schema";
import type { StudioExecuteResult, StudioProject } from "@ufira/studio-application";
import { reviewAiPlan, type ReviewFinding, type ReviewResult } from "./review";

/** 取消信号的形状。用结构化类型，避免依赖 DOM 的 AbortSignal 声明。 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

export interface AiPlanRequest {
  prompt: string;
  document: DesignDocument;
  selectedNodeIds: NodeId[];
  /** 取消信号：规划过程中用户点「取消」时透传给 Planner。 */
  signal?: AbortSignalLike;
}

export interface CreatePlanOptions {
  signal?: AbortSignalLike;
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
  /** 结构审查结论；blocking 时必须先改计划才能提交。 */
  review: ReviewResult;
}

export class AiPlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`AI plan ${planId} does not exist or is no longer pending`);
    this.name = "AiPlanNotFoundError";
  }
}

/** 计划被结构审查拦下：不属于"运行失败"，而是"这次改动不该提交"。 */
export class AiReviewBlockedError extends Error {
  constructor(readonly findings: ReviewFinding[]) {
    super(`AI 计划未通过结构审查：${findings.filter(finding => finding.severity === "blocking").map(finding => finding.message).join("；")}`);
    this.name = "AiReviewBlockedError";
  }
}

export class SafeAiEditor {
  private readonly pending = new Map<string, AiPlanPreview>();

  constructor(
    private readonly project: StudioProject,
    private readonly planner: AiPlanner,
    private readonly actorId = "studio-ai",
  ) {}

  /**
   * 让模型给出一份可预览的计划。
   *
   * 失败或取消时什么都不留下：计划只有在 dry-run 成功之后才会进入 `pending`，
   * 所以异常路径不会污染项目，也不会留下"幽灵计划"。
   */
  async createPlan(prompt: string, selectedNodeIds: NodeId[] = [], options: CreatePlanOptions = {}): Promise<AiPlanPreview> {
    if (!prompt.trim()) throw new Error("AI prompt cannot be empty");
    if (options.signal?.aborted) throw new Error("AI 请求已取消");
    const document = this.project.snapshot();
    for (const id of selectedNodeIds) {
      if (!document.nodes[id]) throw new Error(`Selected node ${id} does not exist`);
    }

    const planned = await this.planner.plan({
      prompt,
      document: structuredClone(document),
      selectedNodeIds: [...selectedNodeIds],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!planned.summary.trim()) throw new Error("AI plan summary cannot be empty");
    if (planned.commands.length === 0) throw new Error("AI plan must contain at least one command");

    const planId = crypto.randomUUID();
    const envelope = this.envelope(planId, document, planned.commands);
    const preview = this.project.preview(envelope);
    // dry-run 证明"能跑"，审查证明"该不该跑"。
    const review = reviewAiPlan({ before: preview.before, after: preview.after, commands: planned.commands });
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
      review,
    };
    this.pending.set(planId, structuredClone(result));
    return structuredClone(result);
  }

  async confirm(planId: string): Promise<StudioExecuteResult> {
    const plan = this.requirePending(planId);
    if (plan.review.blocking) throw new AiReviewBlockedError(plan.review.findings);
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
      case "image.patch":
        ids.add(command.payload.id);
        break;
      case "component.define":
        ids.add(command.payload.component.rootNodeId);
        break;
      case "document.rename":
      case "asset.upsert":
      case "asset.delete":
      case "history.restore":
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
