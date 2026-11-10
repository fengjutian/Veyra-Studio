import type { ProjectRepository } from "@ufira/design-persistence";
import type { DesignDocument } from "@ufira/design-schema";
import { capturePageScreenshot } from "../src/ai-vision";

/**
 * 「空白文档 → 一句话 → 出图」探针的浏览器 harness。
 *
 * 干的事只有一件：把探针在 Node 里生成的设计文档，用**工作台那套 Canvas 2D
 * 渲染器**画成一张 PNG，交回 Node。
 *
 * 为什么不用导出 HTML 再截图：那是另一条渲染路径，混合模式、背景模糊、蒙版这些
 * 只有画布才有的效果会在那条路上变样。用同一套渲染器，出来的图才是用户在工作台
 * 里看到的那张——「出图」验收要验的就是这个。
 *
 * 文档是探针写在同目录下的 `document.json`，页面用 fetch 取。
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
  pre.id = "from-scratch-result";
  pre.textContent = JSON.stringify(result);
  pre.style.display = "none";
  document.body.appendChild(pre);
}

async function run(): Promise<HarnessResult> {
  try {
    const response = await fetch("document.json");
    if (!response.ok) return { ok: false, error: `取 document.json 失败：HTTP ${response.status}` };
    const document_ = (await response.json()) as DesignDocument;
    const pageId = document_.pageOrder[0] ?? "page:1";
    if (!document_.pages[pageId]) return { ok: false, error: `文档里没有页面 ${pageId}` };

    const image = await capturePageScreenshot({
      document: document_,
      pageId,
      repository: stubRepository(),
      projectId: "project:from-scratch",
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

/**
 * 只实现 `getAsset` 的仓库桩。
 *
 * 截图要读图片资源字节，读不到时渲染器会画占位框——不影响「出图」这件事本身。
 */
function stubRepository(): ProjectRepository {
  return {
    getAsset: async () => undefined,
  } as unknown as ProjectRepository;
}

void main().catch(error => {
  const pre = document.createElement("pre");
  pre.id = "from-scratch-error";
  pre.textContent = `${String(error)}\n${(error as Error)?.stack ?? ""}`;
  document.body.appendChild(pre);
});
