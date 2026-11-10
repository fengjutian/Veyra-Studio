/**
 * 「空白文档 → 一句话 → 出图」端到端验收探针。
 *
 *   npm run visual:from-scratch:probe
 *   npm run visual:from-scratch:probe -- --require-browser
 *   npm run visual:from-scratch:probe -- --prompt="做一个登录页"
 *   npm run visual:from-scratch:probe -- --stub
 *
 * ## 回答什么问题
 *
 * 编排循环已经能证明「AI 自己改设计」；视觉上下文已经能证明「模型看得见图」。
 * 但这两件事合起来仍留一个空档：**从一张白纸开始，一句话，能不能出一张设计稿。**
 *
 * 之前的验收都在有内容的文档上做（样例文档里已有一张对比度不足的文本）。
 * 空文档是另一回事：模型得自己决定建什么节点、放什么坐标、填什么颜色，
 * 而且它拿不到任何现成的东西可以参照。
 *
 * ## 探针走的是产品同一条路
 *
 *   一句话 → Planner（仓库自己的提示与解析器）→ 命令计划
 *          → dry-run（领域校验）→ 结构审查 → 事务提交
 *          → 画布渲染（Canvas 2D）→ PNG
 *
 * 中间没有一步是探针自己实现的：计划用 `SafeAiEditor.createPlan`，提交用
 * `confirm`，出图用 `capturePageScreenshot`——与「视觉上下文」给模型看图的是
 * 同一个渲染器，出来的就是用户在工作台里看到的那张。
 *
 * ## 为什么要能带反馈重试
 *
 * 一次就成不现实：模型偶尔会把字段写错（颜色写进不存在的 `appearance.fill`、
 * 文本漏 `text`），dry-run 会拦下来。编排循环的做法是把报错回喂给模型让它改一版，
 * 这里照抄：**回喂的次数会被如实报出来**——「改了 2 版才成」和「一次就成」是两件事，
 * 不能混着说。
 *
 * ## 凭据
 *
 * 真实模型那一跑需要端点与密钥，只从环境变量或 `--env-file=` 指定的文件读，
 * 不写进仓库、不写进报告。两者都没有时用 `--stub` 跑确定性替身——
 * 那只能证明「链路是通的」，**不能**证明「AI 会设计」，两者在报告里分开写。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { StudioProject } from "@ufira/studio-application";
import type { DesignDocument, DesignNode } from "@ufira/design-schema";
import { SafeAiEditor, createOpenAiCompatiblePlanner, type AiPlanner, type AiPlanRequest } from "@ufira/ai-orchestrator";
import { findBrowser } from "../../design-export/visual/browser";
import { decodePng } from "../../design-export/visual/png";
import { buildHarness } from "./build-harness";
import { launchHeadlessBrowser } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OUT_DIR = join(root, ".artifacts", "from-scratch");

const DEFAULT_PROMPT = "做一个登录页";
const DEFAULT_PAGE_ID = "page:1";
/** 最多让模型改几版。回喂次数会写进报告，不能悄悄吞掉。 */
const MAX_ATTEMPTS = 3;

interface Args {
  prompt: string;
  outDir: string;
  stub: boolean;
  requireBrowser: boolean;
  envFile?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    prompt: value("--prompt=") ?? DEFAULT_PROMPT,
    outDir: value("--out=") ?? OUT_DIR,
    stub: argv.includes("--stub"),
    requireBrowser: argv.includes("--require-browser"),
    envFile: value("--env-file="),
  };
}

interface ProviderConfig {
  baseUrl: string;
  model: string;
  key: string;
}

/** 读 `KEY=VALUE` 形式的文件；`#` 开头是注释。 */
function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const file = resolve(path);
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/**
 * 端点配置：环境变量优先，其次 `--env-file=` 指定的文件。
 *
 * 两者都没有就返回 undefined——这时只能跑 `--stub`，不能假装跑过真实模型。
 */
function readProviderConfig(args: Args): ProviderConfig | undefined {
  const file = readEnvFile(args.envFile);
  const baseUrl = (process.env.STUDIO_PROVIDER_BASE ?? file.STUDIO_PROVIDER_BASE ?? "").trim();
  const model = (process.env.STUDIO_PROVIDER_MODEL ?? file.STUDIO_PROVIDER_MODEL ?? "").trim();
  const key = (process.env.STUDIO_PROVIDER_KEY ?? file.STUDIO_PROVIDER_KEY ?? "").trim();
  if (!baseUrl || !model || !key) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, key };
}

