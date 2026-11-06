/**
 * Studio MCP server（stdio）。
 *
 * 用法：
 *   STUDIO_PROJECT_DIR=/path/to/projects STUDIO_PROJECT_ID=project:xxx npm run mcp:studio
 *
 * 环境变量：
 * - `STUDIO_MCP_AUTO_APPROVE=1`  跳过人工确认（只适合受控的本地会话）
 * - `STUDIO_MCP_ALLOWED_COMMANDS=node.create,node.patch`  白名单
 * - `STUDIO_MCP_ALLOW_RESTORE=1` 允许整篇 history.restore（默认禁止）
 *
 * stdout 只输出 JSON-RPC 消息；审计记录写 stderr，避免污染协议流。
 */
import { createInterface } from "node:readline";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { StudioProject } from "../src/studio-project";
import { createMcpServer } from "../src/mcp-server";
import type { McpPolicy } from "../src/mcp";
import type { DesignCommand } from "@ufira/design-runtime";

const directory = process.env.STUDIO_PROJECT_DIR ?? process.argv[2];
const projectId = process.env.STUDIO_PROJECT_ID ?? process.argv[3];

if (!directory || !projectId) {
  console.error("需要 STUDIO_PROJECT_DIR 与 STUDIO_PROJECT_ID（或作为前两个参数传入）");
  process.exit(2);
}

const policy: McpPolicy = {
  ...(process.env.STUDIO_MCP_ALLOWED_COMMANDS
    ? { allowedCommandTypes: process.env.STUDIO_MCP_ALLOWED_COMMANDS.split(",").map(item => item.trim()).filter(Boolean) as DesignCommand["type"][] }
    : {}),
  allowDocumentRestore: process.env.STUDIO_MCP_ALLOW_RESTORE === "1",
};

const repository = new FileSystemProjectRepository(directory);
const opened = await StudioProject.open(repository, projectId);
const server = createMcpServer(opened.project, {
  policy,
  autoApprove: process.env.STUDIO_MCP_AUTO_APPROVE === "1",
  onAudit: entry => console.error(JSON.stringify({ audit: entry })),
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    continue;
  }
  const response = await server.handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
