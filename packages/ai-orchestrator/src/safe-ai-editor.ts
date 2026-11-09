import type { DesignCommand, CommandEnvelope } from "@ufira/design-runtime";
import type { DesignDocument, NodeId } from "@ufira/design-schema";
import type { StudioExecuteResult, StudioProject } from "@ufira/studio-application";
import { PlanEmptyError } from "./plan-parser";
import { reviewAiPlan, type ReviewFinding, type ReviewResult } from "./review";
import type { SelfCheckContext } from "./self-check";

/** 取消信号的形状。用结构化类型，避免依赖 DOM 的 AbortSignal 声明。 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

/**
 * 一张给模型看的图。
 *
 * 用 data URL 而不是裸字节：OpenAI 兼容端点的 `image_url` 直接吃 data URL，
 * 不用先上传再引用。传输层（浏览器）负责把当前画面渲染成 PNG，编排层只负责
 * 原样传下去——**它不关心图从哪来**。
 */
export interface AiImagePayload {
  /** 完整的 data URL：`data:image/png;base64,...`。 */
  dataUrl: string;
  /** MIME 类型，例如 `image/png`。 */
  mimeType: string;
  /** 像素宽高；写进提示，模型好定位画面里的东西。 */
  width?: number;
  height?: number;
}

export interface AiPlanRequest {
  prompt: string;
  document: DesignDocument;
  selectedNodeIds: NodeId[];
  /**
   * 当前画面的截图。
   *
   * 有了它，模型才能回答「好不好看」「哪里挤」「对比够不够」这类**看图**才能
   * 回答的问题——文字摘要给不了这些。没有它时整条链路照旧工作，只是模型瞎猜。
   */
  image?: AiImagePayload;
  /**
   * 体检结论。
   *
   * 编排循环靠它把「哪里不对」回喂给模型：模型看到的不是上一次的需求，而是
   * 体检说这里还差什么。没有它，循环就只是把同一个请求重复很多遍。
   */
  selfCheck?: SelfCheckContext;
  /** 当前是第几轮；只影响体检结论的措辞。 */
  selfCheckRound?: number;
  /** 取消信号：规划过程中用户点「取消」时透传给 Planner。 */
  signal?: AbortSignalLike;
  /**
   * 流式增量回调。
   *
   * Planner 支持流式时会边收边调；参数是本次增量与累计文本，界面可以只做
   * "追加显示"，不必自己拼。不支持流式的 Planner 不会调用它。
   */
  onDelta?(delta: string, fullText: string): void;
}

export interface CreatePlanOptions {
  signal?: AbortSignalLike;
  onDelta?(delta: string, fullText: string): void;
  /** 体检结论；会原样传给 Planner，最终拼进提示的 user 段。 */
  selfCheck?: SelfCheckContext;
  /** 当前是第几轮。 */
  selfCheckRound?: number;
  /** 当前画面的截图；传了它模型就能「看图」。 */
  image?: AiImagePayload;
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

/**
 * 计划的 dry-run 没过：命令本身有问题（字段写错、引用了不存在的节点）。
 *
 * 单独一个类型，是为了让编排循环能**把错误回喂给模型**再要一版——命令哪里不对
 * 是模型自己能改的，直接收工等于白跑一轮。
 */
export class AiPlanDryRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiPlanDryRunError";
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
   * 当前文档快照。
   *
   * 编排循环要靠它做体检（读文档、扫问题），而 `project` 是私有的；这里开一个
   * 只读入口，避免把整个项目对象暴露出去。
   */
  snapshot(): DesignDocument {
    return this.project.snapshot();
  }

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
      ...(options.image ? { image: options.image } : {}),
      ...(options.selfCheck ? { selfCheck: options.selfCheck } : {}),
      ...(options.selfCheckRound !== undefined ? { selfCheckRound: options.selfCheckRound } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onDelta ? { onDelta: options.onDelta } : {}),
    });
    if (!planned.summary.trim()) throw new Error("AI plan summary cannot be empty");
    // 模型说「没有要改的」是合法结论，单独的错误类型让调用方能区分它和故障。
    if (planned.commands.length === 0) throw new PlanEmptyError();

    const planId = crypto.randomUUID();
    const envelope = this.envelope(planId, document, planned.commands);
    let preview: ReturnType<StudioProject["preview"]>;
    try {
      preview = this.project.preview(envelope);
    } catch (error) {
      // 命令跑不通是模型能自己改的问题：把原因带出去，调用方可以回喂给它再要一版。
      throw new AiPlanDryRunError(error instanceof Error ? error.message : String(error), { cause: error });
    }
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
      case "vector.patch":
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
