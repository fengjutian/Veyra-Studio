// 只在 node 里用的入口：`@ufira/studio-application/node`。
//
// 这里的模块会 import `node:fs` / `node:path`，**不能**出现在浏览器依赖图里
// （根入口 `src/index.ts` 因此不再导出它们）。多实例 MCP 的共享状态存储是其中
// 唯一有运行时代码的模块，其余 MCP 模块只引用它的类型。
export * from "./mcp-store";
