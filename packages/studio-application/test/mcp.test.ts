import assert from "node:assert/strict";
import test from "node:test";
import type { DesignCommand } from "@ufira/design-runtime";
import {
  DESTRUCTIVE_COMMAND_TYPES,
  MCP_SUPPORTED_COMMAND_TYPES,
  MCP_TOOLS,
  authorizeCommands,
  createAuditEntry,
  type McpPolicy,
} from "../src/index";

const rename: DesignCommand = { type: "document.rename", payload: { name: "x" } };
const create: DesignCommand = { type: "node.create", payload: { node: { id: "a" } as never } };
const remove: DesignCommand = { type: "node.delete", payload: { id: "a" } };
const restore: DesignCommand = { type: "history.restore", payload: { document: {} as never } };

test("tool catalog is small, unique and covers every supported command", () => {
  const names = MCP_TOOLS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, ["design.read", "design.preview", "design.apply"]);

  const apply = MCP_TOOLS.find(tool => tool.name === "design.apply");
  assert.deepEqual(apply?.commandTypes, MCP_SUPPORTED_COMMAND_TYPES);
  assert.equal(apply?.requiresApproval, true);

  const read = MCP_TOOLS.find(tool => tool.name === "design.read");
  assert.deepEqual(read?.commandTypes, []);
  assert.equal(read?.requiresApproval, false);

  // 所有工具声明的命令类型都必须在支持列表里。
  for (const tool of MCP_TOOLS) {
    for (const type of tool.commandTypes) assert.ok(MCP_SUPPORTED_COMMAND_TYPES.includes(type), `${tool.name} 声明了未知命令 ${type}`);
  }
});

test("destructive commands are a subset of supported commands", () => {
  for (const type of DESTRUCTIVE_COMMAND_TYPES) assert.ok(MCP_SUPPORTED_COMMAND_TYPES.includes(type), `${type} 未登记`);
});

test("rejects empty batches and over-limit batches", () => {
  const empty = authorizeCommands(undefined, []);
  assert.equal(empty.allowed, false);
  assert.match(empty.reasons[0] ?? "", /不能为空/);

  const tooMany = authorizeCommands({ maxCommandsPerBatch: 2 }, [rename, create, remove]);
  assert.equal(tooMany.allowed, false);
  assert.match(tooMany.reasons.join(" "), /最多 2 条/);
});

test("honours deny lists before allow lists", () => {
  const denied = authorizeCommands({ deniedCommandTypes: ["node.delete"] }, [remove]);
  assert.equal(denied.allowed, false);
  assert.match(denied.reasons.join(" "), /拒绝列表/);

  const notAllowed = authorizeCommands({ allowedCommandTypes: ["document.rename"] }, [create]);
  assert.equal(notAllowed.allowed, false);
  assert.match(notAllowed.reasons.join(" "), /不在允许列表/);

  assert.equal(authorizeCommands({ allowedCommandTypes: ["document.rename"] }, [rename]).allowed, true);
});

test("history.restore needs an explicit opt-in", () => {
  const blocked = authorizeCommands(undefined, [restore]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons.join(" "), /整篇还原/);

  const allowed = authorizeCommands({ allowDocumentRestore: true }, [restore]);
  assert.equal(allowed.allowed, true);
  // 仍然需要确认：整篇覆盖本来就是破坏性操作。
  assert.equal(allowed.requiresApproval, true);
});

test("destructive commands require approval even when the policy disables it", () => {
  const decision = authorizeCommands({ requireApproval: false }, [create]);
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);

  const destructive = authorizeCommands({ requireApproval: false }, [remove]);
  assert.equal(destructive.allowed, true);
  assert.equal(destructive.requiresApproval, true);
  assert.match(destructive.approvalReasons.join(" "), /node.delete/);
});

test("approval is required by default", () => {
  const decision = authorizeCommands(undefined, [rename]);
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.match(decision.approvalReasons.join(" "), /人工确认/);
});

test("audit entries record actor, command types and revision", () => {
  const entry = createAuditEntry({
    tool: "design.apply",
    commandId: "cmd:1",
    actor: "agent:external",
    revisionBefore: 7,
    revisionAfter: 8,
    commands: [rename, create],
    decision: "applied",
    at: "2026-11-07T00:00:00.000Z",
  });
  assert.deepEqual(entry.commandTypes, ["document.rename", "node.create"]);
  assert.equal(entry.revisionBefore, 7);
  assert.equal(entry.revisionAfter, 8);
  assert.equal(entry.at, "2026-11-07T00:00:00.000Z");

  const rejected = createAuditEntry({ tool: "design.apply", commandId: "cmd:2", actor: "agent:x", revisionBefore: 8, commands: [restore], decision: "rejected", reason: "整篇还原被拒绝" });
  assert.equal(rejected.decision, "rejected");
  assert.equal(rejected.revisionAfter, undefined);
  assert.deepEqual(rejected.commandTypes, ["history.restore"]);
});

test("policy defaults keep the external agent inside a small safety envelope", () => {
  const policy: McpPolicy = {};
  const decision = authorizeCommands(policy, [rename, create]);
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  // 默认批量上限是 50。
  assert.equal(authorizeCommands(policy, Array.from({ length: 51 }, () => rename)).allowed, false);
});
