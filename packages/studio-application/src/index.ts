// 根入口必须是浏览器安全的：这里不能引入任何 node 内置模块，否则 Vite 会把
// `fs` / `path` 外部化成空壳，客户端一加载就抛
// "Module \"fs\" has been externalized for browser compatibility"（页面白屏）。
// 依赖 node 内置模块的共享状态存储走 `@ufira/studio-application/node` 子路径。
export * from "./studio-project";
export * from "./asset-package";
export * from "./assets";
export * from "./external-assets";
export * from "./external-asset-providers";
export * from "./boolean-engine";
export * from "./font-faces";
export * from "./history";
export * from "./mcp";
export * from "./mcp-auth";
export * from "./mcp-auth-state";
export * from "./mcp-events";
export * from "./mcp-server";
export * from "./mcp-tenants";
export * from "./mcp-http";
export * from "./accessibility";
