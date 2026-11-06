import assert from "node:assert/strict";
import test from "node:test";
import { AI_SETTINGS_KEY, aiSettingsComplete, clearAiSettings, DEFAULT_AI_SETTINGS, readAiSettings, writeAiSettings, type AiSettingsStorage } from "../src/ai-settings";

class MemoryStorage implements AiSettingsStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("without stored settings the app stays on the demo planner", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readAiSettings(storage), DEFAULT_AI_SETTINGS);
  assert.equal(aiSettingsComplete(readAiSettings(storage)), false);
});

test("settings round-trip through storage", () => {
  const storage = new MemoryStorage();
  writeAiSettings({ enabled: true, baseUrl: " http://localhost:11434/v1 ", model: " qwen2.5 ", apiKey: " key " }, storage);
  const read = readAiSettings(storage);
  assert.equal(read.enabled, true);
  assert.equal(read.baseUrl, "http://localhost:11434/v1");
  assert.equal(read.model, "qwen2.5");
  assert.equal(read.apiKey, "key");
  assert.equal(aiSettingsComplete(read), true);
});

test("the real model is only used when it is explicitly enabled", () => {
  const storage = new MemoryStorage();
  writeAiSettings({ enabled: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk" }, storage);
  assert.equal(aiSettingsComplete(readAiSettings(storage)), false);
});

test("clearing removes the stored settings and falls back to the demo planner", () => {
  const storage = new MemoryStorage();
  writeAiSettings({ enabled: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk" }, storage);
  clearAiSettings(storage);
  assert.equal(storage.getItem(AI_SETTINGS_KEY), null);
  assert.deepEqual(readAiSettings(storage), DEFAULT_AI_SETTINGS);
});

test("corrupted stored settings fall back to the defaults", () => {
  const storage = new MemoryStorage();
  storage.setItem(AI_SETTINGS_KEY, "{not json");
  assert.deepEqual(readAiSettings(storage), DEFAULT_AI_SETTINGS);
});
