// 根入口必须是浏览器安全的：这里只导出契约与自动保存，不引入任何 node 内置模块。
// 文件系统实现走 `@ufira/design-persistence/filesystem` 子路径。
export * from "./contract";
export * from "./baseline";
export * from "./autosave";
export * from "./storage-layout";
