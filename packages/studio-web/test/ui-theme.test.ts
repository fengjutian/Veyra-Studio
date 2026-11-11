import assert from "node:assert/strict";
import test from "node:test";
import { applyUiTheme, readUiTheme, UI_THEME_STORAGE_KEY, writeUiTheme } from "../src/ui-theme";

test("reads an explicit theme and defaults to light", () => {
  assert.equal(readUiTheme({ getItem: () => "light" }), "light");
  assert.equal(readUiTheme({ getItem: () => "dark" }), "dark");
  assert.equal(readUiTheme({ getItem: () => "system" }), "light");
  assert.equal(readUiTheme({ getItem: () => null }), "light");
});

test("persists and applies the selected UI theme", () => {
  let saved: [string, string] | undefined;
  writeUiTheme("light", { setItem: (key, value) => { saved = [key, value]; } });
  assert.deepEqual(saved, [UI_THEME_STORAGE_KEY, "light"]);

  const root = { dataset: {}, style: {} } as unknown as HTMLElement;
  applyUiTheme("light", root);
  assert.equal(root.dataset.uiTheme, "light");
  assert.equal(root.style.colorScheme, "light");
});

test("storage failures do not prevent startup or switching", () => {
  assert.equal(readUiTheme({ getItem: () => { throw new Error("blocked"); } }), "light");
  assert.doesNotThrow(() => writeUiTheme("light", { setItem: () => { throw new Error("blocked"); } }));
});
