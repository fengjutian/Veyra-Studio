import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, type DesignDocument, type Theme } from "@ufira/design-schema";
import { CommandError, DesignRuntime } from "../src/index";

/** 主题命令：新增 / 替换 / 删除，以及「只能覆盖已有 token」的边界。 */

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

function runtimeWithToken(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "token.upsert", payload: { name: "gray.900", token: { type: "color", value: "#111111" } } }]));
  return runtime;
}

const dark: Theme = { id: "theme:dark", name: "深色", tokens: { "gray.900": { type: "color", value: "#f5f5f5" } } };

test("theme.upsert: 新增主题并保留顺序", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: dark } }]));
  assert.deepEqual(runtime.snapshot().themes, [dark]);
});

test("theme.upsert: 同一 id 覆盖，不重复插入", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: dark } }]));
  const renamed = { ...dark, name: "夜间" };
  runtime.execute(envelope(2, [{ type: "theme.upsert", payload: { theme: renamed } }]));
  assert.equal(runtime.snapshot().themes?.length, 1);
  assert.equal(runtime.snapshot().themes?.[0]?.name, "夜间");
});

test("theme.upsert: 覆盖不存在的 token 被拒绝", () => {
  const runtime = runtimeWithToken();
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { id: "theme:x", name: "X", tokens: { "gray.90": { type: "color", value: "#fff" } } } } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().themes, undefined);
});

test("theme.upsert: id 与名称不能为空", () => {
  const runtime = runtimeWithToken();
  assert.throws(() => runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { ...dark, id: " " } } }])), CommandError);
  assert.throws(() => runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { ...dark, name: " " } } }])), CommandError);
});

test("theme.delete: 删除后文档不再持有该主题，基础 token 不变", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: dark } }]));
  runtime.execute(envelope(2, [{ type: "theme.delete", payload: { id: dark.id } }]));
  const snapshot: DesignDocument = runtime.snapshot();
  assert.equal(snapshot.themes?.length, 0);
  assert.deepEqual(snapshot.tokens["gray.900"], { type: "color", value: "#111111" });
});

test("theme.delete: 不存在的主题报错", () => {
  const runtime = runtimeWithToken();
  assert.throws(() => runtime.execute(envelope(1, [{ type: "theme.delete", payload: { id: "theme:missing" } }])), CommandError);
});

test("theme.upsert: 主题可以声明继承自另一个主题", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: dark } }]));
  runtime.execute(envelope(2, [{ type: "theme.upsert", payload: { theme: { id: "theme:child", name: "子", extends: dark.id, tokens: {} } } }]));
  assert.equal(runtime.snapshot().themes?.[1]?.extends, dark.id);
});

test("page.setTheme: 给页面指定主题，清掉时回到未指定", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: dark } }]));
  runtime.execute(envelope(2, [{ type: "page.setTheme", payload: { id: "page:1", themeId: dark.id } }]));
  assert.equal(runtime.snapshot().pages["page:1"]?.themeId, dark.id);
  runtime.execute(envelope(3, [{ type: "page.setTheme", payload: { id: "page:1" } }]));
  assert.equal(runtime.snapshot().pages["page:1"]?.themeId, undefined);
});

test("page.setTheme: 指向不存在的主题被拒绝", () => {
  const runtime = runtimeWithToken();
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "page.setTheme", payload: { id: "page:1", themeId: "theme:missing" } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().pages["page:1"]?.themeId, undefined);
});

test("page.setTheme: 页面不存在时报错", () => {
  const runtime = runtimeWithToken();
  assert.throws(() => runtime.execute(envelope(1, [{ type: "page.setTheme", payload: { id: "page:missing", themeId: "theme:dark" } }])), CommandError);
});

test("theme.upsert: 主题可以带属性覆盖（改节点自己写死的字段）", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { id: "theme:dark", name: "深色", tokens: {}, properties: { Card: { cornerRadius: 16, gap: 12 } } } } }]));
  assert.deepEqual(runtime.snapshot().themes?.[0]?.properties, { Card: { cornerRadius: 16, gap: 12 } });
});

test("theme.upsert: 属性覆盖的值不合法时被拒绝", () => {
  const runtime = runtimeWithToken();
  const bad = [
    { cornerRadius: -1 },
    { gap: Number.NaN },
    { fontSize: 0 },
    { opacity: 1.5 },
  ];
  for (const properties of bad) {
    assert.throws(
      () => runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { id: "theme:x", name: "X", tokens: {}, properties: { Card: properties } } } }])),
      CommandError,
    );
  }
  assert.equal(runtime.snapshot().themes, undefined);
});

test("theme.upsert: 属性覆盖的节点名不能为空串", () => {
  const runtime = runtimeWithToken();
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "theme.upsert", payload: { theme: { id: "theme:x", name: "X", tokens: {}, properties: { "": { cornerRadius: 4 } } } } }])),
    CommandError,
  );
});
