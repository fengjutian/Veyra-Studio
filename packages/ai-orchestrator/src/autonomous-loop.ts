import type { NodeId } from "@ufira/design-schema";
import { PlanEmptyError } from "./plan-parser";
import type { AbortSignalLike, AiPlanPreview } from "./safe-ai-editor";
import { SafeAiEditor } from "./safe-ai-editor";
import { collectSelfCheck, selfCheckFingerprint, type SelfCheckContext, type SelfCheckIssue, type SelfCheckOptions, type SelfCheckReport } from "./self-check";

/**
 * 编排循环：把「计划 → 执行 → 自查 → 再计划」串成一层。
 *
 * 这一层之前是缺的——lint、对比度、导出诊断各自都能跑，但没有谁把它们串起来，
 * 于是每一步都得人当鼠标。串起来之后，AI 才能自己跑一晚上。
 *
 * 循环的形状是**体检驱动**的：不是"把同一个需求问很多遍"，而是
 * 「体检说这里不对 → 让模型去修 → 重新体检 → 还不对就再来一轮」。
 * 所以每一轮交给模型的输入里都带着上一轮的体检结论。
 *
 * 停止条件是显式的，每一种都对应一件具体的事：
 *
 * - `converged`：体检没有待修项了，收工。
 * - `max-rounds`：轮次用完，但还有问题没修完。
 * - `blocked`：结构审查拦下了这次改动（删锁定节点 / 整篇还原 / 删页面）。
 * - `rejected`：审批钩子否决了这次改动。
 * - `no-changes`：模型没给出任何命令。
 * - `planner-error`：模型调用或计划解析失败。
 * - `execute-error`：命令提交失败。
 * - `cancelled`：用户取消。
 * - `oscillating`：同一个问题反复出现且修不动——模型在原地打转，继续跑只是烧钱。
 *
 * 震荡判定靠**指纹**（来源 + 代码 + 节点 id）：同一个指纹连续出现若干轮就判定
 * 修不动，从待修清单里剔除。剩下的问题全被判死时，循环以 `oscillating` 收尾。
 */

export type LoopStopReason =
  | "converged"
  | "max-rounds"
  | "blocked"
  | "rejected"
  | "no-changes"
  | "planner-error"
  | "execute-error"
  | "cancelled"
  | "oscillating";

/** 循环进度：每个指纹连续出现了多少轮，以及哪些已经判定修不动。 */
export interface LoopProgress {
  repeats: Record<string, number>;
  stuck: string[];
}

export function createLoopProgress(): LoopProgress {
  return { repeats: {}, stuck: [] };
}

export interface LoopDecision {
  action: "plan" | "stop";
  stopReason?: LoopStopReason;
  /** 这一轮要交给模型的待修项（已剔除判定修不动的）。 */
  todo: SelfCheckIssue[];
  /** 更新后的进度。 */
  progress: LoopProgress;
}

/**
 * 决定下一步：继续规划，还是收工。
 *
 * 纯函数——不碰模型、不碰文档，所以停止条件可以单独测。进度（连续出现次数、
 * 修不动的清单）由调用方持有并传进来，函数本身不改调用方的对象。
 */
export function decideNextStep(input: {
  round: number;
  maxRounds: number;
  report: SelfCheckReport;
  progress: LoopProgress;
  oscillationThreshold: number;
}): LoopDecision {
  const threshold = Math.max(1, Math.trunc(input.oscillationThreshold));
  const current = new Set(input.report.fingerprints);

  // 连续出现计数：还在的 +1，已经消失的清零（问题被修掉了就重新开始计数）。
  const repeats: Record<string, number> = { ...input.progress.repeats };
  for (const fingerprint of Object.keys(repeats)) {
    if (!current.has(fingerprint)) delete repeats[fingerprint];
  }
  for (const fingerprint of current) repeats[fingerprint] = (repeats[fingerprint] ?? 0) + 1;

  const stuck = [...current].filter(fingerprint => (repeats[fingerprint] ?? 0) >= threshold).sort();
  const stuckSet = new Set(stuck);
  const todo = input.report.issues.filter(issue => issue.actionable && !stuckSet.has(selfCheckFingerprint(issue)));
  const progress: LoopProgress = { repeats, stuck };

  const stop = (stopReason: LoopStopReason): LoopDecision => ({ action: "stop", stopReason, todo, progress });

  if (input.report.counts.actionable === 0) return stop("converged");
  // 待修项全被判死：模型在原地打转，再跑一轮也不会变好。
  if (!todo.length) return stop("oscillating");
  if (input.round > input.maxRounds) return stop("max-rounds");
  return { action: "plan", todo, progress };
}

