/**
 * 真实 Provider 验收工具。
 *
 *   npm run ai:provider:acceptance
 *   npm run ai:provider:acceptance -- --verify
 *   npm run ai:provider:acceptance -- --loop
 *
 * 能力矩阵以前是「读一遍各家文档 + 人工填表」。那不是验收，是转述——文档说的
 * 和服务实际做的经常对不上。这个工具把每项能力都**实测**一遍：
 *
 *   ① `/models` 能不能列出模型；
 *   ② 普通对话能不能通；
 *   ③ `response_format: json_object` 会不会被遵守；
 *   ④ SSE 流式能不能收到增量；
 *   ⑤ **规划器往返**：仓库自己的提示 → 模型回复 → 解析成命令计划 → dry-run 落地。
 *
 * ⑤ 才是真验收：它用的就是产品里那套提示与解析器，模型给的命令要能被命令词汇表
 * 接受、还要能在真实运行时里跑通。少了 ⑤，前四项都只是「接口能通」。
 *
 * `--loop` 额外跑一次**编排循环**（体检 → 计划 → 提交 → 再体检），看真实模型能不能
 * 照着待修清单改对、能不能收敛。
 *
 * 密钥只从环境变量读，不写进仓库、不进报告。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { DesignRuntime } from "@ufira/design-runtime";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import {
  COMMAND_TYPES,
  SafeAiEditor,
  buildPlannerPrompt,
  createOpenAiCompatiblePlanner,
  parsePlanResponse,
  runAutonomousLoop,
  type AiPlanRequest,
} from "../src/index";

interface Args {
  verify: boolean;
  loop: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    verify: argv.includes("--verify"),
    loop: argv.includes("--loop"),
    verbose: argv.includes("--verbose"),
  };
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const failures: string[] = [];

/** 剥掉推理块，看正文里是不是纯 JSON。 */
function stripReasoning(text: string): string {
  const stripped = text.replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, "");
  const opened = stripped.search(/<(think|thinking|reasoning|thought)>/i);
  return opened === -1 ? stripped : stripped.slice(0, opened);
}

/** 验收用的样例文档：一个对比度不足的文本节点。 */
function fixtureDocument(): DesignDocument {
  const document = createDocument("project:acceptance", "验收样例", "page:1");
  const runtime = new DesignRuntime(document);
  const node: DesignNode = {
    id: "text:title",
    type: "text",
    name: "标题",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 16, y: 16, width: 320, height: 40 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#999999" }] },
    text: "对比度不足的标题",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  };
  runtime.execute({
    commandId: "fixture:1",
    documentId: document.id,
    baseRevision: 0,
    actor: { type: "human", id: "fixture" },
    commands: [{ type: "node.create", payload: { node } }],
  });
  return runtime.snapshot();
}

interface ProviderConfig {
  baseUrl: string;
  model: string;
  key: string;
}

function readConfig(): ProviderConfig {
  const baseUrl = (process.env.STUDIO_PROVIDER_BASE ?? "").trim();
  const model = (process.env.STUDIO_PROVIDER_MODEL ?? "").trim();
  const key = (process.env.STUDIO_PROVIDER_KEY ?? "").trim();
  if (!baseUrl || !model) {
    console.error("需要环境变量 STUDIO_PROVIDER_BASE 与 STUDIO_PROVIDER_MODEL（例如 https://api.minimaxi.com/v1 与 MiniMax-M3）");
    process.exit(2);
  }
  if (!key) {
    console.error("需要环境变量 STUDIO_PROVIDER_KEY（密钥只从环境读，不会写进仓库或报告）");
    process.exit(2);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, key };
}

function authHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

async function checkModels(config: ProviderConfig): Promise<CheckResult> {
  try {
    const response = await fetch(`${config.baseUrl}/models`, { headers: authHeaders(config.key) });
    const text = await response.text();
    if (!response.ok) return { name: "models", ok: false, detail: `HTTP ${response.status}：${text.slice(0, 200)}` };
    const payload = JSON.parse(text) as { data?: Array<{ id?: string }> };
    const ids = (payload.data ?? []).map(item => item.id ?? "");
    const hasModel = ids.includes(config.model);
    return {
      name: "models",
      ok: hasModel,
      detail: hasModel ? `可用模型 ${ids.length} 个，含 ${config.model}` : `模型列表里没有 ${config.model}，实际：${ids.join(", ") || "(空)"}`,
    };
  } catch (error) {
    return { name: "models", ok: false, detail: `请求失败：${String(error)}` };
  }
}