/** AI 那一步的结果。 */
interface AiOutcome {
  ok: boolean;
  document?: DesignDocument;
  summary?: string;
  assumptions?: string[];
  commands?: Array<{ type: string }>;
  warnings?: string[];
  review?: { blocking: boolean; findings: Array<{ severity: string; message: string }> };
  attempts: number;
  /** 每一轮的结果摘要（含失败原因），如实的。 */
  rounds: string[];
}

/**
 * 跑「一句话 → 设计文档」。
 *
 * dry-run 失败（模型把字段写错了）时把报错回喂给模型让它改一版，和编排循环一个做法。
 */
async function runAiStep(planner: AiPlanner, prompt: string): Promise<AiOutcome> {
  const repository = new FileSystemProjectRepository(mkdtempSync(join(tmpdir(), "design-ai-from-scratch-")));
  const project = await StudioProject.create(repository, "project:from-scratch", "空白文档", DEFAULT_PAGE_ID);
  const editor = new SafeAiEditor(project, planner);

  const rounds: string[] = [];
  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const request = feedback ? `${prompt}\n\n上一版的命令跑不通，请修正后重新给出完整计划：\n${feedback}` : prompt;
    const startedAt = Date.now();
    try {
      const preview = await editor.createPlan(request, []);
      await editor.confirm(preview.planId);
      const document = project.snapshot();
      rounds.push(`第 ${attempt} 次：成功，落地 ${preview.commands.length} 条命令（${Date.now() - startedAt}ms）`);
      return {
        ok: true,
        document,
        summary: preview.summary,
        assumptions: preview.assumptions,
        commands: preview.commands.map(command => ({ type: command.type })),
        warnings: preview.warnings,
        review: {
          blocking: preview.review.blocking,
          findings: preview.review.findings.map(finding => ({ severity: finding.severity, message: finding.message })),
        },
        attempts: attempt,
        rounds,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rounds.push(`第 ${attempt} 次：失败（${Date.now() - startedAt}ms）—— ${message.slice(0, 300)}`);
      feedback = message;
    }
  }
  return { ok: false, attempts: MAX_ATTEMPTS, rounds };
}

/**
 * 用**工作台那套 Canvas 2D 渲染器**把文档画成 PNG。
 *
 * 走的是 `capturePageScreenshot`——和「视觉上下文」给模型看图的是同一条路径，
 * 所以产出的图就是用户在画布上看到的那张。
 */
async function renderPng(document: DesignDocument, outDir: string): Promise<{ path: string; width: number; height: number }> {
  const harnessPath = await buildHarness("from-scratch");
  const pagePath = join(outDir, "harness.html");
  copyFileSync(harnessPath, pagePath);
  writeFileSync(join(outDir, "document.json"), JSON.stringify(document), "utf8");

  const server = await serveDirectory(outDir);
  const browser = findBrowser();
  if (!browser) throw new Error("未找到 Chrome/Edge；设置 CHROME_PATH 后重试");
  const launched = await launchHeadlessBrowser(browser);
  try {
    const page = await launched.newPage(`${server.url}harness.html`);
    const result = await waitForResult(page);
    if (!result.ok) throw new Error(`渲染失败：${result.error ?? "未知原因"}`);
    const image = result.image;
    if (!image) throw new Error("渲染结果里没有图片");
    const base64 = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
    const pngPath = join(outDir, "render.png");
    writeFileSync(pngPath, Buffer.from(base64, "base64"));
    return { path: pngPath, width: image.width, height: image.height };
  } finally {
    await launched.close();
    await server.close();
  }
}

interface HarnessPayload {
  ok: boolean;
  error?: string;
  image?: { dataUrl: string; mimeType: string; width: number; height: number };
  nodeCount?: number;
  pageId?: string;
}

/** 轮询 harness 页面，等它把渲染结果写进 `#from-scratch-result`。 */
async function waitForResult(page: { evaluate<T>(expression: string): Promise<T> }, timeoutMs = 60_000): Promise<HarnessPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await page.evaluate<string>(
      'document.querySelector("#from-scratch-result")?.textContent ?? document.querySelector("#from-scratch-error")?.textContent ?? ""',
    );
    if (raw) {
      try {
        return JSON.parse(raw) as HarnessPayload;
      } catch {
        throw new Error(`harness 输出的不是 JSON：${raw.slice(0, 200)}`);
      }
    }
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`harness 在 ${timeoutMs}ms 内没有产出结果`);
}

