/**
 * `fonteditor-core` 的最小类型声明。
 *
 * 这个包没有随包发布类型声明，而本模块只用到三个字段，
 * 所以在这里声明用到的那部分，而不是 `declare module "fonteditor-core";`
 * （那会把整个包变成 any，等于放弃类型检查）。
 */
declare module "fonteditor-core" {
  export interface FontOptions {
    /** 字体格式：ttf / otf / woff / woff2。 */
    type?: string;
  }

  export interface FontInstance {
    /** 取字体对象；表格挂在它的属性上（name / head / OS/2 …）。 */
    get(): unknown;
    /** 写回字体文件。 */
    write(options?: Record<string, unknown>): unknown;
  }

  export const Font: {
    create(buffer: ArrayBuffer, options?: FontOptions): FontInstance;
  };
}
