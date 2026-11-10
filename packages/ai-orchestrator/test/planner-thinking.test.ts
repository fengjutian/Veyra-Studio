import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { createOpenAiCompatiblePlanner, type AiPlanRequest, type FetchInitLike, type FetchLike, type FetchResponseLike } from "../src/index";

/**
 * 思考开关的往返测试。
 *
 * 为什么要有这个开关：带推理的模型**思考本身**就要吃掉大量 token 与时间。
 * 实测 MiniMax-M3 出一份整页后台管理端计划，思考开着 338 秒还没写完 JSON，
 * 关掉之后 12 秒写完。所以这个参数必须能原样发到端点。
 */

const request: AiPlanRequest = {
  prompt: "加一个卡片",
  document: createDocument("doc:thinking", "测试文档", "page:1"),
  selectedNodeIds: [],
};

function planResponse(): FetchResponseLike {
  // 端点返回的是「一条消息」，计划在 message.content 里——外层要包 choices。
  const content = JSON.stringify({ summary: "s", commands: [{ type: "document.rename", payload: { name: "x" } }] });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

async function bodyOf(options: { thinking?: { type: "adaptive" | "disabled"; budgetTokens?: number } }): Promise<Record<string, unknown>> {
  const calls: Array<{ init?: FetchInitLike }> = [];
  const fetchMock: FetchLike = async (_url, init) => {
    calls.push({ init });
    return planResponse();
  };
  const planner = createOpenAiCompatiblePlanner({
    baseUrl: "https://example.test/v1",
    model: "minimax-test",
    apiKey: "sk-test",
    fetch: fetchMock,
    ...(options.thinking ? { thinking: options.thinking } : {}),
  });
  await planner.plan(request);
  return JSON.parse(calls[0].init!.body!) as Record<string, unknown>;
}

test("默认不带 thinking 参数：端点爱怎么想怎么想", async () => {
  const body = await bodyOf({});
  assert.equal(body.thinking, undefined);
});

test("关掉思考时发出 thinking.type=disabled", async () => {
  const body = await bodyOf({ thinking: { type: "disabled" } });
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("自适应思考时可以带上 token 预算", async () => {
  const body = await bodyOf({ thinking: { type: "adaptive", budgetTokens: 4096 } });
  assert.deepEqual(body.thinking, { type: "adaptive", budget_tokens: 4096 });
});