/**
 * 像素级检查：图上到底画了东西没有。
 *
 * 只看「文件存在」是不够的——一张全透明的 PNG 也是「成功」写出来的，
 * 但它什么都不是。所以这里数**被画过的像素**（alpha > 0）和**不同颜色数**。
 */
interface PixelReport {
  width: number;
  height: number;
  paintedPixels: number;
  distinctColors: number;
  blank: boolean;
}

function inspectPixels(pngPath: string): PixelReport {
  const image = decodePng(readFileSync(pngPath));
  const colors = new Set<string>();
  let paintedPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3]! > 0) {
      paintedPixels += 1;
      colors.add(`${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`);
    }
  }
  return {
    width: image.width,
    height: image.height,
    paintedPixels,
    distinctColors: colors.size,
    blank: paintedPixels === 0 || colors.size < 3,
  };
}

/**
 * 确定性替身：手写一份登录页计划。
 *
 * 它**不能**证明「AI 会设计」——它只证明链路是通的：空白文档 → 计划 → 提交 →
 * 渲染 → PNG 这五步在真实运行时里走得通。没有 Key 时先跑它，可以把
 * 「链路坏了」和「模型不行」这两件事分开。
 */
function stubPlanner(): AiPlanner {
  return {
    async plan(_request: AiPlanRequest) {
      const commands = [
        { type: "node.create", payload: { node: frame("frame:card", DEFAULT_PAGE_ID, 280, 120, 400, 440, "#ffffff", 16) } },
        { type: "node.create", payload: { node: text("text:title", "frame:card", 32, 40, 336, 40, "欢迎回来", 28, 36, "#0f172a", 700) } },
        { type: "node.create", payload: { node: text("text:subtitle", "frame:card", 32, 88, 336, 24, "登录以继续", 14, 20, "#64748b") } },
        { type: "node.create", payload: { node: frame("frame:field-user", "frame:card", 32, 136, 336, 44, "#f1f5f9", 8) } },
        { type: "node.create", payload: { node: frame("frame:field-pass", "frame:card", 32, 192, 336, 44, "#f1f5f9", 8) } },
        { type: "node.create", payload: { node: frame("frame:button", "frame:card", 32, 256, 336, 48, "#2563eb", 8) } },
        { type: "node.create", payload: { node: text("text:button-label", "frame:button", 0, 12, 336, 24, "登录", 16, 24, "#ffffff", 500, "center") } },
      ];
      // 命令按「先建父、再建子」的顺序给出：`node.create` 会把新节点自动挂进
      // parentId 指向的容器的 childIds，所以不需要额外的 reparent。
      return { summary: "（替身规划器）搭一张登录卡片", assumptions: [], commands: commands as never[] };
    },
  };
}

function frame(id: string, parentId: string, x: number, y: number, width: number, height: number, fill: string, cornerRadius: number): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { mode: "absolute", x, y, width, height, widthMode: "fixed", heightMode: "fixed" },
    appearance: { opacity: 1, fills: [{ type: "solid", color: fill }], cornerRadius },
  } as DesignNode;
}

