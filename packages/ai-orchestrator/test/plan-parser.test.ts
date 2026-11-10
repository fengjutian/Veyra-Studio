import assert from "node:assert/strict";
import test from "node:test";
import { PlanParseError, parsePlanResponse } from "../src/index";

test("parses a plain JSON plan", () => {
  const plan = parsePlanResponse(JSON.stringify({
    summary: "把标题改成红色",
    assumptions: ["沿用当前字体"],
    commands: [{ type: "node.patch", payload: { id: "frame:1", patch: { name: "标题" } } }],
  }));
  assert.equal(plan.summary, "把标题改成红色");
  assert.deepEqual(plan.assumptions, ["沿用当前字体"]);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].type, "node.patch");
});

test("strips code fences and surrounding prose", () => {
  const raw = "好的，计划如下：\n```json\n{\"summary\":\"改名\",\"commands\":[{\"type\":\"document.rename\",\"payload\":{\"name\":\"新名字\"}}]}\n```\n需要我继续吗？";
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "改名");
  assert.equal(plan.commands[0].type, "document.rename");
});

test("keeps braces that live inside strings", () => {
  const raw = '{"summary":"带 } 的摘要","commands":[{"type":"text.patch","payload":{"id":"text:1","patch":{"text":"a}b{c"}}}]}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "带 } 的摘要");
  assert.deepEqual((plan.commands[0] as { payload: { patch: { text: string } } }).payload.patch, { text: "a}b{c" });
});

test("handles escaped quotes inside strings", () => {
  const raw = '{"summary":"引号 \\" 也要正常","commands":[{"type":"text.patch","payload":{"id":"text:1","patch":{"text":"say \\"hi\\""}}}]}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, '引号 " 也要正常');
});

test("rejects command types outside the vocabulary", () => {
  assert.throws(
    () => parsePlanResponse('{"summary":"s","commands":[{"type":"node.explode","payload":{}}]}'),
    /不在允许的词汇表/,
  );
});

test("rejects empty command lists and missing summaries", () => {
  assert.throws(() => parsePlanResponse('{"summary":"s","commands":[]}'), /没有包含任何命令/);
  assert.throws(() => parsePlanResponse('{"commands":[{"type":"document.rename","payload":{}}]}'), /缺少 summary/);
  assert.throws(() => parsePlanResponse('{"summary":"s","commands":[{"type":"document.rename"}]}'), /缺少 payload/);
});

test("rejects replies without any JSON object", () => {
  assert.throws(() => parsePlanResponse("我不知道怎么做"), PlanParseError);
  assert.throws(() => parsePlanResponse(""), PlanParseError);
});

test("推理块里的 JSON 碎片不会把真计划顶掉", () => {
  // 推理模型常常在 `<think>` 里先写一个自己的草稿对象。那也是合法 JSON，
  // 但不是计划——早先的解析器锁定第一个能 parse 的候选，真计划根本没机会被看到。
  const raw = '<think>先想想 {"reasoning": "打算建三个节点"}</think>\n\n{"summary":"搭一张登录卡片","commands":[{"type":"document.rename","payload":{"name":"登录页"}}]}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "搭一张登录卡片");
  assert.equal(plan.commands[0].type, "document.rename");
});

test("推理块没闭合时也能从原文里找回计划", () => {
  const raw = '<think>{"draft": true} 还没想完就被截断了\n\n{"summary":"改名","commands":[{"type":"document.rename","payload":{"name":"新名字"}}]}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "改名");
});

test("包装了一层外壳的计划，剥掉外壳后仍能解析", () => {
  const raw = '{"plan": {"summary":"改名","commands":[{"type":"document.rename","payload":{"name":"新名字"}}]}}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "改名");
});

test("回复被截断时，报错要说截断而不是「缺少 summary」", () => {
  // 模型给了计划但没写完（max_tokens 打满）。这时报「缺少 summary」会把排查方向
  // 带偏——真正要调的是 token 预算，不是提示词。
  const truncated = '{"summary":"搭一张登录卡片","commands":[{"type":"node.create","payload":{"node":{"id":"text:login-title"';
  assert.throws(() => parsePlanResponse(truncated), /被截断/);
});

test("整份计划坏掉时，能按命令把能救的救回来", () => {
  // 实测的真实故障：模型在一条命令末尾少写一个 `}`，整份 JSON 就不配平了，
  // 于是这一页几十条命令全部作废。少写括号这种「差一点」不该整页扔掉。
  const command = (id: string): string =>
    JSON.stringify({ type: "node.create", payload: { node: { id, type: "frame" } } });
  // 第 2 条少了最后一个 `}`（模型的经典失误），第 1、3 条是好的。
  const raw = `{"summary":"搭一张用户管理页","commands":[${command("frame:a")},${command("frame:b").slice(0, -1)},${command("frame:c")}]}`;
  const plan = parsePlanResponse(raw);
  assert.equal(plan.commands.length, 3);
  assert.equal(plan.commands[0]!.type, "node.create");
  assert.match(plan.summary, /抢救出 3 条命令/);
  assert.match(plan.summary, /搭一张用户管理页/);
});

test("抢救时 fills 里的 type 不能被当成命令切块", () => {
  // `"type":"solid"` 长得跟命令一样，切块边界认错就会把一条命令切成两半。
  const command = (id: string): string =>
    JSON.stringify({
      type: "node.create",
      payload: { node: { id, type: "frame", appearance: { fills: [{ type: "solid", color: "#ffffff" }] } } },
    });
  const raw = `{"summary":"配色","commands":[${command("frame:a")},${command("frame:b").slice(0, -1)}]}`;
  const plan = parsePlanResponse(raw);
  assert.equal(plan.commands.length, 2);
  const first = plan.commands[0] as { payload: { node: { appearance: { fills: Array<{ type: string }> } } } };
  assert.equal(first.payload.node.appearance.fills[0]!.type, "solid");
});

test("坏得没法救时仍然报错，不返回半截计划", () => {
  // 一条命令都救不出来时，不能给出一份空计划蒙混过关。
  assert.throws(() => parsePlanResponse('{"summary":"s","commands":[{"type":"node.create","payload":{"node":'), PlanParseError);
  assert.throws(() => parsePlanResponse("完全不是 JSON"), PlanParseError);
});

test("正常回复不走抢救路径，摘要保持原样", () => {
  const raw = '{"summary":"改名","commands":[{"type":"document.rename","payload":{"name":"新名字"}}]}';
  const plan = parsePlanResponse(raw);
  assert.equal(plan.summary, "改名");
  assert.deepEqual(plan.assumptions ?? [], []);
});