async function postChat(config: ProviderConfig, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(config.key),
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function checkChat(config: ProviderConfig): Promise<CheckResult> {
  try {
    const { status, text } = await postChat(config, {
      model: config.model,
      messages: [{ role: "user", content: "只回答两个字：收到" }],
      max_tokens: 64,
    });
    if (status !== 200) return { name: "chat", ok: false, detail: `HTTP ${status}：${text.slice(0, 200)}` };
    const content = extractContent(text);
    return { name: "chat", ok: Boolean(content.trim()), detail: content.trim() ? `回复：${content.trim().slice(0, 60)}` : "回复是空的" };
  } catch (error) {
    return { name: "chat", ok: false, detail: `请求失败：${String(error)}` };
  }
}

async function checkJsonMode(config: ProviderConfig): Promise<CheckResult> {
  try {
    const { status, text } = await postChat(config, {
      model: config.model,
      messages: [{ role: "user", content: '输出一个 JSON 对象：{"ok":true,"items":[1,2]}' }],
      response_format: { type: "json_object" },
      max_tokens: 128,
    });
    if (status !== 200) return { name: "jsonMode", ok: false, detail: `HTTP ${status}：${text.slice(0, 200)}` };
    const content = extractContent(text);
    const body = stripReasoning(content).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return {
        name: "jsonMode",
        ok: false,
        detail: `请求被接受，但正文不是可直接解析的 JSON：${body.slice(0, 160)}`,
      };
    }
    const pure = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    return {
      name: "jsonMode",
      ok: pure,
      detail: pure
        ? `遵守 json_object${content.trim() !== body.trim() ? "（正文带推理前缀，解析器需剥离）" : ""}`
        : "正文不是 JSON 对象",
    };
  } catch (error) {
    return { name: "jsonMode", ok: false, detail: `请求失败：${String(error)}` };
  }
}

async function checkStream(config: ProviderConfig): Promise<CheckResult> {
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(config.key),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "数到三" }],
        stream: true,
        max_tokens: 64,
      }),
    });
    if (!response.ok) return { name: "stream", ok: false, detail: `HTTP ${response.status}` };
    const reader = response.body?.getReader();
    if (!reader) return { name: "stream", ok: false, detail: "响应没有 body，拿不到流" };
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (delta) { content += delta; chunks += 1; }
        } catch {
          // 不认识的行跳过：网关会插心跳与注释。
        }
      }
    }
    return {
      name: "stream",
      ok: chunks > 0 && content.trim().length > 0,
      detail: chunks > 0 ? `收到 ${chunks} 段增量，共 ${content.length} 字` : "没有收到任何增量",
    };
  } catch (error) {
    return { name: "stream", ok: false, detail: `请求失败：${String(error)}` };
  }
}

/**
 * 规划器往返：仓库自己的提示 → 真实模型 → 解析成命令计划 → dry-run 落地。
 *
 * 这一项过了，才算「这个 Provider 能驱动本产品的 AI 编辑链路」。
 */
