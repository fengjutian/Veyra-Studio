import assert from "node:assert/strict";
import test from "node:test";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import {
  SafeAiEditor,
  collectSelfCheck,
  decideNextStep,
  formatSelfCheckForPrompt,
  runAutonomousLoop,
  type AiPlanRequest,
  type AiPlanner,
  type LoopProgress,
  type SelfCheckReport,
} from "../src/index";

/** 低对比度的文本节点：#999999 压在白底上，对比度约 2.86:1，低于 4.5 阈值。 */
const lowContrastText = (): DesignNode => ({
  id: "text:low",
  type: "text",
  name: "标题",
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), x: 16, y: 16, width: 200, height: 40 },
  appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#999999" }] },
  text: "对比度不足的标题",
  fontFamily: "Inter",
  fontSize: 16,
  lineHeight: 24,
});

/** 把文本改成深色，落地之后对比度问题消失。 */
const darkenText = {
  type: "node.patch",
  payload: {
    id: "text:low",
    patch: { appearance: { opacity: 1, fills: [{ type: "solid", color: "#1f2937" }] } },
  },
} as const;

async function projectWithLowContrastText(): Promise<StudioProject> {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo", "page:1");
  await project.execute({
    commandId: "human:1",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "node.create", payload: { node: lowContrastText() } }],
  });
  return project;
}

/**
 * 造一份报告，只关心指纹与计数。
 *
 * 指纹要能从结论里**反推**出来（`来源:代码#节点`），所以这里按第一个 `:` 与第一个
 * `#` 切分——节点 id 本身带冒号（`frame:1`），按 `:` 切会切错。
 */
function reportOf(fingerprints: string[]): SelfCheckReport {
  const issues = fingerprints.map(fingerprint => {
    const colon = fingerprint.indexOf(":");
    const hash = fingerprint.indexOf("#");
    const source = colon === -1 ? "lint" : fingerprint.slice(0, colon);
    const code = hash === -1 ? fingerprint.slice(colon + 1) : fingerprint.slice(colon + 1, hash);
    const nodeId = hash === -1 ? undefined : fingerprint.slice(hash + 1);
    return {
      source: source as "lint",
      code,
      severity: "warning" as const,
      message: fingerprint,
      ...(nodeId ? { nodeId } : {}),
      actionable: true,
    };
  });
  return {
    issues,
    counts: { error: 0, warning: issues.length, info: 0, actionable: issues.length },
    fingerprints,
  };
}

function progressOf(repeats: Record<string, number> = {}): LoopProgress {
  return { repeats, stuck: [] };
}

test("体检层把对比度不足报成待修项，并给出稳定指纹", async () => {
  const project = await projectWithLowContrastText();
  const report = collectSelfCheck(project.snapshot());

  const contrast = report.issues.find(issue => issue.source === "contrast");
  assert.ok(contrast, "应该报出对比度问题");
  assert.equal(contrast.severity, "error");
  assert.equal(contrast.actionable, true);
  assert.equal(contrast.nodeId, "text:low");
  assert.deepEqual(report.fingerprints, ["contrast:low-contrast#text:low"]);
  assert.equal(report.counts.actionable, 1);
});

test("体检指纹跟着问题走：问题修好就消失，改了就换指纹", async () => {
  const project = await projectWithLowContrastText();
  const before = collectSelfCheck(project.snapshot());
  assert.deepEqual(before.fingerprints, ["contrast:low-contrast#text:low"]);

  await project.execute({
    commandId: "human:2",
    documentId: "project:1",
    baseRevision: project.snapshot().revision,
    actor: { type: "human", id: "user:1" },
    commands: [darkenText as never],
  });

  const after = collectSelfCheck(project.snapshot());
  assert.deepEqual(after.fingerprints, []);
  assert.equal(after.counts.actionable, 0);
});

