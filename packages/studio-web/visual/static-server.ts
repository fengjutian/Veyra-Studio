/**
 * 极简静态文件服务器（只给探针用）。
 *
 * 整应用检查需要用 http:// 打开构建产物：`file://` 下浏览器会禁掉 IndexedDB，
 * 而 Studio 的项目仓库正是 Dexie + IndexedDB，file:// 打开只能看到空壳。
 *
 * 只监听 127.0.0.1 的随机端口，跑完就关。
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export async function serveDirectory(root: string): Promise<StaticServer> {
  const rootPath = resolve(root);
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const relative = normalize(decodeURIComponent(requestUrl.pathname)).replace(/^[/\\]+/, "");
        let file = join(rootPath, relative);
        // 目录穿越：解析后的路径必须还在根目录里。
        if (!file.startsWith(rootPath)) {
          response.writeHead(403).end("forbidden");
          return;
        }
        let body: Buffer;
        try {
          body = await readFile(file);
        } catch {
          // 单页应用：未知路径回落到 index.html。
          file = join(rootPath, "index.html");
          body = await readFile(file);
        }
        response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
        response.end(body);
      } catch {
        response.writeHead(404).end("not found");
      }
    })();
  });

  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  };
}