async function checkPlanRoundTrip(config: ProviderConfig): Promise<CheckResult> {
  const document = fixtureDocument();
  const request: AiPlanRequest = {
    prompt: "把标题的文字颜色改成深色，让它达到 4.5:1 的对比度",
    document,
    selectedNodeIds: ["text:title"],
  };
  const prompt = buildPlannerPrompt(request);
  try {
    const { status, text } = await postChat(config, {
      model: config.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2048,
      temperature: 0.2,
    });
    if (status !== 200) return { name: "planRoundTrip", ok: false, detail: `HTTP ${status}：${text.slice(0, 300)}` };
    const content = extractContent(text);
    const plan = parsePlanResponse(content);
    const unknown = plan.commands.filter(command => !(COMMAND_TYPES as readonly string[]).includes(command.type));
    if (unknown.length) {
      return { name: "planRoundTrip", ok: false, detail: `计划里有词汇表之外的命令：${unknown.map(command => command.type).join(", ")}` };
    }
    if (!plan.commands.length) return { name: "planRoundTrip", ok: false, detail: "计划里没有命令" };

    // dry-run：命令必须能在真实运行时里跑通。
    const runtime = new DesignRuntime(document);
    const result = runtime.execute({
      commandId: "acceptance:1",
      documentId: document.id,
      baseRevision: document.revision,
      actor: { type: "ai", id: "acceptance" },
      commands: plan.commands,
    });
    if (result.ok === false) {
      return { name: "planRoundTrip", ok: false, detail: `dry-run 失败：${JSON.stringify(result)}` };
    }
    return {
      name: "planRoundTrip",
      ok: true,
      detail: `解析出 ${plan.commands.length} 条命令（${plan.commands.map(command => command.type).join(", ")}），dry-run 通过`,
    };
  } catch (error) {
    return { name: "planRoundTrip", ok: false, detail: `往返失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 编排循环往返：真实模型能不能照着待修清单改对。
 *
 * 这是「AI 自己跑」最关键的一问——前面的检查只证明单轮能通，这里证明多轮能收敛。
 */
async function checkLoop(config: ProviderConfig): Promise<CheckResult> {
  const repository = new FileSystemProjectRepository(mkdtempSync(join(tmpdir(), "design-ai-acceptance-")));
  const project = await StudioProject.create(repository, "project:acceptance", "验收样例", "page:1");
  const fixture = fixtureDocument();
  await project.execute({
    commandId: "fixture:1",
    documentId: project.snapshot().id,
    baseRevision: project.snapshot().revision,
    actor: { type: "human", id: "fixture" },
    commands: fixture.nodes["text:title"]
      ? [{ type: "node.create", payload: { node: fixture.nodes["text:title"]! } }]
      : [],
  });

  const planner = createOpenAiCompatiblePlanner({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.key,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 2048,
  });
  const editor = new SafeAiEditor(project, planner);
  try {
    const result = await runAutonomousLoop(editor, {
      goal: "把这份设计的可访问性问题修掉",
      maxRounds: 3,
    });
    const detail = `停止原因 ${result.stopReason}，跑了 ${result.rounds.length} 轮，落地 ${result.appliedCommands} 条命令；${
      result.rounds.map(round => round.summary).join(" / ")
    }`;
    return { name: "loop", ok: result.stopReason === "converged", detail };
  } catch (error) {
    return { name: "loop", ok: false, detail: `循环失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 从响应里取正文（容忍各家不同的字段名）。 */
function extractContent(raw: string): string {
  try {
    const payload = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string }; text?: string; delta?: { content?: string } }> };
    const choice = payload.choices?.[0];
    return choice?.message?.content ?? choice?.text ?? choice?.delta?.content ?? "";
  } catch {
    return raw;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();

  console.log(`验收对象：${config.model} @ ${config.baseUrl}\n`);

  const checks: CheckResult[] = [];
  checks.push(await checkModels(config));
  checks.push(await checkChat(config));
  checks.push(await checkJsonMode(config));
  checks.push(await checkStream(config));
  checks.push(await checkPlanRoundTrip(config));
  if (args.loop) checks.push(await checkLoop(config));

  for (const check of checks) {
    console.log(`${check.ok ? "✔" : "✗"} ${check.name}：${check.detail}`);
    if (!check.ok) failures.push(`${check.name} —— ${check.detail}`);
  }

  const record = {
    providerId: providerIdOf(config.baseUrl),
    baseUrl: config.baseUrl,
    model: config.model,
    verifiedAt: new Date().toISOString().slice(0, 10),
    checks: {
      models: checks.find(check => check.name === "models")?.ok ?? false,
      chat: checks.find(check => check.name === "chat")?.ok ?? false,
      jsonMode: checks.find(check => check.name === "jsonMode")?.ok ?? false,
      stream: checks.find(check => check.name === "stream")?.ok ?? false,
      planRoundTrip: checks.find(check => check.name === "planRoundTrip")?.ok ?? false,
      bearerAuth: true,
    },
    notes: checks.map(check => `${check.name}：${check.detail}`),
  };

  console.log("\n验收记录（贴进 packages/ai-orchestrator/src/provider-acceptance.ts）：");
  console.log(JSON.stringify(record, null, 2));

  if (args.verify) {
    const { PROVIDER_ACCEPTANCE } = await import("../src/provider-acceptance");
    const committed = PROVIDER_ACCEPTANCE.find(item => item.providerId === record.providerId && item.baseUrl === record.baseUrl);
    if (!committed) {
      failures.push(`仓库里没有 ${record.providerId} 的验收记录`);
    } else {
      for (const [name, value] of Object.entries(record.checks)) {
        const stored = (committed.checks as Record<string, boolean>)[name];
        if (stored !== value) failures.push(`验收记录与实测不一致：${name} 仓库记 ${String(stored)}，实测 ${String(value)}`);
      }
    }
  }

  if (failures.length) {
    console.error(`\n验收失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n真实 Provider 验收通过。");
}

/** 从地址反推预设 id（验收记录靠它关联到能力矩阵）。 */
function providerIdOf(baseUrl: string): string {
  const target = baseUrl.toLowerCase().replace(/\/+$/, "");
  if (target.startsWith("https://api.minimaxi.com")) return "minimax";
  if (target.startsWith("https://api.minimax.io")) return "minimax-intl";
  if (target.startsWith("https://api.openai.com")) return "openai";
  if (target.startsWith("https://api.deepseek.com")) return "deepseek";
  if (target.startsWith("https://openrouter.ai")) return "openrouter";
  if (target.includes("11434")) return "ollama";
  if (target.includes(":8000")) return "vllm";
  if (target.includes(":1234")) return "lmstudio";
  return "custom";
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