test("停止条件：没有待修项就收敛", () => {
  const decision = decideNextStep({
    round: 1,
    maxRounds: 6,
    report: reportOf([]),
    progress: progressOf(),
    oscillationThreshold: 3,
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.stopReason, "converged");
});

test("停止条件：有待修项就继续规划", () => {
  const decision = decideNextStep({
    round: 1,
    maxRounds: 6,
    report: reportOf(["lint:off-grid#frame:1"]),
    progress: progressOf(),
    oscillationThreshold: 3,
  });
  assert.equal(decision.action, "plan");
  assert.equal(decision.todo.length, 1);
});

test("停止条件：同一个问题反复出现就判死，待修项全判死时收工", () => {
  const report = reportOf(["lint:off-grid#frame:1"]);
  let progress = progressOf();

  // 第 1 轮：出现一次，还在待修清单里。
  const first = decideNextStep({ round: 1, maxRounds: 6, report, progress, oscillationThreshold: 3 });
  assert.equal(first.action, "plan");
  assert.equal(first.todo.length, 1);
  progress = first.progress;

  // 第 2 轮：连续第二次出现，仍然可以再试一次。
  const second = decideNextStep({ round: 2, maxRounds: 6, report, progress, oscillationThreshold: 3 });
  assert.equal(second.action, "plan");
  assert.equal(second.todo.length, 1);
  progress = second.progress;

  // 第 3 轮：连续第三次出现，判定修不动 —— 待修清单空掉，循环收工。
  const third = decideNextStep({ round: 3, maxRounds: 6, report, progress, oscillationThreshold: 3 });
  assert.equal(third.action, "stop");
  assert.equal(third.stopReason, "oscillating");
  assert.deepEqual(third.progress.stuck, ["lint:off-grid#frame:1"]);
});

test("停止条件：问题修好后计数清零，不会被误判成震荡", () => {
  let progress = progressOf();
  const broken = reportOf(["lint:off-grid#frame:1"]);

  progress = decideNextStep({ round: 1, maxRounds: 6, report: broken, progress, oscillationThreshold: 3 }).progress;
  progress = decideNextStep({ round: 2, maxRounds: 6, report: broken, progress, oscillationThreshold: 3 }).progress;

  // 中间修好了：这一轮报告里没有这个问题。
  const fixed = decideNextStep({ round: 3, maxRounds: 6, report: reportOf([]), progress, oscillationThreshold: 3 });
  assert.equal(fixed.progress.repeats["lint:off-grid#frame:1"], undefined);

  // 之后同一个问题再出现，计数从 1 重新开始，不会直接被判死。
  const again = decideNextStep({ round: 4, maxRounds: 6, report: broken, progress: fixed.progress, oscillationThreshold: 3 });
  assert.equal(again.action, "plan");
  assert.equal(again.progress.stuck.length, 0);
});

test("停止条件：轮次用完就收工，并说明还有多少没修完", () => {
  const decision = decideNextStep({
    round: 7,
    maxRounds: 6,
    report: reportOf(["lint:off-grid#frame:1"]),
    progress: progressOf(),
    oscillationThreshold: 3,
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.stopReason, "max-rounds");
});

test("体检结论会排成给模型看的待修清单，并标出修不动的问题", () => {
  const report = reportOf(["contrast:low-contrast#text:low"]);
  const text = formatSelfCheckForPrompt({ report, stuck: ["contrast:low-contrast#text:low"], note: "上一轮改了标题颜色。" }, { round: 2 });

  assert.match(text, /第 2 轮/);
  assert.match(text, /contrast:low-contrast#text:low/);
  assert.match(text, /上一轮改了标题颜色/);
  assert.match(text, /不要再尝试/);
});

test("编排循环：体检结果回喂给模型，模型按清单改完后收敛", async () => {
  const project = await projectWithLowContrastText();
  const requests: AiPlanRequest[] = [];
  const planner: AiPlanner = {
    async plan(request) {
      requests.push(request);
      return { summary: "把标题改成深色", commands: [darkenText as never] };
    },
  };
  const editor = new SafeAiEditor(project, planner);

  const result = await runAutonomousLoop(editor, { goal: "把这份设计的可访问性问题修掉" });

  assert.equal(result.stopReason, "converged");
  assert.equal(result.rounds.length, 1);
  assert.equal(result.appliedCommands, 1);
  assert.equal(result.report.counts.actionable, 0);
  assert.match(result.message, /收敛/);

  // 模型确实拿到了体检清单，而不是只拿到一句用户需求。
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.selfCheck);
  assert.deepEqual(requests[0]?.selfCheck?.report.fingerprints, ["contrast:low-contrast#text:low"]);
  assert.equal(requests[0]?.selfCheckRound, 1);
  assert.match(requests[0]?.selfCheck?.note ?? "", /第 1\/6 轮/);
});

test("编排循环：结构审查拦下的改动不落地，文档原样不动", async () => {
  const project = await projectWithLowContrastText();
  await project.execute({
    commandId: "human:2",
    documentId: "project:1",
    baseRevision: project.snapshot().revision,
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "node.patch", payload: { id: "text:low", patch: { locked: true } } }],
  });
  const before = project.snapshot();

  const editor = new SafeAiEditor(project, {
    async plan() {
      return { summary: "删掉锁定节点", commands: [{ type: "node.delete", payload: { id: "text:low" } }] };
    },
  });

  const result = await runAutonomousLoop(editor, { goal: "清理设计" });

  assert.equal(result.stopReason, "blocked");
  assert.equal(result.appliedCommands, 0);
  assert.ok(project.snapshot().nodes["text:low"], "锁定节点不能被删掉");
  assert.equal(project.snapshot().revision, before.revision);
});

test("编排循环：模型不给命令时收工，不当成故障", async () => {
  const project = await projectWithLowContrastText();
  const editor = new SafeAiEditor(project, {
    async plan() {
      return { summary: "没什么可改的", commands: [] };
    },
  });

  const result = await runAutonomousLoop(editor, { goal: "修掉可访问性问题" });

  assert.equal(result.stopReason, "no-changes");
  assert.equal(result.appliedCommands, 0);
  assert.equal(project.snapshot().nodes["text:low"]?.appearance.fills?.[0]?.type, "solid");
});

