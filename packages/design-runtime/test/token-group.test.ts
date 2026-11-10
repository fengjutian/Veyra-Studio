import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { CommandError, DesignRuntime } from "../src/index";

/**
 * 分组元数据命令：新增 / 覆盖 / 删除。
 *
 * 分组本身仍由 token 名字的前缀决定，元数据只改它在面板上的显示方式。
 */

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

function runtimeWithToken(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "token.upsert", payload: { name: "color.text.primary", token: { type: "color", value: "#111111" } } }]));
  return runtime;
}

test("tokenGroup.upsert: 写入显示名、说明与顺序", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", label: "文字色", description: "正文与标题", order: 3 } } }]));
  assert.deepEqual(runtime.snapshot().tokenGroups, [{ id: "color.text", label: "文字色", description: "正文与标题", order: 3 }]);
});

test("tokenGroup.upsert: 同一 id 覆盖，不重复插入", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", label: "文字色" } } }]));
  runtime.execute(envelope(2, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", label: "正文色" } } }]));
  assert.equal(runtime.snapshot().tokenGroups?.length, 1);
  assert.equal(runtime.snapshot().tokenGroups?.[0]?.label, "正文色");
});

test("tokenGroup.upsert: 空白字段被丢掉，不留空串", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", label: "  ", description: "  " } } }]));
  assert.deepEqual(runtime.snapshot().tokenGroups, [{ id: "color.text" }]);
});

test("tokenGroup.upsert: 顺序不是有限数字时报错", () => {
  const runtime = runtimeWithToken();
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", order: Number.POSITIVE_INFINITY } } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().tokenGroups, undefined);
});

test("tokenGroup.delete: 删掉元数据，token 本身不受影响", () => {
  const runtime = runtimeWithToken();
  runtime.execute(envelope(1, [{ type: "tokenGroup.upsert", payload: { group: { id: "color.text", label: "文字色" } } }]));
  runtime.execute(envelope(2, [{ type: "tokenGroup.delete", payload: { id: "color.text" } }]));
  assert.equal(runtime.snapshot().tokenGroups?.length, 0);
  assert.deepEqual(runtime.snapshot().tokens["color.text.primary"], { type: "color", value: "#111111" });
});

test("tokenGroup.delete: 不存在的分组报错", () => {
  const runtime = runtimeWithToken();
  assert.throws(() => runtime.execute(envelope(1, [{ type: "tokenGroup.delete", payload: { id: "color.missing" } }])), CommandError);
});
