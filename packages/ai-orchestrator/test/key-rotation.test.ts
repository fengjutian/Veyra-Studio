import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { createOpenAiCompatiblePlanner, type AiPlanRequest, type FetchInitLike, type FetchLike, type FetchResponseLike } from "../src/index";

const request: AiPlanRequest = {
  prompt: "添加一个蓝色卡片",
  document: createDocument("doc:1", "测试文档", "page:1"),
  selectedNodeIds: [],
};

function planResponse(): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "ok", commands: [{ type: "document.rename", payload: { name: "x" } }] }) } }] }),
  };
}

function unauthorized(): FetchResponseLike {
  return { ok: false, status: 401, text: async () => "invalid api key" };
}

test("鉴权失败时自动换下一把密钥重试", async () => {
  const authorizations: string[] = [];
  const fetchMock: FetchLike = async (_url, init) => {
    authorizations.push(String(init?.headers?.Authorization ?? ""));
    return authorizations.length === 1 ? unauthorized() : planResponse();
  };
  const rotations: Array<{ index: number; total: number; reason: string }> = [];

  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-old", "sk-new"],
    fetch: fetchMock,
    onKeyRotated: (index, total, reason) => rotations.push({ index, total, reason }),
  });
  const plan = await planner.plan(request);

  assert.equal(plan.summary, "ok");
  assert.deepEqual(authorizations, ["Bearer sk-old", "Bearer sk-new"]);
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]?.index, 1);
  assert.equal(rotations[0]?.total, 2);
  assert.match(rotations[0]?.reason ?? "", /401/);
});

test("环里的密钥全都鉴权失败时，如实报错而不是无限重试", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => {
    calls += 1;
    return unauthorized();
  };
  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-1", "sk-2"],
    retries: 0,
    fetch: fetchMock,
  });

  await assert.rejects(planner.plan(request), /401/);
  assert.equal(calls, 2, "每把密钥各试一次，不多试");
});

test("换钥不影响网络重试的预算", async () => {
  // 第一次 401（换钥），第二次 500（网络错误，可重试），第三次成功。
  const authorizations: string[] = [];
  let calls = 0;
  const fetchMock: FetchLike = async (_url, init) => {
    authorizations.push(String(init?.headers?.Authorization ?? ""));
    calls += 1;
    if (calls === 1) return unauthorized();
    if (calls === 2) return { ok: false, status: 500, text: async () => "boom" };
    return planResponse();
  };

  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-1", "sk-2"],
    retries: 2,
    retryDelayMs: 0,
    fetch: fetchMock,
  });
  const plan = await planner.plan(request);

  assert.equal(plan.summary, "ok");
  assert.deepEqual(authorizations, ["Bearer sk-1", "Bearer sk-2", "Bearer sk-2"]);
});

test("只有一把密钥时，鉴权失败直接报错", async () => {
  let calls = 0;
  const fetchMock: FetchLike = async () => {
    calls += 1;
    return unauthorized();
  };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m", apiKeys: ["sk-1"], retries: 0, fetch: fetchMock });
  await assert.rejects(planner.plan(request), /401/);
  assert.equal(calls, 1);
});

test("空的密钥环被忽略：免鉴权的本地端点照常能调", async () => {
  const inits: Array<FetchInitLike | undefined> = [];
  const fetchMock: FetchLike = async (_url, init) => {
    inits.push(init);
    return planResponse();
  };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "http://localhost:11434/v1", model: "qwen", apiKeys: ["", "  "], fetch: fetchMock });
  const plan = await planner.plan(request);
  assert.equal(plan.summary, "ok");
  assert.equal(inits[0]?.headers?.Authorization, undefined);
});

test("环从指定的那把开始：界面上选了哪把就先用哪把", async () => {
  // 用户在面板上把第 3 把标成「使用中」，请求就必须用第 3 把——
  // 否则面板说的和实际发出去的不是同一件事。
  const authorizations: string[] = [];
  const fetchMock: FetchLike = async (_url, init) => {
    authorizations.push(String(init?.headers?.Authorization ?? ""));
    return planResponse();
  };
  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-1", "sk-2", "sk-3"],
    apiKeyIndex: 2,
    fetch: fetchMock,
  });
  await planner.plan(request);
  assert.deepEqual(authorizations, ["Bearer sk-3"]);
});

test("起点下标越界时夹到最接近的那把，不会发空密钥", async () => {
  // 越界就夹到环里最接近的一把（最后一把）——和设置层存储时的约定一致，
  // 也不会退化成「没带密钥」这种更糟的结果。
  const authorizations: string[] = [];
  const fetchMock: FetchLike = async (_url, init) => {
    authorizations.push(String(init?.headers?.Authorization ?? ""));
    return planResponse();
  };
  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-1", "sk-2"],
    apiKeyIndex: 9,
    fetch: fetchMock,
  });
  await planner.plan(request);
  assert.deepEqual(authorizations, ["Bearer sk-2"]);
});

test("换钥后的那把会被记住：下一次请求直接用它", async () => {
  const authorizations: string[] = [];
  let calls = 0;
  const fetchMock: FetchLike = async (_url, init) => {
    authorizations.push(String(init?.headers?.Authorization ?? ""));
    calls += 1;
    return calls === 1 ? unauthorized() : planResponse();
  };
  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "m",
    apiKeys: ["sk-old", "sk-new"],
    fetch: fetchMock,
  });
  await planner.plan(request);
  await planner.plan(request);
  assert.deepEqual(authorizations, ["Bearer sk-old", "Bearer sk-new", "Bearer sk-new"]);
});
