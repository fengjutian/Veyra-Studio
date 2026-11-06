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
