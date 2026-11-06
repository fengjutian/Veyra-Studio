/**
 * 把画布 harness 打成单个 IIFE 并内联进 HTML。
 *
 * 内联是为了 `file://` 直接可打开：Chrome 对 file:// 下的模块脚本和 XHR 有限制，
 * 但内联的经典脚本没有问题。产物写到 visual/.cache/（已忽略），只有基线 PNG 入库。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const harnessRoot = join(root, "packages", "studio-web", "harness");

export const HARNESS_HTML = join(here, ".cache", "harness.html");

export async function buildHarness(): Promise<string> {
  await mkdir(dirname(HARNESS_HTML), { recursive: true });
  const result = await build({
    entryPoints: [join(harnessRoot, "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  const js = result.outputFiles[0]?.text ?? "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>Canvas harness</title>
<style>html,body{margin:0;padding:0;background:#fff}canvas{display:block}</style>
</head>
<body>
<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>
</body>
</html>`;
  await writeFile(HARNESS_HTML, html, "utf8");
  return HARNESS_HTML;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHarness()
    .then(path => console.log(`harness 已生成：${path}`))
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
