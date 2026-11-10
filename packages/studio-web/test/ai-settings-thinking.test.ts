import assert from "node:assert/strict";
import test from "node:test";
import { AI_SETTINGS_KEY, DEFAULT_AI_SETTINGS, clampThinkingMode, readAiSettings, writeAiSettings, type AiSettingsStorage } from "../src/ai-settings";

/**
 * 思考开关的持久化测试。
 *
 * 这个开关决定「推理模型要不要先想一遍」：默认 `auto`（端点自己决定），
 * `off` 才会显式发 `thinking: {type:"disabled"}`。
 * 旧记录没有这个字段时必须落到 `auto`——不能因为新增字段就让老配置读不出来。
 */

function storage(raw?: string): AiSettingsStorage {
  let value = raw ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
  };
}

test("认不得的思考开关值一律当 auto", () => {
  assert.equal(clampThinkingMode("off"), "off");
  assert.equal(clampThinkingMode("auto"), "auto");
  assert.equal(clampThinkingMode(undefined), "auto");
  assert.equal(clampThinkingMode("whatever"), "auto");
  assert.equal(clampThinkingMode(1), "auto");
});

test("旧记录没有思考开关字段时用默认值 auto", () => {
  const legacy = JSON.stringify({ enabled: true, baseUrl: "https://legacy.test/v1", model: "old" });
  assert.equal(readAiSettings(storage(legacy)).thinkingMode, "auto");
});

test("off 会被读回来并原样写回", () => {
  const stored = JSON.stringify({ enabled: true, baseUrl: "https://x.test/v1", model: "m", thinkingMode: "off" });
  const settings = readAiSettings(storage(stored));
  assert.equal(settings.thinkingMode, "off");

  // 写回去之后还得是 "off"——别被归一化成 auto，那等于把用户选的开关悄悄改掉。
  const persistent = storage();
  writeAiSettings(settings, persistent);
  assert.equal(JSON.parse(persistent.getItem(AI_SETTINGS_KEY) ?? "{}").thinkingMode, "off");
});

test("默认配置里的 token 预算够写完一整页计划", () => {
  // 32k 实测会被推理模型的思考吃光，解析器只报「计划缺少 summary」。
  assert.ok(DEFAULT_AI_SETTINGS.maxTokens >= 65_536, "默认 token 预算至少要 64k");
  assert.ok(DEFAULT_AI_SETTINGS.timeoutMs >= 300_000, "默认超时至少要 5 分钟");
});