export interface AutonomousRound {
  round: number;
  /** 本轮开始时的体检结论。 */
  report: SelfCheckReport;
  /** 本轮交给模型的待修项。 */
  todo: SelfCheckIssue[];
  /** 模型的计划摘要。 */
  summary: string;
  /** 实际落地的命令数。 */
  appliedCommands: number;
  /** 落地之后重新体检的结果。 */
  after?: SelfCheckReport;
  /** 计划里的警告（非阻断项）。 */
  warnings: string[];
  /** 本轮备注：为什么停、审查看到了什么。 */
  note?: string;
}

export interface AutonomousLoopOptions {
  /** 用户的目标；每轮都会带上，模型始终知道自己在为什么目标努力。 */
  goal: string;
  selectedNodeIds?: NodeId[];
  /** 最多跑几轮（每轮一次模型调用）；缺省 6。 */
  maxRounds?: number;
  /** 同一个问题连续出现多少轮就判定为「修不动」；缺省 3。 */
  oscillationThreshold?: number;
  /** 体检层的选项（栅格、导出诊断、资源解析器）。 */
  selfCheck?: SelfCheckOptions;
  signal?: AbortSignalLike;
  onDelta?(delta: string, fullText: string): void;
  /** 每轮结束后回调，用于界面上的轮次日志。 */
  onRound?(round: AutonomousRound): void;
  /**
   * 额外审批闸门。
   *
   * 结构审查拦下的计划不会走到这里；这个钩子给界面用（例如"批量删除要人确认"）。
   * 返回 false 会中止整个循环。
   */
  approve?(plan: AiPlanPreview): boolean;
}

export interface AutonomousLoopResult {
  stopReason: LoopStopReason;
  message: string;
  rounds: AutonomousRound[];
  /** 结束时的体检结论。 */
  report: SelfCheckReport;
  /** 累计落地的命令数。 */
  appliedCommands: number;
  /** 判定为修不动的问题。 */
  stuck: string[];
}

/**
 * 跑一轮自主编排。
 *
 * 每轮的改动都走正常事务（`SafeAiEditor.confirm`），因此**每一轮都能单独撤销**——
 * 跑了六轮想退回第三轮，撤销三次即可。
 */
export async function runAutonomousLoop(editor: SafeAiEditor, options: AutonomousLoopOptions): Promise<AutonomousLoopResult> {
  const goal = options.goal.trim();
  if (!goal) throw new Error("自主运行需要一个目标描述");
  const maxRounds = Math.max(1, Math.trunc(options.maxRounds ?? 6));
  const threshold = Math.max(1, Math.trunc(options.oscillationThreshold ?? 3));
  const selectedNodeIds = options.selectedNodeIds ?? [];

  let progress = createLoopProgress();
  let report = collectSelfCheck(editor.snapshot(), options.selfCheck);
  const rounds: AutonomousRound[] = [];
  let appliedCommands = 0;
  let round = 0;

  const finish = (stopReason: LoopStopReason, note?: string): AutonomousLoopResult => ({
    stopReason,
    message: describeStop(stopReason, { goal, maxRounds, report, stuck: progress.stuck, appliedCommands, note }),
    rounds,
    report,
    appliedCommands,
    stuck: progress.stuck,
  });

  /** 记一轮并通知界面。停止的那一轮也要进日志——用户要知道它是第几轮停的。 */
  const pushRound = (record: AutonomousRound): void => {
    rounds.push(record);
    options.onRound?.(record);
  };

  for (;;) {
    round += 1;
    if (options.signal?.aborted) return finish("cancelled");

    const decision = decideNextStep({ round, maxRounds, report, progress, oscillationThreshold: threshold });
    progress = decision.progress;
    if (decision.action === "stop") return finish(decision.stopReason as LoopStopReason);

    const note = buildRoundNote(goal, round, maxRounds, rounds);
    const context: SelfCheckContext = { report, stuck: progress.stuck, note };

    let plan: AiPlanPreview;
    try {
      plan = await editor.createPlan(goal, selectedNodeIds, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onDelta ? { onDelta: options.onDelta } : {}),
        selfCheck: context,
        selfCheckRound: round,
      });
    } catch (error) {
      // 模型明确表示「没有要改的」：不是故障，是合法结论。
      if (error instanceof PlanEmptyError) {
        pushRound({ round, report, todo: decision.todo, summary: "模型没有给出可执行的改动", appliedCommands: 0, warnings: [], note: "模型认为没有要改的东西" });
        return finish("no-changes");
      }
      if (options.signal?.aborted) return finish("cancelled");
      pushRound({ round, report, todo: decision.todo, summary: "模型调用失败", appliedCommands: 0, warnings: [], note: errorMessage(error) });
      return finish("planner-error", errorMessage(error));
    }

    if (plan.review.blocking) {
      const blocking = plan.review.findings.filter(finding => finding.severity === "blocking").map(finding => finding.message).join("；");
      pushRound({ round, report, todo: decision.todo, summary: plan.summary, appliedCommands: 0, warnings: plan.warnings, note: `结构审查阻断：${blocking}` });
      editor.cancel(plan.planId);
      return finish("blocked", blocking);
    }

    if (options.approve && !options.approve(plan)) {
      pushRound({ round, report, todo: decision.todo, summary: plan.summary, appliedCommands: 0, warnings: plan.warnings, note: "审批未通过" });
      editor.cancel(plan.planId);
      return finish("rejected");
    }

    try {
      await editor.confirm(plan.planId);
    } catch (error) {
      pushRound({ round, report, todo: decision.todo, summary: plan.summary, appliedCommands: 0, warnings: plan.warnings, note: `提交失败：${errorMessage(error)}` });
      return finish("execute-error", errorMessage(error));
    }

    appliedCommands += plan.commands.length;
    const after = collectSelfCheck(editor.snapshot(), options.selfCheck);
    pushRound({ round, report, todo: decision.todo, summary: plan.summary, appliedCommands: plan.commands.length, after, warnings: plan.warnings });
    report = after;
  }
}