function text(
  id: string,
  parentId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  fontSize: number,
  lineHeight: number,
  fill: string,
  fontWeight = 400,
  textAlign: "left" | "center" | "right" = "left",
): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { mode: "absolute", x, y, width, height, widthMode: "fixed", heightMode: "fixed" },
    appearance: { opacity: 1, fills: [{ type: "solid", color: fill }] },
    text: value,
    fontFamily: "Inter",
    fontSize,
    lineHeight,
    fontWeight,
    textAlign,
  } as DesignNode;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const provider = readProviderConfig(args);
  const usingStub = args.stub || !provider;
  if (!args.stub && !provider) {
    console.log("没有找到端点配置（STUDIO_PROVIDER_BASE / MODEL / KEY 或 --env-file=），改跑确定性替身。");
    console.log("替身只能证明链路通，**不能**证明 AI 会设计。真实模型那一跑请补上凭据。\n");
  }
  if (args.stub) console.log("以 --stub 运行：确定性替身，不代表真实模型的表现。\n");

  const planner: AiPlanner = usingStub
    ? stubPlanner()
    : createOpenAiCompatiblePlanner({
        baseUrl: provider!.baseUrl,
        model: provider!.model,
        apiKey: provider!.key,
        jsonMode: true,
        temperature: 0.3,
        // 一张页面的计划有十几条 node.create，每条 payload 都带完整节点对象——
        // 上限给窄了会被截断成非法 JSON，解析器连报错都报不到点上。
        // 实测 MiniMax-M3 出这一页要 ~12k token（其中约 4.9k 花在推理上）。
        maxTokens: Number(process.env.STUDIO_PROVIDER_MAX_TOKENS ?? 32768),
        // 流式与工作台一致：产品走的就是流式，这里也走同一条路。
        stream: true,
        // planner 的默认超时是 60 秒，而带推理的整页计划经常跑不过它：
        // MiniMax-M3 先出 `<think>` 推理段，再吐十几条 node.create 的 JSON，
        // 整体常在一分半到两三分钟。超时可以用环境变量调。
        timeoutMs: Number(process.env.STUDIO_PROVIDER_TIMEOUT_MS ?? 300000),
      });

  console.log(`需求：${args.prompt}`);
  console.log(`模式：${usingStub ? "确定性替身" : `真实模型 ${provider!.model} @ ${provider!.baseUrl}`}`);
  console.log(`起点：空白文档（一个空页面 ${DEFAULT_PAGE_ID}，零个节点）\n`);

  const outcome = await runAiStep(planner, args.prompt);
  for (const round of outcome.rounds) console.log(`  ${round}`);
  if (!outcome.ok) {
    console.error("\n✗ AI 没能给出可落地的计划。");
    process.exitCode = 1;
    return;
  }

  const document = outcome.document!;
  const nodeCount = Object.keys(document.nodes).length;
  const pageId = document.pageOrder[0] ?? DEFAULT_PAGE_ID;
  const pageChildren = document.pages[pageId]?.childIds.length ?? 0;
  console.log(`\n计划摘要：${outcome.summary}`);
  console.log(`落地节点：${nodeCount} 个（页面顶层 ${pageChildren} 个）`);
  console.log(`命令类型：${outcome.commands!.map(command => command.type).join(", ")}`);
  if (outcome.warnings?.length) console.log(`运行时警告：${outcome.warnings.join("；")}`);
  if (outcome.review?.findings.length) {
    console.log(`结构审查：${outcome.review.findings.map(finding => `[${finding.severity}] ${finding.message}`).join("；")}`);
  }

  const report: Record<string, unknown> = {
    mode: usingStub ? "stub" : "real",
    model: usingStub ? "(stub planner)" : provider!.model,
    baseUrl: usingStub ? null : provider!.baseUrl,
    prompt: args.prompt,
    attempts: outcome.attempts,
    rounds: outcome.rounds,
    summary: outcome.summary,
    assumptions: outcome.assumptions,
    commands: outcome.commands,
    warnings: outcome.warnings,
    review: outcome.review,
    nodeCount,
    pageChildren,
  };

  let pixels: PixelReport | undefined;
  try {
    const rendered = await renderPng(document, args.outDir);
    pixels = inspectPixels(rendered.path);
    report.render = { path: rendered.path, ...pixels };
    console.log(`\n出图：${rendered.path}（${rendered.width}×${rendered.height}）`);
    console.log(`像素：画过的像素 ${pixels.paintedPixels}，不同颜色 ${pixels.distinctColors}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.renderError = message;
    console.error(`\n✗ 出图失败：${message}`);
    if (args.requireBrowser) process.exitCode = 1;
  }

  writeFileSync(join(args.outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(args.outDir, "document.json"), JSON.stringify(document), "utf8");

  // 判据：AI 给出了计划并落地、页面不是空的、图上真的画了东西。
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: "AI 给出可落地的计划", ok: outcome.commands!.length > 0, detail: `${outcome.commands!.length} 条命令` },
    { name: "命令跑进真实运行时", ok: nodeCount > 0, detail: `文档里有 ${nodeCount} 个节点` },
    { name: "页面不是空的", ok: pageChildren > 0, detail: `页面顶层 ${pageChildren} 个节点` },
    { name: "出图非空", ok: Boolean(pixels && !pixels.blank), detail: pixels ? `画过的像素 ${pixels.paintedPixels}，不同颜色 ${pixels.distinctColors}` : "没有出图" },
  ];
  console.log("");
  for (const check of checks) console.log(`${check.ok ? "✔" : "✗"} ${check.name}：${check.detail}`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;

  if (usingStub) {
    console.log("\n注意：这一轮是确定性替身。它证明链路通，不证明「AI 会设计」——");
    console.log("后者要真实模型跑一遍（补上端点与密钥后去掉 --stub）。");
  } else {
    console.log(`\n真实模型用了 ${outcome.attempts} 次尝试。`);
    if (outcome.attempts > 1) console.log("「一次就成」不成立：首版命令有字段错误，回喂报错后改的。");
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
