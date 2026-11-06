/**
 * Studio MCP server（HTTP）。
 *
 * 用法：
 *   STUDIO_PROJECT_DIR=/path STUDIO_PROJECT_ID=project:xxx \
 *   STUDIO_MCP_HTTP_TOKEN=<token> npm run mcp:http
 *
 * 环境变量：
 * - `STUDIO_MCP_HTTP_TOKEN`  必填；没有它时拒绝启动（除非显式允许并随机生成）
 * - `STUDIO_MCP_HTTP_PORT`   默认 4599
 * - `STUDIO_MCP_HTTP_HOST`   默认 127.0.0.1（不要默认暴露到 0.0.0.0）
 * - `STUDIO_MCP_AUTO_APPROVE=1`、`STUDIO_MCP_ALLOWED_COMMANDS`、`STUDIO_MCP_ALLOW_RESTORE=1`
 *   与 stdio 版本一致，控制本进程的授权范围。
 *
 * 端点：`POST /mcp`（JSON-RPC）、`GET /healthz`。所有请求都需要 Bearer token。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { StudioProject } from "../src/studio-project";
import { createMcpServer } from "../src/mcp-server";
import { createMcpHttpHandler } from "../src/mcp-http";
import type { McpPolicy } from "../src/mcp";
import type { DesignCommand } from "@ufira/design-runtime";

const directory = process.env.STUDIO_PROJECT_DIR;
const projectId = process.env.STUDIO_PROJECT_ID;
if (!directory || !projectId) {
  console.error("需要 STUDIO_PROJECT_DIR 与 STUDIO_PROJECT_ID");
  process.exit(2);
}

let token = process.env.STUDIO_MCP_HTTP_TOKEN?.trim() ?? "";
if (!token) {
  if (process.env.STUDIO_MCP_HTTP_INSECURE !== "1") {
    console.error("缺少 STUDIO_MCP_HTTP_TOKEN；如果只是本机临时调试，显式设置 STUDIO_MCP_HTTP_INSECURE=1 让服务随机生成一个令牌");
    process.exit(2);
  }
  token = randomUUID();
  console.error(`已随机生成临时令牌（仅本次进程有效）：${token}`);
}

const policy: McpPolicy = {
  ...(process.env.STUDIO_MCP_ALLOWED_COMMANDS
    ? { allowedCommandTypes: process.env.STUDIO_MCP_ALLOWED_COMMANDS.split(",").map(item => item.trim()).filter(Boolean) as DesignCommand["type"][] }
    : {}),
  allowDocumentRestore: process.env.STUDIO_MCP_ALLOW_RESTORE === "1",
};

const repository = new FileSystemProjectRepository(directory);
const opened = await StudioProject.open(repository, projectId);
const rpc = createMcpServer(opened.project, {
  policy,
  autoApprove: process.env.STUDIO_MCP_AUTO_APPROVE === "1",
  onAudit: entry => console.error(JSON.stringify({ audit: entry })),
});
const handler = createMcpHttpHandler({ server: rpc, token });

const maxBodyBytes = 256 * 1024;
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: -32600, message: "请求体超过上限" } }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    void handler.handle({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }).then(result => {
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    }).catch(error => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
    });
  });
});

const port = Number(process.env.STUDIO_MCP_HTTP_PORT ?? 4599);
const host = process.env.STUDIO_MCP_HTTP_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.error(`Studio MCP HTTP 已监听 http://${host}:${port}（项目 ${projectId}）`);
});
