import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SETTINGS_KEY,
  AI_SETTINGS_SESSION_KEY,
  aiSettingsComplete,
  clearAiSettings,
  DEFAULT_AI_SETTINGS,
  readAiSettings,
  writeAiSettings,
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

test("without stored settings the app stays on the demo planner", () => {
  const { persistent, session } = stores();
  assert.deepEqual(readAiSettings(persistent, session), DEFAULT_AI_SETTINGS);
  assert.equal(aiSettingsComplete(readAiSettings(persistent, session)), false);
});

test("settings round-trip, with the key kept out of localStorage", () => {
  const { persistent, session } = stores();
  writeAiSettings({ enabled: true, baseUrl: " http://localhost:11434/v1 ", model: " qwen2.5 ", apiKey: " sk-secret " }, persistent, session);

  const read = readAiSettings(persistent, session);
  assert.equal(read.enabled, true);
  assert.equal(read.baseUrl, "http://localhost:11434/v1");
  assert.equal(read.model, "qwen2.5");
  assert.equal(read.apiKey, "sk-secret");
  assert.equal(aiSettingsComplete(read), true);

  // Disk copy must not contain the secret: neither the field name nor the value.
  const persisted = persistent.getItem(AI_SETTINGS_KEY) ?? "";
  assert.doesNotMatch(persisted, /apiKey/);
  assert.doesNotMatch(persisted, /sk-secret/);
  assert.equal(session.getItem(AI_SETTINGS_SESSION_KEY), "sk-secret");
});

test("a new browser session keeps the config but loses the key", () => {
  const { persistent, session } = stores();
  writeAiSettings({ enabled: true, baseUrl: "https://api.example.test/v1", model: "m", apiKey: "sk" }, persistent, session);

  const nextTab = new MemoryStorage();
  const read = readAiSettings(persistent, nextTab);
  assert.equal(read.baseUrl, "https://api.example.test/v1");
  assert.equal(read.model, "m");
  assert.equal(read.apiKey, "");
  assert.equal(aiSettingsComplete(read), true);
});

test("clearing removes both halves", () => {
  const { persistent, session } = stores();
  writeAiSettings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk" }, persistent, session);
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
  assert.equal(read.apiKey, "legacy-key");
  assert.equal(session.getItem(AI_SETTINGS_SESSION_KEY), "legacy-key");

  // Migration must remove the secret from the disk copy but keep the config.
  const scrubbed = persistent.getItem(AI_SETTINGS_KEY) ?? "";
  assert.doesNotMatch(scrubbed, /apiKey/);
  assert.doesNotMatch(scrubbed, /legacy-key/);
  assert.equal(readAiSettings(persistent, session).baseUrl, "https://legacy.test/v1");
});

test("saving an empty key drops the session secret", () => {
  const { persistent, session } = stores();
  writeAiSettings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "sk" }, persistent, session);
  writeAiSettings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "  " }, persistent, session);
  assert.equal(session.getItem(AI_SETTINGS_SESSION_KEY), null);
  assert.equal(readAiSettings(persistent, session).apiKey, "");
});

test("the real model is only used when it is explicitly enabled", () => {
  const { persistent, session } = stores();
  writeAiSettings({ enabled: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk" }, persistent, session);
  assert.equal(aiSettingsComplete(readAiSettings(persistent, session)), false);
});

test("corrupted stored settings fall back to the defaults", () => {
  const { persistent, session } = stores();
  persistent.setItem(AI_SETTINGS_KEY, "{not json");
  assert.deepEqual(readAiSettings(persistent, session), DEFAULT_AI_SETTINGS);
});