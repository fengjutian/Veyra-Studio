import type { DesignDocument } from "@ufira/design-schema";

/**
 * 字体加载。
 *
 * 布局在字体到位之前就会跑一次，拿的是回退字形的宽度；Web 字体异步到达之后，
 * 之前测出来的尺寸就不再准确。这里负责"把文档用到的字体都尝试加载一遍"，加载
 * 完成后由调用方清掉测量缓存并重排一次。
 *
 * 加载失败不是错误：很多设计用的就是系统字体，`load()` 对已安装字体会立刻
 * 成功，对不存在的字体则会失败——两种情况都不该阻塞编辑。
 */

/** 只用到 `load`，便于在没有 DOM 的环境里测试。 */
export interface FontFaceSetLike {
  load(font: string, text?: string): Promise<unknown[]>;
}

/** 文档里所有文本节点用到的字体名，去重并排序，保证结果稳定可测。 */
export function collectFontFamilies(document: DesignDocument): string[] {
  const families = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "text") continue;
    const family = node.fontFamily.trim();
    if (family) families.add(family);
  }
  return [...families].sort();
}

export interface PrepareFontsOptions {
  /** 整体等待上限，默认 3 秒。 */
  timeoutMs?: number;
  /** 注入 FontFaceSet 便于测试；默认取 `document.fonts`。 */
  fonts?: FontFaceSetLike;
}

/**
 * 尝试加载这些字体，返回加载成功的字体名。
 *
 * 单个字体失败或超时会被跳过，不抛异常：字体缺失应该退化成回退字体，
 * 而不是让整个工作台报错。
 */
export async function prepareFonts(families: string[], options: PrepareFontsOptions = {}): Promise<string[]> {
  const fontSet = options.fonts ?? resolveFontSet();
  if (!fontSet || families.length === 0) return [];
  const timeoutMs = options.timeoutMs ?? 3000;

  const results = await Promise.all(families.map(async family => {
    const cssName = `16px "${family.replace(/["\\]/g, "")}"`;
    try {
      const loaded = await withTimeout(fontSet.load(cssName), timeoutMs);
      return loaded ? family : undefined;
    } catch {
      return undefined;
    }
  }));
  return results.filter((family): family is string => typeof family === "string");
}

/** 给 promise 套一个超时；超时返回 undefined，并清掉计时器避免拖住进程。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function resolveFontSet(): FontFaceSetLike | undefined {
  const fonts = (globalThis as { document?: { fonts?: FontFaceSetLike } }).document?.fonts;
  return fonts ?? undefined;
}
