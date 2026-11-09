/**
 * SVG 导出物字体内联的能力探针。
 *
 *   npm run visual:svg-font-probe
 *
 * 回答一个问题：**导出的 SVG 真的自带字体吗？**
 *
 * 「SVG 里有 `@font-face`」只是一段文本。硬证据是浏览器**真的应用了**这个字体：
 * 有 / 无 `@font-face` 时，同一段文字的宽度不同。
 *
 * 探针走**真实导出路径**（`exportPageToSvg`），不手写 SVG——手写的 SVG 通过了
 * 不代表导出器写出来的那份能通过。
 *
 * 三种加载场景各测一遍（规格见 `docs/font-inline.md` §8.2）：
 * 1. 顶层 `.svg` 文档（直接打开）；
 * 2. HTML 里内联 `<svg>`；
 * 3. `<img src="…svg">`（这个只能比像素，不能读 DOM）。
 *
 * ⚠️ 两个必须避开的坑（第一版探针就踩了，结论一度是反的）：
 * - `.svg` 是 **XML**：脚本里不能出现裸的 `&`（`&&` 会让 XML 解析失败，
 *   脚本根本不执行，于是读数是空——「读数是空」不等于「读数相同」）；
 * - `font-family` 的族名**必须加引号**：`Press Start 2P` 的 `2P` 以数字开头，
 *   不是合法 CSS 标识符，不加引号整条声明会作废。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToSvg, fontFaceCss } from "@ufira/design-export";
import { dumpHtml, findBrowser, renderHtmlToPng } from "../../design-export/visual/browser";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache", "svg-font");
const FONT_PATH = join(here, "..", "..", "design-export", "test", "fixtures", "PressStart2P-Regular.ttf");
const FAMILY = "Press Start 2P";
const SAMPLE = "Handgloves 0123 ABC";

interface Measurement {
  /** 字体加载前测到的宽度（回退字体）。 */
  early: number;
  /** 字体加载后测到的宽度。 */
  late: number;
}

/** 一份只有一个文本节点的文档：族名故意用带数字的那个。 */
function documentWithText(): DesignDocument {
  const document = createDocument("doc:svg-font", "SVG 字体");
  const node = {
    id: "text:1",
    type: "text",
    name: "text:1",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 900, height: 120 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#000000" }] },
    text: SAMPLE,
    fontFamily: FAMILY,
    fontSize: 48,
    lineHeight: 56,
  } as DesignNode;
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds.push(node.id);
  return document;
}

/**
 * 测量脚本（XML 安全：没有裸的 `&`，没有 `<`）。
 *
 * 装到 SVG 末尾，只读取不修改渲染结果——它存在的意义是把
 * `getComputedTextLength()` 的结果写回根元素，好让 `--dump-dom` 抓到。
 */
const MEASURE_SCRIPT = `<script type="text/javascript"><![CDATA[
  var root = document.documentElement;
  var target = root.querySelector("text");
  function measure(tag) {
    root.setAttribute("data-measured-" + tag, String(target.getComputedTextLength()));
  }
  measure("early");
  function late() {
    setTimeout(function () { measure("late"); }, 300);
  }
  if (document.fonts) {
    document.fonts.load('48px "${FAMILY}"').then(late, late);
  } else {
    late();
  }
]]></script>`;

function extractMeasurement(dom: string): Measurement {
  const early = /data-measured-early="([\d.]+)"/.exec(dom);
  const late = /data-measured-late="([\d.]+)"/.exec(dom);
  if (!early || !late) throw new Error("页面里没有测量值（脚本可能没执行：注意 .svg 是 XML，脚本里不能有裸的 & ）");
  return { early: Number(early[1]), late: Number(late[1]) };
}

async function main(): Promise<void> {
  if (!findBrowser()) {
    console.log("未找到 Chrome/Edge；设置 CHROME_PATH 后重试。跳过 SVG 字体内联探针。");
    return;
  }
  mkdirSync(CACHE, { recursive: true });

  const bytes = new Uint8Array(readFileSync(FONT_PATH));
  const face = fontFaceCss({ family: FAMILY, weight: 400, style: "normal", bytes, mime: "font/ttf" });
  const document = documentWithText();
  const viewport = { width: 900, height: 200 };

  // 两份 SVG：只差「有没有内联字体」。
  const withFace = exportPageToSvg(document, { pageId: "page:1", viewport, fontFaces: [face] }).svg;
  const withoutFace = exportPageToSvg(document, { pageId: "page:1", viewport }).svg;

  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };

  // ① 顶层 .svg 文档。
  const topLevel: Record<string, Measurement> = {};
  for (const [name, svg] of [["with", withFace], ["without", withoutFace]] as const) {
    const path = join(CACHE, `top-${name}.svg`);
    writeFileSync(path, svg.replace("</svg>", `${MEASURE_SCRIPT}</svg>`), "utf8");
    topLevel[name] = extractMeasurement(await dumpHtml({ htmlPath: path }));
  }
  check(
    Math.abs(topLevel.with!.late - topLevel.without!.late) > 0.5,
    `顶层 SVG 里字体没被应用（两种情况宽度相同：${topLevel.with!.late}px）`,
  );

  // ② HTML 里内联 <svg>。
  const inline: Record<string, Measurement> = {};
  for (const [name, svg] of [["with", withFace], ["without", withoutFace]] as const) {
    const path = join(CACHE, `inline-${name}.html`);
    writeFileSync(path, `<!doctype html><html><body style="margin:0">${svg.replace("</svg>", `${MEASURE_SCRIPT}</svg>`)}</body></html>`, "utf8");
    inline[name] = extractMeasurement(await dumpHtml({ htmlPath: path }));
  }
  check(
    Math.abs(inline.with!.late - inline.without!.late) > 0.5,
    `内联 <svg> 里字体没被应用（两种情况宽度相同：${inline.with!.late}px）`,
  );

  // ③ <img src="…svg">：SVG-as-image 读不到 DOM，只能比像素。
  const pngs: string[] = [];
  for (const [name, svg] of [["with", withFace], ["without", withoutFace]] as const) {
    const svgPath = join(CACHE, `img-${name}.svg`);
    writeFileSync(svgPath, svg, "utf8");
    const htmlPath = join(CACHE, `img-${name}.html`);
    writeFileSync(htmlPath, `<!doctype html><html><body style="margin:0"><img src="file:///${svgPath.replace(/\\/g, "/")}" width="900" height="200"></body></html>`, "utf8");
    const pngPath = join(CACHE, `img-${name}.png`);
    await renderHtmlToPng({ htmlPath, outPath: pngPath, width: 900, height: 200 });
    pngs.push(pngPath);
  }
  const identical = readFileSync(pngs[0]!).equals(readFileSync(pngs[1]!));
  check(!identical, "<img> 引用 SVG 时两张截图完全相同——字体没被应用");

  if (failures.length) {
    console.error(`SVG 字体内联探针失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`  · ${failure}`);
    console.error(`顶层 SVG：${JSON.stringify(topLevel)}；内联 <svg>：${JSON.stringify(inline)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `SVG 字体内联探针通过：导出的 SVG 自带字体（顶层 ${topLevel.without!.late}px → ${topLevel.with!.late}px，内联 ${inline.without!.late}px → ${inline.with!.late}px，<img> 截图不同）。`,
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