/**
 * 这一轮给模型的补充说明。
 *
 * 放在体检结论里而不是塞进「用户需求」——用户需求是用户说的话，不该被改写；
 * 轮次上下文是系统的话，混在一起模型会分不清哪句是命令、哪句是现状。
 */
function buildRoundNote(goal: string, round: number, maxRounds: number, rounds: AutonomousRound[]): string {
  const lines = [`本轮（第 ${round}/${maxRounds} 轮）目标：针对下面列出的待修项逐项修复。`];
  const previous = rounds[rounds.length - 1];
  if (previous) {
    lines.push(`上一轮做了：${previous.summary}（落地 ${previous.appliedCommands} 条命令）。`);
    const before = previous.report.counts.actionable;
    const after = previous.after?.counts.actionable ?? before;
    if (after < before) lines.push(`重新体检后还剩 ${after} 项待修（比上一轮少 ${before - after} 项）。`);
    else if (after > before) lines.push(`重新体检后还剩 ${after} 项待修（比上一轮多了 ${after - before} 项，注意别改出新问题）。`);
    else lines.push(`重新体检后仍是 ${after} 项待修，没有减少——换个思路，或者这个问题改不动。`);
  } else {
    lines.push(`这是第一次体检之后的第一个改动轮次。`);
  }
  return lines.join("\n");
}

function describeStop(
  stopReason: LoopStopReason,
  context: { goal: string; maxRounds: number; report: SelfCheckReport; stuck: string[]; appliedCommands: number; note?: string },
): string {
  const remaining = context.report.counts.actionable;
  const suffix = context.note ? `：${context.note}` : "";
  switch (stopReason) {
    case "converged":
      return `体检没有待修项了，编排循环已收敛（累计落地 ${context.appliedCommands} 条命令）。`;
    case "max-rounds":
      return `达到轮次上限 ${context.maxRounds}，停止；还有 ${remaining} 项待修没修完。`;
    case "blocked":
      return `结构审查拦下了这次改动${suffix}`;
    case "rejected":
      return "这次改动没有通过审批，循环已停止。";
    case "no-changes":
      return "模型没有给出可执行的改动，循环已停止。";
    case "planner-error":
      return `调用模型失败${suffix}`;
    case "execute-error":
      return `提交命令失败${suffix}`;
    case "cancelled":
      return "已取消自主运行。";
    case "oscillating":
      return `反复修不动的问题被判为无解，循环已停止：${context.stuck.join("、") || "（无）"}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
