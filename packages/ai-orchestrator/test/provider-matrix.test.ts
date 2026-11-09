import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_CAPABILITIES,
  PROVIDER_PRESETS,
  capabilityLabels,
  describeProvider,
  matchProvider,
  normalizeBaseUrl,
} from "../src/index";

test("presets have unique ids and normalized base urls", () => {
  const ids = PROVIDER_PRESETS.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(preset.baseUrl, normalizeBaseUrl(preset.baseUrl), `${preset.id} 的地址未归一化`);
    assert.ok(preset.defaultModel.length > 0);
    assert.ok(preset.note.length > 0);
  }
});

test("normalizes case, whitespace and trailing slashes", () => {
  assert.equal(normalizeBaseUrl("  HTTPS://API.OpenAI.com/v1/  "), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1///"), "http://localhost:11434/v1");
});

test("matches known providers with or without trailing slash", () => {
  assert.equal(matchProvider("https://api.openai.com/v1")?.id, "openai");
  assert.equal(matchProvider("https://api.openai.com/v1/")?.id, "openai");
  assert.equal(matchProvider(" https://api.deepseek.com/v1 ")?.id, "deepseek");
  assert.equal(matchProvider("http://localhost:11434/v1")?.id, "ollama");
});

test("matches proxied paths under a known prefix", () => {
  assert.equal(matchProvider("https://api.openai.com/v1/proxy/team")?.id, "openai");
  assert.equal(matchProvider("http://localhost:11434/v1/chat")?.id, "ollama");
});

test("unknown or empty endpoints stay unmatched", () => {
  assert.equal(matchProvider("https://gateway.example.test/v1"), undefined);
  assert.equal(matchProvider(""), undefined);
});

test("unknown endpoints fall back to conservative capabilities", () => {
  const description = describeProvider("https://gateway.example.test/v1");
  assert.equal(description.id, "custom");
  assert.equal(description.matched, false);
  assert.deepEqual(description.capabilities, FALLBACK_CAPABILITIES);
  // 保守默认：不假设 json 模式，但保留流式。
  assert.equal(description.capabilities.jsonMode, false);
  assert.equal(description.capabilities.stream, true);
});

test("known providers report their documented capabilities", () => {
  assert.deepEqual(describeProvider("https://api.openai.com/v1").capabilities, { jsonMode: true, stream: true, auth: "bearer" });
  assert.deepEqual(describeProvider("http://localhost:11434/v1").capabilities, { jsonMode: false, stream: true, auth: "none" });
});

test("capability labels describe stream, json and auth", () => {
  assert.deepEqual(capabilityLabels({ jsonMode: true, stream: true, auth: "bearer" }), ["流式", "JSON 模式", "Bearer 鉴权"]);
  assert.deepEqual(capabilityLabels({ jsonMode: false, stream: false, auth: "none" }), ["非流式", "纯文本输出", "免鉴权"]);
});

test("看图能力：没验过就不标，验过才标", () => {
  // 没验过的端点不能标成「不支持看图」——它可能只是没验。
  assert.deepEqual(capabilityLabels({ jsonMode: true, stream: true, auth: "bearer" }), ["流式", "JSON 模式", "Bearer 鉴权"]);
  assert.deepEqual(capabilityLabels({ jsonMode: true, stream: true, auth: "bearer", vision: true }), ["流式", "JSON 模式", "Bearer 鉴权", "支持看图"]);
  assert.deepEqual(capabilityLabels({ jsonMode: true, stream: true, auth: "bearer", vision: false }), ["流式", "JSON 模式", "Bearer 鉴权", "不支持看图"]);
});

test("实测记录里的看图能力会盖过预设", () => {
  // MiniMax 有实测记录：结论以实测为准。
  const description = describeProvider("https://api.minimaxi.com/v1");
  assert.equal(description.verified, true);
  assert.equal(description.capabilities.vision, true);
  // 没实测过的端点：预设里没写看图能力 → 不标。
  assert.equal(describeProvider("https://api.openai.com/v1").capabilities.vision, undefined);
});
