import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import type { ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { StudioProject } from "@ufira/studio-application";
import {
  AiCancelledError,
  SafeAiEditor,
  createOpenAiCompatiblePlanner,
  type AbortSignalLike,
  type AiPlanRequest,
  type AiPlanner,
  type FetchLike,
  type FetchResponseLike,
} from "../src/index";

const request: AiPlanRequest = {
  prompt: "创建一个卡片",
  document: createDocument("doc:1", "测试文档", "page:1"),
  selectedNodeIds: [],
};

const planJson = JSON.stringify({ summary: "流式计划", commands: [{ type: "document.rename", payload: { name: "x" } }] });

function sseEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/** 把 SSE 文本按固定字节切片喂给 reader，验证跨 chunk 的行缓冲。 */
function streamingResponse(events: string[], sliceSize = 17): FetchResponseLike {
  const bytes = new TextEncoder().encode(events.join(""));
  let offset = 0;
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true };
          const value = bytes.slice(offset, offset + sliceSize);
          offset += sliceSize;
          return { done: false, value };
        },
      }),
    },
  };
}

test("streams deltas in order and still returns a parsed plan", async () => {
  const parts = [planJson.slice(0, 12), planJson.slice(12, 40), planJson.slice(40)];
  const fetchMock: FetchLike = async () => streamingResponse([...parts.map(sseEvent), "data: [DONE]\n\n"]);
  const deltas: string[] = [];
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, stream: true });

  const plan = await planner.plan({ ...request, onDelta: (delta, full) => { deltas.push(delta); assert.equal(full.endsWith(delta), true); } });

  assert.equal(plan.summary, "流式计划");
  assert.deepEqual(deltas, parts);
});

test("ignores heartbeats and unparsable events", async () => {
  const fetchMock: FetchLike = async () => streamingResponse([
    ": keep-alive\n\n",
    "event: message\n",
    sseEvent(planJson),
    "data: not-json\n\n",
    "data: [DONE]\n\n",
  ]);
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, stream: true });
  const plan = await planner.plan(request);
  assert.equal(plan.summary, "流式计划");
});

test("falls back to the plain body when the response has no stream", async () => {
  const fetchMock: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: planJson } }] }),
  });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, stream: true });
  const plan = await planner.plan(request);
  assert.equal(plan.summary, "流式计划");
});

test("cancelling mid-stream stops with AiCancelledError", async () => {
  const controller = new AbortController();
  const fetchMock: FetchLike = (_url, init) => Promise.resolve({
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader: () => ({
        read: () => new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignalLike | undefined;
          signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => controller.abort(), 5);
        }),
      }),
    },
  });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, stream: true, retries: 3, retryDelayMs: 0 });
  await assert.rejects(planner.plan({ ...request, signal: controller.signal }), AiCancelledError);
});

test("forwards the delta callback through SafeAiEditor", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  let received: string[] = [];
  const planner: AiPlanner = {
    async plan(planRequest) {
      planRequest.onDelta?.("half", "half");
      return { summary: "s", commands: [{ type: "document.rename", payload: { name: "x" } }] };
    },
  };
  const editor = new SafeAiEditor(project, planner);
  await editor.createPlan("rename", [], { onDelta: (delta, full) => { received.push(`${delta}|${full}`); } });
  assert.deepEqual(received, ["half|half"]);
});

class MemoryRepository implements ProjectRepository {
  document?: import("@ufira/design-schema").DesignDocument;
  async open(): Promise<ProjectSnapshot> { throw new Error("not used"); }
  async saveSnapshot(document: import("@ufira/design-schema").DesignDocument): Promise<void> { this.document = structuredClone(document); }
  async appendTransactions(_entries: TransactionEntry[]): Promise<void> {}
  async listTransactions(): Promise<TransactionEntry[]> { return []; }
  async replaceProject(): Promise<void> {}
  async listProjects(): Promise<ProjectSummary[]> { return []; }
  async deleteProject(): Promise<void> {}
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(): Promise<SnapshotSummary[]> { return []; }
  async readSnapshot(_projectId: string, revision: number): Promise<import("@ufira/design-schema").DesignDocument> { throw new SnapshotNotFoundError("project:1", revision); }
  async putAsset(): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(): Promise<ProjectSnapshot> { throw new Error("not used"); }
}
