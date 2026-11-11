import assert from "node:assert/strict";
import test from "node:test";
import { commitText, textEditAction, textEditBoldShortcut } from "../src/text-edit";

test("enter commits the canvas text edit", () => {
  assert.equal(textEditAction("Enter", false), "commit");
});

test("shift+enter inserts a line break instead of committing", () => {
  assert.equal(textEditAction("Enter", true), "newline");
});

test("escape cancels the canvas text edit", () => {
  assert.equal(textEditAction("Escape", false), "cancel");
});

test("other keys are left to the textarea", () => {
  assert.equal(textEditAction("a", false), undefined);
  assert.equal(textEditAction("Tab", false), undefined);
  assert.equal(textEditAction("Backspace", true), undefined);
});

test("an unchanged draft is not committed", () => {
  assert.equal(commitText("标题", "标题"), undefined);
});

test("a changed draft is committed verbatim", () => {
  assert.equal(commitText("标题", "新的标题"), "新的标题");
});

test("an emptied draft is committed as an empty text", () => {
  assert.equal(commitText("标题", ""), "");
});

test("ctrl/cmd+b is the bold shortcut for the selected text", () => {
  assert.equal(textEditBoldShortcut("b", true), true);
  assert.equal(textEditBoldShortcut("B", true), true);
  // 没有修饰键就是普通的打字。
  assert.equal(textEditBoldShortcut("b", false), false);
  assert.equal(textEditBoldShortcut("i", true), false);
});
