import { defineConfig } from "tsup";

export default defineConfig({
  // index 是浏览器入口（不得含 node 内置模块）；node 是 node 专用入口
  // （多实例 MCP 的文件状态存储），包导出为 `@ufira/studio-application/node`。
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  sourcemap: true,
  splitting: false,
});
