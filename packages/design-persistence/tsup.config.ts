import { defineConfig } from "tsup";

export default defineConfig({
  // 根入口给浏览器用（契约 + 自动保存），filesystem 子入口给 node 用。
  entry: ["src/index.ts", "src/filesystem.ts", "src/contract-suite.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node18",
  platform: "node",
  // 保留 `node:` 前缀：node:test 去掉前缀后会变成无法解析的 "test"。
  removeNodeProtocol: false,
  sourcemap: true,
  // 两个入口共享 contract/autosave 的实现，拆包后错误类型在运行时仍是同一个类。
  splitting: true,
});
