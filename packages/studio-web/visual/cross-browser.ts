/**
 * 跨浏览器像素基线：采集与检查。
 *
 *   npm run visual:cross-browser:list
 *   npm run visual:cross-browser:baseline
 *   npm run visual:cross-browser:baseline -- --engine=firefox
 *   npm run visual:cross-browser:check
 *   npm run visual:cross-browser:check -- --engine=chromium --threshold=0.003
 *
 * 已有画布像素基线只有一份，绑定「本机 + 本浏览器 + 本机字体」。这个脚本把基线
 * 按 **引擎 + 平台** 分目录存放，每份基线带指纹（引擎、版本、系统、字体集摘要、
 * 视口、DPR），比较时先比指纹再比像素：
 *
 * - 目标引擎没有基线 → 明确报告「未采集」，并列出**已有基线覆盖了哪些引擎与
 *   平台**。既不静默通过（假装没问题），也不静默失败（只抛一句错）。
 * - 字体集摘要不同 → 直接说「基线不可比」，因为此时的像素差异归因不到渲染回归。
 *
 * 基线目录：`packages/studio-web/visual/baselines/`（`<引擎>/<平台>/<家族>-<版本>/
 * <场景>.png` + `manifest.json`）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baselineImagePath,
  compareFingerprints,
  describeAvailableBaselines,
  fontSetChanged,
  parseManifest,
  selectBaseline,
  serializeManifest,
  upsertBaseline,
  type CrossBrowserBaseline,
  type CrossBrowserEngineId,
  type CrossBrowserFingerprint,
  type CrossBrowserManifest,
} from "@ufira/design-export";
import { captureWithEngine, probeEngines, type EngineDescriptor } from "../../design-export/visual/engines";
import { decodePng, diffImages } from "../../design-export/visual/png";
import { buildHarness } from "./build-harness";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_ROOT = join(here, "baselines");
const MANIFEST = join(BASELINE_ROOT, "manifest.json");
const CACHE = join(here, ".cache", "cross-browser");
const SCENE = "canvas";

interface Args {
  update: boolean;
  list: boolean;
  engines: CrossBrowserEngineId[];
  required: CrossBrowserEngineId[];
  browserPath?: string;
  platform: string;
  threshold: number;
  width: number;
  height: number;
}

const ALL_ENGINES: CrossBrowserEngineId[] = ["chromium", "firefox", "webkit"];

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  const list = (raw: string | undefined): CrossBrowserEngineId[] =>
    (raw ?? "")
      .split(",")
      .map(item => item.trim())
      .filter((item): item is CrossBrowserEngineId => (ALL_ENGINES as string[]).includes(item));
  return {
    update: argv.includes("--update"),
    list: argv.includes("--list"),
    engines: list(value("--engine=")),
    required: list(value("--require-engine=")),
    browserPath: value("--browser="),
    platform: value("--platform=") ?? process.platform,
    threshold: Number(value("--threshold=") ?? 0.003),
    width: Number(value("--width=") ?? 960),
    height: Number(value("--height=") ?? 680),
  };
}

function readManifest(): CrossBrowserManifest {
  try {
    return parseManifest(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, baselines: [] };
    throw error;
  }
}

interface EngineRun {
  descriptor: EngineDescriptor;
  fingerprint: CrossBrowserFingerprint;
  imagePath: string;
}

function fingerprintOf(
  descriptor: EngineDescriptor,
  capture: { metrics: Record<string, unknown>; userAgent?: string; identity?: { family: string; version: string } },
  platform: string,
  viewport: { width: number; height: number },
): CrossBrowserFingerprint {
  const fonts = capture.metrics.fonts as { digest?: string } | undefined;
  const dpr = capture.metrics.dpr;
  return {
    engine: descriptor.id,
    family: capture.identity?.family ?? descriptor.family,
    version: capture.identity?.version ?? descriptor.version,
    platform,
    osRelease: `${process.platform} ${release()}`,
    userAgent: capture.userAgent ?? "",
    // 指纹缺失 = 这份基线没法判断可不可比，宁可采集失败也不写这种基线。
    fontDigest: fonts?.digest ?? "",
    viewport,
    deviceScaleFactor: typeof dpr === "number" && Number.isFinite(dpr) ? dpr : 1,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const manifest = readManifest();
    if (!manifest.baselines.length) {
      console.log(`还没有采集过任何跨浏览器基线（${MANIFEST} 不存在或为空）。`);
      console.log("采集命令：npm run visual:cross-browser:baseline");
      return;
    }
    console.log(`跨浏览器像素基线（${manifest.baselines.length} 份）：`);
    for (const baseline of manifest.baselines) {
      console.log(
        `  ${baseline.engine} / ${baseline.platform} / ${baseline.family} ${baseline.version}`
        + `（场景 ${baseline.scene}，字体指纹 ${baseline.fingerprint.fontDigest}，采集于 ${baseline.collectedAt.slice(0, 10)}）`,
      );
      console.log(`    ${baseline.image}`);
    }
    return;
  }

  const probes = await probeEngines();
  const targets = args.engines.length ? args.engines : ALL_ENGINES;

  const skipped: string[] = [];
  const failures: string[] = [];
  const runs: EngineRun[] = [];
  const html = await buildHarness();
  mkdirSync(CACHE, { recursive: true });

  for (const id of targets) {
    const probe = probes.find(item => item.id === id);
    if (!probe?.available || !probe.descriptor) {
      const reason = probe?.reason ?? "未知原因";
      // 显式点名的引擎不可用是**配置错误**，不能当成「跳过」一笔带过。
      if (args.engines.length) {
        console.error(`引擎 ${id} 不可用：${reason}`);
        failures.push(`引擎 ${id} 不可用：${reason}`);
      } else {
        console.log(`跳过 ${id}：${reason}`);
        skipped.push(`${id}（${reason}）`);
      }
      continue;
    }
    const descriptor: EngineDescriptor = args.browserPath
      ? { ...probe.descriptor, binaryPath: args.browserPath }
      : probe.descriptor;
    const imagePath = join(CACHE, `${id}.png`);
    console.log(`采集 ${id}（${descriptor.family} ${descriptor.version || "版本未知"}）…`);
    const capture = await captureWithEngine(descriptor, {
      htmlPath: html,
      outPath: imagePath,
      width: args.width,
      height: args.height,
    });
    const fingerprint = fingerprintOf(descriptor, capture, args.platform, { width: args.width, height: args.height });
    if (!fingerprint.fontDigest) {
      throw new Error(`${id} 没有报告字体集指纹：这份基线无法判断可不可比，拒绝写入。`);
    }
    runs.push({ descriptor, fingerprint, imagePath });
  }

  if (!runs.length) {
    console.error(
      args.engines.length
        ? "点名的引擎都不可用，跨浏览器基线无从谈起。"
        : "本机没有可用的浏览器引擎，跨浏览器基线无从谈起。",
    );
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }

  const manifest = readManifest();

  if (args.update) {
    for (const run of runs) {
      const image = baselineImagePath({
        scene: SCENE,
        engine: run.fingerprint.engine,
        family: run.fingerprint.family,
        version: run.fingerprint.version,
        platform: run.fingerprint.platform,
      });
      const absolute = join(BASELINE_ROOT, image);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, readFileSync(run.imagePath));
      const baseline: CrossBrowserBaseline = {
        scene: SCENE,
        engine: run.fingerprint.engine,
        family: run.fingerprint.family,
        version: run.fingerprint.version,
        platform: run.fingerprint.platform,
        image,
        fingerprint: run.fingerprint,
        collectedAt: new Date().toISOString(),
      };
      manifest.baselines = upsertBaseline(manifest, baseline).baselines;
      console.log(`已写入基线：${image}（字体指纹 ${run.fingerprint.fontDigest}）`);
    }
    writeFileSync(MANIFEST, serializeManifest(manifest), "utf8");
    console.log(`清单已更新：${MANIFEST}`);
    if (failures.length) {
      console.error(`采集未完成：${failures.length} 个引擎不可用。`);
      process.exitCode = 1;
    }
    return;
  }

  // 检查模式。
  for (const run of runs) {
    const { fingerprint } = run;
    const label = `${fingerprint.engine}（${fingerprint.family} ${fingerprint.version}）· 平台 ${fingerprint.platform}`;
    const selection = selectBaseline(manifest, {
      scene: SCENE,
      engine: fingerprint.engine,
      platform: fingerprint.platform,
      family: fingerprint.family,
      version: fingerprint.version,
    });
    console.log(`引擎 ${label} · 视口 ${fingerprint.viewport.width}×${fingerprint.viewport.height}`);
    if (selection.status === "missing" || !selection.baseline) {
      console.log(`  未采集：${selection.notes.join("；")}`);
      const available = describeAvailableBaselines(manifest);
      if (available.length) {
        console.log("  已有基线：");
        for (const item of available) console.log(`    ${item}`);
      } else {
        console.log("  已有基线：（无）");
      }
      console.log(`  采集命令：npm run visual:cross-browser:baseline -- --engine=${fingerprint.engine}`);
      failures.push(`${fingerprint.engine} / ${fingerprint.platform} 没有基线`);
      continue;
    }

    const baseline = selection.baseline;
    for (const note of selection.notes) console.log(`  注意：${note}`);

    const differences = compareFingerprints(baseline.fingerprint, fingerprint);
    for (const difference of differences) {
      if (difference.field === "version") continue; // 版本漂移已经单独提示过。
      console.log(`  指纹差异 · ${difference.field}：${difference.expected} → ${difference.actual}${difference.note ? `（${difference.note}）` : ""}`);
    }

    if (baseline.fingerprint.viewport.width !== fingerprint.viewport.width || baseline.fingerprint.viewport.height !== fingerprint.viewport.height) {
      console.error("  视口尺寸与基线不同，无法逐像素比对；请用同样的 --width/--height 重新采集。");
      failures.push(`${fingerprint.engine} / ${fingerprint.platform} 视口与基线不一致`);
      continue;
    }

    if (fontSetChanged(baseline.fingerprint, fingerprint)) {
      console.error("  字体集指纹不同：基线不可比，像素差异不能归因于渲染回归。");
      console.error("  先在这台机器上重新采集基线（npm run visual:cross-browser:baseline），或确认字体集差异是预期的。");
      failures.push(`${fingerprint.engine} / ${fingerprint.platform} 字体集与基线不一致`);
      continue;
    }

    const expected = decodePng(readFileSync(join(BASELINE_ROOT, baseline.image)));
    const actual = decodePng(readFileSync(run.imagePath));
    if (expected.width !== actual.width || expected.height !== actual.height) {
      console.error(`  图片尺寸不一致：基线 ${expected.width}×${expected.height}，实测 ${actual.width}×${actual.height}`);
      failures.push(`${fingerprint.engine} / ${fingerprint.platform} 图片尺寸不一致`);
      continue;
    }
    const diff = diffImages(expected, actual);
    const passed = diff.ratio <= args.threshold;
    console.log(
      `  基线：${baseline.image}（采集于 ${baseline.collectedAt.slice(0, 10)}）`,
    );
    console.log(
      `  差异像素：${diff.differentPixels}/${diff.totalPixels}（${(diff.ratio * 100).toFixed(3)}%），`
      + `最大通道差 ${diff.maxChannelDelta}，AA 豁免 ${diff.antiAliasedPixels}`,
    );
    console.log(`  阈值 ${(args.threshold * 100).toFixed(3)}% → ${passed ? "通过" : "不通过"}`);
    if (!passed) failures.push(`${fingerprint.engine} / ${fingerprint.platform} 像素差异 ${(diff.ratio * 100).toFixed(3)}% 超过阈值`);
  }

  for (const id of args.required) {
    const covered = runs.some(run => run.fingerprint.engine === id);
    if (!covered) {
      failures.push(`要求的引擎 ${id} 不可用`);
      console.error(`要求的引擎 ${id} 不可用。`);
    }
  }

  if (skipped.length) {
    console.log(`跳过 ${skipped.length} 个不可用引擎：${skipped.join("、")}`);
  }

  if (failures.length) {
    console.error(`跨浏览器像素基线检查未通过：${failures.length} 项。`);
    process.exitCode = 1;
    return;
  }
  console.log(`跨浏览器像素基线检查通过（${runs.length} 个引擎）。`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
