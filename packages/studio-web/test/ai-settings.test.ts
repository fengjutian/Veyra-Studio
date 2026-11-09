import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SETTINGS_KEY,
  AI_SETTINGS_SESSION_KEY,
  activeApiKey,
  aiSettingsComplete,
  clearAiSettings,
  DEFAULT_AI_SETTINGS,
  maskApiKey,
  readAiSettings,
  writeAiSettings,
  type AiSettings,
  type AiSettingsStorage,
} from "../src/ai-settings";

class MemoryStorage implements AiSettingsStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function stores() {
  return { persistent: new MemoryStorage(), session: new MemoryStorage() };
}

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return { ...DEFAULT_AI_SETTINGS, apiKeys: [], activeKeyIndex: 0, ...overrides };
}

test("without stored settings the app stays on the demo planner", () => {
  const { persistent, session } = stores();
  assert.deepEqual(readAiSettings(persistent, session), DEFAULT_AI_SETTINGS);
  assert.equal(aiSettingsComplete(readAiSettings(persistent, session)), false);
});

test("settings round-trip, with the key kept out of localStorage", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: true, baseUrl: " http://localhost:11434/v1 ", model: " qwen2.5 ", apiKeys: [" sk-secret "], activeKeyIndex: 0 }), persistent, session);

  const read = readAiSettings(persistent, session);
  assert.equal(read.enabled, true);
  assert.equal(read.baseUrl, "http://localhost:11434/v1");
  assert.equal(read.model, "qwen2.5");
  assert.deepEqual(read.apiKeys, ["sk-secret"]);
  assert.equal(activeApiKey(read), "sk-secret");
  assert.equal(aiSettingsComplete(read), true);

  // Disk copy must not contain the secret: neither the field name nor the value.
  const persisted = persistent.getItem(AI_SETTINGS_KEY) ?? "";
  assert.doesNotMatch(persisted, /apiKey/);
  assert.doesNotMatch(persisted, /sk-secret/);
  assert.match(session.getItem(AI_SETTINGS_SESSION_KEY) ?? "", /sk-secret/);
});

test("密钥环：多把密钥都在，当前下标也保住", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: true, baseUrl: "https://api.example.test/v1", model: "m", apiKeys: ["k1", "k2", "k3"], activeKeyIndex: 2 }), persistent, session);

  const read = readAiSettings(persistent, session);
  assert.deepEqual(read.apiKeys, ["k1", "k2", "k3"]);
  assert.equal(read.activeKeyIndex, 2);
  assert.equal(activeApiKey(read), "k3");
});

test("当前下标越界时回落到最后一把，不越界", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ apiKeys: ["k1", "k2"], activeKeyIndex: 9 }), persistent, session);
  const read = readAiSettings(persistent, session);
  assert.equal(read.activeKeyIndex, 1);
  assert.equal(activeApiKey(read), "k2");
});

test("a new browser session keeps the config but loses the keys", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: true, baseUrl: "https://api.example.test/v1", model: "m", apiKeys: ["sk"] }), persistent, session);

  const nextTab = new MemoryStorage();
  const read = readAiSettings(persistent, nextTab);
  assert.equal(read.baseUrl, "https://api.example.test/v1");
  assert.equal(read.model, "m");
  assert.deepEqual(read.apiKeys, []);
  assert.equal(activeApiKey(read), "");
  assert.equal(aiSettingsComplete(read), true);
});

test("clearing removes both halves", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeys: ["sk"] }), persistent, session);
  clearAiSettings(persistent, session);
  assert.equal(persistent.getItem(AI_SETTINGS_KEY), null);
  assert.equal(session.getItem(AI_SETTINGS_SESSION_KEY), null);
  assert.deepEqual(readAiSettings(persistent, session), DEFAULT_AI_SETTINGS);
});

test("legacy settings with a stored key are migrated and scrubbed", () => {
  const { persistent } = stores();
  persistent.setItem(AI_SETTINGS_KEY, JSON.stringify({ enabled: true, baseUrl: "https://legacy.test/v1", model: "old-model", apiKey: "legacy-key" }));
  const session = new MemoryStorage();

  const read = readAiSettings(persistent, session);
  assert.deepEqual(read.apiKeys, ["legacy-key"]);
  assert.match(session.getItem(AI_SETTINGS_SESSION_KEY) ?? "", /legacy-key/);

  // Migration must remove the secret from the disk copy but keep the config.
  const scrubbed = persistent.getItem(AI_SETTINGS_KEY) ?? "";
  assert.doesNotMatch(scrubbed, /apiKey/);
  assert.doesNotMatch(scrubbed, /legacy-key/);
  assert.equal(readAiSettings(persistent, session).baseUrl, "https://legacy.test/v1");
});

test("会话里的旧格式（裸密钥字符串）也能读出来", () => {
  const { persistent, session } = stores();
  session.setItem(AI_SETTINGS_SESSION_KEY, "bare-key");
  const read = readAiSettings(persistent, session);
  assert.deepEqual(read.apiKeys, ["bare-key"]);
  assert.equal(activeApiKey(read), "bare-key");
});

test("saving an empty keyring drops the session secret", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "m", apiKeys: ["sk"] }), persistent, session);
  writeAiSettings(settings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "m", apiKeys: [] }), persistent, session);
  assert.equal(session.getItem(AI_SETTINGS_SESSION_KEY), null);
  assert.deepEqual(readAiSettings(persistent, session).apiKeys, []);
});

test("the real model is only used when it is explicitly enabled", () => {
  const { persistent, session } = stores();
  writeAiSettings(settings({ enabled: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeys: ["sk"] }), persistent, session);
  assert.equal(aiSettingsComplete(readAiSettings(persistent, session)), false);
});

test("corrupted stored settings fall back to the defaults", () => {
  const { persistent, session } = stores();
  persistent.setItem(AI_SETTINGS_KEY, "{not json");
  assert.deepEqual(readAiSettings(persistent, session), DEFAULT_AI_SETTINGS);
});

test("密钥的显示形式只露头尾", () => {
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey("short"), "•••••");
  // 用一个明显是假的密钥：真密钥长得像 sk-cp-xxx，测试里不要放那种形状的字符串，
  // 否则仓库里的密钥扫描器会把它当成泄露。
  const masked = maskApiKey("example-key-abcdefghijklmnop");
  assert.ok(masked.startsWith("exampl"));
  assert.ok(masked.endsWith("mnop"));
  assert.ok(!masked.includes("ghijkl"));
});
