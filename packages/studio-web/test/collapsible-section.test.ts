import assert from "node:assert/strict";
import test from "node:test";
import { COLLAPSIBLE_SECTION_STORAGE_KEY, readSectionState, writeSectionState } from "../src/ui/collapsible-section";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(COLLAPSIBLE_SECTION_STORAGE_KEY, initial);
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

test("property section state persists independently", () => {
  const storage = memoryStorage();
  writeSectionState("layout", false, storage);
  writeSectionState("appearance", true, storage);
  assert.deepEqual(readSectionState(storage), { layout: false, appearance: true });
});

test("invalid persisted section state safely falls back", () => {
  assert.deepEqual(readSectionState(memoryStorage("not-json")), {});
  assert.deepEqual(readSectionState(memoryStorage("[]")), {});
});
