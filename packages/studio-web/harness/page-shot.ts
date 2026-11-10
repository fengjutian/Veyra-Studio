import type { ProjectRepository } from "@ufira/design-persistence";
import type { DesignDocument } from "@ufira/design-schema";
import { capturePageScreenshot } from "../src/ai-vision";

/**
 * 「逐页出图」的浏览器 harness。
 *
 * 文档是探针写在同目录下的 `document.json`，用 `?page=<页面 id>` 选页：
 * 一次生成多页时，每一页都要单独出一张图，而 `capturePageScreenshot` 的
 * 视口取自页面自身的宽高——所以选页是必须的，不能只截第一页。
 *
 * 渲染走的是**工作台那套 Canvas 2D 渲染器**：出来的图就是用户在画布上看到的那张，
 * 不是导出 HTML 的另一条渲染路径。
 */
interface HarnessResult {
  ok: boolean;
  error?: string;
  image?: { dataUrl: string; mimeType: string; width: number; height: number };
  nodeCount?: number;
  pageId?: string;
}

async function main(): Promise<void> {
  const result = await run();
  const pre = document.createElement("pre");
  pre.id = "page-shot-result";
  pre.textContent = JSON.stringify(result);
  pre.style.display = "none";
  document.body.appendChild(pre);
}

async function run(): Promise<HarnessResult> {
  try {
    const response = await fetch("document.json");
    if (!response.ok) return { ok: false, error: `取 document.json 失败：HTTP ${response.status}` };
    const document_ = (await response.json()) as DesignDocument;
    const requested = new URLSearchParams(window.location.search).get("page");
    const pageId = requested ?? document_.pageOrder[0] ?? "page:1";
    if (!document_.pages[pageId]) return { ok: false, error: `文档里没有页面 ${pageId}` };

    const image = await capturePageScreenshot({
      document: document_,
      pageId,
      repository: stubRepository(),
      projectId: "project:page-shot",
    });
    if (!image) return { ok: false, error: "capturePageScreenshot 没有返回截图" };

    return {
      ok: true,
      image: { dataUrl: image.dataUrl, mimeType: image.mimeType, width: image.width, height: image.height },
      nodeCount: Object.keys(document_.nodes).length,
      pageId,
    };
  } catch (error) {
    return { ok: false, error: `${String(error)}\n${(error as Error)?.stack ?? ""}` };
  }
}

/** 只实现 `getAsset` 的仓库桩：截图读不到图片字节时渲染器会画占位框。 */
function stubRepository(): ProjectRepository {
  return {
    getAsset: async () => undefined,
  } as unknown as ProjectRepository;
}

void main().catch(error => {
  const pre = document.createElement("pre");
  pre.id = "page-shot-error";
  pre.textContent = `${String(error)}\n${(error as Error)?.stack ?? ""}`;
  pre.style.display = "none";
  document.body.appendChild(pre);
});
