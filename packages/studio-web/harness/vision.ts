import type { ProjectRepository } from "@ufira/design-persistence";
import { createDocument } from "@ufira/design-schema";
import { capturePageScreenshot, capturePagesScreenshot, captureSelectionScreenshot } from "../src/ai-vision";
import { fixtureDocument } from "./fixture";

/**
 * 视觉上下文的浏览器 harness。
 *
 * 在真实浏览器里跑 `capturePageScreenshot`，把渲染出来的 PNG 交回给探针逐像素核对。
 *
 * 为什么必须在浏览器里跑：`capturePageScreenshot` 用的是 Canvas 2D 渲染器，
 * Node 里没有画布，只能验证「没有 DOM 就返回 undefined」这种降级分支。像素对不对
 * （颜色、位置、图片有没有真的画出来），只有真浏览器能回答。
 *
 * ## 为什么用 http:// 而不是 file://
 *
 * 资源字节走 `URL.createObjectURL(new Blob(...))` 变成 blob: URL。`file://` 页面
 * 的源是不透明的（opaque），blob: 图跟它不同源 → 画布被污染 → `toDataURL()` 直接
 * 抛 SecurityError。走 http:// 才是生产环境的样子（Studio 跑在 http(s) 上）。
 *
 * ## 资源字节
 *
 * fixture 里 `asset:sample` 有一份真的 PNG 字节（现画的），`asset:missing` 没有——
 * 用来验证「一张图读不到，整张截图照样出得来，只是那格画占位框」。
 */
interface VisionHarnessResult {
  ok: boolean;
  error?: string;
  full?: { dataUrl: string; width: number; height: number };
  small?: { dataUrl: string; width: number; height: number };
  /** 只截选区（card）的结果。 */
  selection?: { dataUrl: string; width: number; height: number };
  /** 两页拼接的结果。 */
  pages?: { dataUrl: string; width: number; height: number };
}

/** fixture 里那张样图的资源哈希（见 `harness/fixture.ts`）。 */
const SAMPLE_HASH = "hash-sample";

async function main(): Promise<void> {
  const result = await run();
  const pre = document.createElement("pre");
  pre.id = "vision-result";
  pre.textContent = JSON.stringify(result);
  pre.style.display = "none";
  document.body.appendChild(pre);
}

async function run(): Promise<VisionHarnessResult> {
  try {
    const document_ = fixtureDocument();
    const repository = stubRepository();
    const full = await capturePageScreenshot({
      document: document_,
      pageId: "page:1",
      repository,
      projectId: "project:vision",
    });
    const small = await capturePageScreenshot({
      document: document_,
      pageId: "page:1",
      repository,
      projectId: "project:vision",
      maxSize: 480,
    });
    if (!full) return { ok: false, error: "capturePageScreenshot 没有返回截图" };
    if (!small) return { ok: false, error: "限长之后 capturePageScreenshot 没有返回截图" };

    // 只截 card（360×220 @ 页面坐标 40,40）。选区图里不该出现 accent 的颜色——
    // accent 在 card 之外。
    const selection = await captureSelectionScreenshot({
      document: document_,
      pageId: "page:1",
      repository,
      projectId: "project:vision",
      nodeIds: ["card"],
    });
    if (!selection) return { ok: false, error: "captureSelectionScreenshot 没有返回截图" };

    // 两页拼接：每页一块纯色，位置固定，探针能逐像素核对谁在左边。
    const twoPages = twoPageDocument();
    const pages = await capturePagesScreenshot({
      document: twoPages,
      pageId: "page:1",
      repository,
      projectId: "project:vision",
      pageIds: ["page:1", "page:2"],
    });
    if (!pages) return { ok: false, error: "capturePagesScreenshot 没有返回截图" };

    return { ok: true, full, small, selection, pages };
  } catch (error) {
    return { ok: false, error: `${String(error)}\n${(error as Error)?.stack ?? ""}` };
  }
}

/**
 * 两页拼接用的文档：每页一块纯色方块。
 *
 * 颜色故意选得极端（纯红 / 纯蓝），探针一眼就能看出哪块在左、哪块在哪——
 * 拼接的左右顺序错了、色块串位了，这种图立刻暴露。
 *
 * 单独造一份文档而不是改 fixture：改了就会留下一堆孤儿节点，文档校验直接失败。
 */
function twoPageDocument() {
  const document = createDocument("doc:harness:pages", "Pages Harness", "page:1");
  const tile = (id: string, pageId: string, color: string) => {
    const node = {
      id,
      type: "frame" as const,
      name: id,
      parentId: pageId,
      childIds: [],
      visible: true,
      locked: false,
      layout: { mode: "absolute" as const, x: 0, y: 0, width: 240, height: 120, widthMode: "fixed" as const, heightMode: "fixed" as const },
      appearance: { opacity: 1, fills: [{ type: "solid" as const, color }] },
    };
    document.nodes[id] = node;
    return node;
  };
  tile("tile:1", "page:1", "#ff0000");
  tile("tile:2", "page:2", "#0000ff");
  document.pages["page:1"].childIds = ["tile:1"];
  document.pages["page:2"] = { id: "page:2", name: "第二页", childIds: ["tile:2"] };
  document.pageOrder.push("page:2");
  return document;
}

/**
 * 只实现 `getAsset` 的仓库桩。
 *
 * `capturePageScreenshot` 只读资源字节，其余接口用不上——与其照抄整个
 * `ProjectRepository`（十几方法），不如只给真正用到的那一个。
 */
function stubRepository(): ProjectRepository {
  const sample = pngBytes(sampleCanvas());
  return {
    getAsset: async (_projectId: string, hash: string) => (hash === SAMPLE_HASH ? sample : undefined),
  } as unknown as ProjectRepository;
}

/** 用离屏画布现画一张双色样图，再转成 PNG 字节。 */
function sampleCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 80;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.fillStyle = "#0ea5e9";
  context.fillRect(0, 0, 80, 40);
  context.fillStyle = "#f59e0b";
  context.fillRect(0, 40, 80, 40);
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(40, 40, 18, 0, Math.PI * 2);
  context.fill();
  return canvas;
}

/** canvas → PNG 字节。 */
function pngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

void main().catch(error => {
  const pre = document.createElement("pre");
  pre.id = "vision-error";
  pre.textContent = `${String(error)}\n${(error as Error)?.stack ?? ""}`;
  document.body.appendChild(pre);
});
