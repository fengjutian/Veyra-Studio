import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { createOpenAiCompatiblePlanner, type FetchInitLike, type FetchLike, type FetchResponseLike } from "../src/index";
import type { AiPlanRequest } from "../src/index";

const request: AiPlanRequest = {
  prompt: "添加一个蓝色卡片",
  document: createDocument("doc:1", "测试文档", "page:1"),
  selectedNodeIds: [],
};

function chatResponse(content: unknown): FetchResponseLike {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }) };
}

test("posts an OpenAI-compatible chat completion and returns the parsed plan", async () => {
  const calls: Array<{ url: string; init?: FetchInitLike }> = [];
  const fetchMock: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return chatResponse({ summary: "创建一个蓝色卡片", commands: [{ type: "document.rename", payload: { name: "x" } }] });
  };

  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1/", model: "gpt-test", apiKey: "sk-test", fetch: fetchMock });
  const plan = await planner.plan(request);

  assert.equal(plan.summary, "创建一个蓝色卡片");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");

  const init = calls[0].init!;
  assert.equal(init.method, "POST");
  assert.equal(init.headers?.["Content-Type"], "application/json");
  assert.equal(init.headers?.Authorization, "Bearer sk-test");

  const body = JSON.parse(init.body!) as { model: string; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, "gpt-test");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /node\.create/);
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /添加一个蓝色卡片/);
});

test("omits the authorization header when no key is configured", async () => {
  const calls: Array<{ url: string; init?: FetchInitLike }> = [];
  const fetchMock: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return chatResponse({ summary: "s", commands: [{ type: "document.rename", payload: { name: "x" } }] });
  };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "http://localhost:11434/v1", model: "qwen", fetch: fetchMock });
  await planner.plan(request);
  assert.equal(calls[0].init?.headers?.Authorization, undefined);
});

test("surfaces provider failures with the status code", async () => {
  const fetchMock: FetchLike = async () => ({ ok: false, status: 401, text: async () => "invalid api key" });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "gpt-test", fetch: fetchMock });
  await assert.rejects(planner.plan(request), /401/);
});

test("surfaces network failures", async () => {
  const fetchMock: FetchLike = async () => { throw new Error("connection refused"); };
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "gpt-test", fetch: fetchMock });
  await assert.rejects(planner.plan(request), /connection refused/);
});

test("rejects a plan whose commands are outside the vocabulary", async () => {
  const fetchMock: FetchLike = async () => chatResponse({ summary: "s", commands: [{ type: "node.explode", payload: {} }] });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "gpt-test", fetch: fetchMock });
  await assert.rejects(planner.plan(request), /不在允许的词汇表/);
});

test("rejects a reply without usable content", async () => {
  const fetchMock: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) });
  const planner = createOpenAiCompatiblePlanner({ baseUrl: "https://example.test/v1", model: "gpt-test", fetch: fetchMock });
  await assert.rejects(planner.plan(request), /没有 choices/);
});