test("编排循环：模型原地打转时以震荡收工，而不是烧满轮次", async () => {
  const project = await projectWithLowContrastText();
  let calls = 0;
  const editor = new SafeAiEditor(project, {
    async plan() {
      calls += 1;
      // 改了文档名，但没碰对比度问题 —— 模型在原地打转。
      return { summary: "改个名字", commands: [{ type: "document.rename", payload: { name: `第 ${calls} 次` } }] };
    },
  });

  const result = await runAutonomousLoop(editor, { goal: "修掉可访问性问题", oscillationThreshold: 3 });

  assert.equal(result.stopReason, "oscillating");
  assert.equal(calls, 2, "判死前只允许模型再试两轮");
  assert.deepEqual(result.stuck, ["contrast:low-contrast#text:low"]);
});

test("编排循环：模型调用失败时如实报出来，不伪装成收敛", async () => {
  const project = await projectWithLowContrastText();
  const editor = new SafeAiEditor(project, {
    async plan() {
      throw new Error("provider exploded");
    },
  });

  const result = await runAutonomousLoop(editor, { goal: "修掉可访问性问题" });

  assert.equal(result.stopReason, "planner-error");
  assert.match(result.message, /provider exploded/);
});

test("编排循环：每一轮都走事务，因此可以逐轮撤销", async () => {
  const project = await projectWithLowContrastText();
  let calls = 0;
  const editor = new SafeAiEditor(project, {
    async plan() {
      calls += 1;
      // 每轮新建一个同样对比度不足的文本节点：问题一直在，循环就会一直跑到轮次上限。
      const node = lowContrastText();
      node.id = `text:gen-${calls}`;
      node.name = `生成 ${calls}`;
      return { summary: `新建文本 ${calls}`, commands: [{ type: "node.create", payload: { node } }] };
    },
  });

  const result = await runAutonomousLoop(editor, { goal: "修掉可访问性问题", maxRounds: 3 });

  assert.equal(result.rounds.length, 3);
  assert.equal(result.appliedCommands, 3);
  assert.equal(project.canUndo(), true);
  assert.ok(project.snapshot().nodes["text:gen-3"], "第三轮新建的节点应当在文档里");

  // 撤销三轮之后，文档回到只有最初那个文本节点的样子。
  await project.undo();
  await project.undo();
  await project.undo();
  assert.equal(project.snapshot().nodes["text:gen-1"], undefined);
  assert.equal(project.snapshot().nodes["text:gen-2"], undefined);
  assert.equal(project.snapshot().nodes["text:gen-3"], undefined);
  assert.ok(project.snapshot().nodes["text:low"], "最初的节点不能被撤销掉");
  assert.equal(
    (project.snapshot().nodes["text:low"]?.appearance.fills?.[0] as { color?: string } | undefined)?.color,
    "#999999",
  );
});

test("编排循环：审批钩子可以否决这次改动", async () => {
  const project = await projectWithLowContrastText();
  const editor = new SafeAiEditor(project, {
    async plan() {
      return { summary: "改深色", commands: [darkenText as never] };
    },
  });

  const result = await runAutonomousLoop(editor, {
    goal: "修掉可访问性问题",
    approve: () => false,
  });

  assert.equal(result.stopReason, "rejected");
  assert.equal(result.appliedCommands, 0);
  assert.equal(
    (project.snapshot().nodes["text:low"]?.appearance.fills?.[0] as { color?: string } | undefined)?.color,
    "#999999",
  );
});

class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return {
      document: structuredClone(this.document),
      recoveredFromRevision: this.document.revision,
      replayedTransactions: 0,
      latestKnownRevision: this.document.revision,
      degraded: false,
    };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> { this.document = structuredClone(document); }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> { this.transactions.push(...structuredClone(entries)); }
  async listTransactions(): Promise<TransactionEntry[]> { return structuredClone(this.transactions); }
  async replaceProject(_projectId: string, document: DesignDocument): Promise<void> {
    this.document = structuredClone(document);
    this.transactions = [];
  }
  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.document) return [];
    return [{ id: this.document.id, name: this.document.meta.name, revision: this.document.revision, updatedAt: this.document.meta.updatedAt }];
  }
  async deleteProject(): Promise<void> { this.document = undefined; this.transactions = []; }
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    if (!this.document) return [];
    return [{ revision: this.document.revision, updatedAt: this.document.meta.updatedAt, schemaVersion: this.document.schemaVersion, current: true }];
  }
  async readSnapshot(_projectId: string, revision: number): Promise<DesignDocument> {
    if (!this.document || this.document.revision !== revision) throw new SnapshotNotFoundError("project:1", revision);
    return structuredClone(this.document);
  }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
