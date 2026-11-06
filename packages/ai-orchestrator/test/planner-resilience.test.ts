import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import {
  AiCancelledError,
  AiProviderError,
  AiTimeoutError,
  createOpenAiCompatiblePlanner,
  type AbortSignalLike,
  type AiPlanRequest,
  type FetchLike,
  type FetchResponseLike,
} from "../src/index";

const request: AiPlanRequest = {
  prompt: "添加一个蓝色卡片",
  document: createDocument("doc:1", "测试文档", "page:1"),
  selectedNodeIds: [],
};

const okResponse = (): FetchResponseLike => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "s", commands: [{ type: "document.rename", payload: { name: "x" } }] }) } }] }),
});

const failure = (status: number): FetchResponseLike => ({ ok: false, status, text: async () => "upstream error" });

test("retries transient upstream failures and then succeeds", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => {
    calls += 1;
    return calls < 3 ? failure(503) : okResponse();
  };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, retries: 3, retryDelayMs: 0 });
  const plan = await planner.plan(request);
  assert.equal(plan.summary, "s");
  assert.equal(calls, 3);
});

test("retries 429 but not other 4xx", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => {
    calls += 1;
    return calls === 1 ? failure(429) : okResponse();
  };
  await createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, retries: 2, retryDelayMs: 0 }).plan(request);
  assert.equal(calls, 2);

  let authCalls = 0;
  const unauthorized: FetchLike = async () => { authCalls += 1; return failure(401); };
  await assert.rejects(
    createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: unauthorized, retries: 3, retryDelayMs: 0 }).plan(request),
    (error: unknown) => error instanceof AiProviderError && error.status === 401,
  );
  assert.equal(authCalls, 1);
});

test("gives up after the retry budget and keeps the status code", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => { calls += 1; return failure(500); };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, retries: 2, retryDelayMs: 0 });
  await assert.rejects(planner.plan(request), (error: unknown) => error instanceof AiProviderError && error.status === 500);
  assert.equal(calls, 3);
});

test("times out with a dedicated error and does not retry", async () => {
  let calls = 0;
  const fetchMock: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
    calls += 1;
    const signal = init?.signal as AbortSignalLike | undefined;
    signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, timeoutMs: 20, retries: 3, retryDelayMs: 0 });
  await assert.rejects(planner.plan(request), AiTimeoutError);
  assert.equal(calls, 1);
});

test("cancelling during the request stops it with AiCancelledError", async () => {
  const controller = new AbortController();
  const fetchMock: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignalLike | undefined;
    signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    setTimeout(() => controller.abort(), 5);
  });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, retries: 3, retryDelayMs: 0 });
  await assert.rejects(planner.plan({ ...request, signal: controller.signal }), AiCancelledError);
});

test("an already-aborted signal never reaches the network", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => { calls += 1; return okResponse(); };
  const controller = new AbortController();
  controller.abort();
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock });
  await assert.rejects(planner.plan({ ...request, signal: controller.signal }), AiCancelledError);
  assert.equal(calls, 0);
});

test("network failures retry and surface after the budget", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => { calls += 1; throw new Error("connection refused"); };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", fetch: fetchMock, retries: 1, retryDelayMs: 0 });
  await assert.rejects(planner.plan(request), /connection refused/);
  assert.equal(calls, 2);
});
