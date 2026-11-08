declare module "paper/dist/paper-core.js" {
  /** paper-core 与 paper 的 API 相同，只是去掉了 DOM / canvas 依赖。 */
  const paper: typeof import("paper");
  export default paper;
}
