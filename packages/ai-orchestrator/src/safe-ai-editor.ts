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
  /**
   * 这张图是什么范围的截图。
   *
   * 模型看到的是一张图，不知道它是整页、选区还是好几页拼起来的——不说明的话，
   * 它会把拼图当成一张奇怪的页面来读。写一句人话告诉它（「当前页」「选区里的 2 个
   * 节点」「3 个页面，从左到右」），它才知道该按什么视角看。
   */
  label?: string;
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
  /**
   * 本次计划被限制在哪一页。
   *
   * 传了它，文档摘要里**只列这一页的节点树**——别的页面的节点 id 一个都不给模型。
   * 理由实测过：模型看到别页的 `frame:users-sidebar` 就会去 patch 它，
   * "照着上一页的样子改一下"，结果整份计划被范围审查拦下。
   */
  scopePageId?: string;
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
  /**
   * 把计划硬性限制在某一页。提示词只能劝模型别越界，这个策略会在 dry-run 后
   * 检查真实差异，并把修改其它页面的计划标成 blocking。
   */
  pageId?: string;
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
      ...(options.pageId ? { scopePageId: options.pageId } : {}),
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
    if (options.pageId) {
      const scopeFinding = reviewPageScope(preview.before, preview.after, options.pageId);
      if (scopeFinding) {
        review.findings.push(scopeFinding);
        review.blocking = true;
      }
    }
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

/**
 * 找出单页计划是否改到了别的页面。
 *
 * 用 dry-run 的 before/after 做事实判断，而不是猜某种命令的 payload：这样新增命令
 * 也会自动受保护。节点归属沿 parentId 一直追到页面，删除节点看 before，新建节点
 * 看 after；跨页 reparent 会同时命中页面结构与节点归属检查。
 */
function reviewPageScope(before: DesignDocument, after: DesignDocument, pageId: string): ReviewFinding | undefined {
  if (!before.pages[pageId]) {
    return { code: "page-scope-missing", severity: "blocking", message: `AI 单页范围不存在：${pageId}` };
  }

  const outsidePages = new Set<string>();
  for (const id of new Set([...Object.keys(before.pages), ...Object.keys(after.pages)])) {
    if (id === pageId) continue;
    if (!sameValue(before.pages[id], after.pages[id])) outsidePages.add(id);
  }

  const outsideNodes: NodeId[] = [];
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    if (sameValue(before.nodes[id], after.nodes[id])) continue;
    const owner = owningPageId(after, id) ?? owningPageId(before, id);
    if (owner !== pageId) outsideNodes.push(id);
  }

  if (!outsidePages.size && !outsideNodes.length) return undefined;
  const details = [
    outsidePages.size ? `${outsidePages.size} 个其它页面` : "",
    outsideNodes.length ? `${outsideNodes.length} 个页外节点` : "",
  ].filter(Boolean).join("、");
  // 把节点 id 点名：只有数字的话，拿到反馈的一方（模型）没法定位，只能反复犯同样的错。
  const names = outsideNodes.length ? `：${outsideNodes.slice(0, 8).join("、")}` : "";
  return {
    code: "page-scope-violation",
    severity: "blocking",
    message: `计划限定为当前页 ${pageId}，但会修改${details}${names}`,
    ...(outsideNodes.length ? { nodeIds: outsideNodes.slice(0, 10) } : {}),
  };
}

function owningPageId(document: DesignDocument, nodeId: NodeId): string | undefined {
  let owner = document.nodes[nodeId]?.parentId;
  const visited = new Set<string>();
  while (owner && !visited.has(owner)) {
    if (document.pages[owner]) return owner;
    visited.add(owner);
    owner = document.nodes[owner]?.parentId;
  }
  return undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
