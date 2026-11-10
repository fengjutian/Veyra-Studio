/**
 * 资源 id 的推导规则。
 *
 * 资源 id 由**内容哈希**推导：同一份字节永远落到同一个 id 上，所以同一张图在项目里
 * 插入两次也只占一份存储，导出时也只会出现一次。
 *
 * 放在 `design-schema` 而不是某个前端包里，是因为「资源身份」是文档模型的一部分：
 * 应用层、Web 工作台、MCP 三边都要用同一套推导规则，不能各写一份。
 */

/** 资源 id 由内容哈希推导：同一张图重复插入会落到同一个资源上。 */
export function assetIdForHash(hash: string): string {
  return `asset:${hash.slice(0, 16)}`;
}
