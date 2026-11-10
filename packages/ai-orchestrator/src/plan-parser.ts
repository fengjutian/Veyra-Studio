import type { DesignCommand } from "@ufira/design-runtime";
import { isCommandType } from "./command-vocabulary";
import type { AiCommandPlan } from "./safe-ai-editor";

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

/**
 * 模型明确表示「没有要改的」。
 *
 * 这不是解析失败，而是一个合法结论——所以单独一个类型：编排循环靠它区分
 * 「模型认为没东西可改」（正常收工）和「模型回复是坏的」（该报错）。
 * 继承 `PlanParseError`，已有的 `instanceof PlanParseError` 判断不受影响。
 */
export class PlanEmptyError extends PlanParseError {
  constructor() {
    super("模型返回的计划没有包含任何命令");
    this.name = "PlanEmptyError";
  }
}

/**
 * 把模型回复解析成命令计划。
 *
 * 模型经常把 JSON 包在 ```json 围栏里，或者在 JSON 前后加一段说明，所以这里
 * 不做严格的"整段就是 JSON"假设，而是**逐个候选**试：扫出所有配平的 JSON 对象，
 * 一个能用就用。
 *
 * 逐个试而不是只取第一个，是因为**推理模型**（MiniMax-M3 等）会在正文前面加一段
 * `<think>…</think>` 推理，里面可能带花括号——只取第一个配平对象会取到推理里的
 * 碎片，解析失败或解析出别的东西。候选顺序是：剥掉推理块之后 → 剥掉围栏之后 →
 * 原文，所以正文里的真计划总是排在前面。
 *
 * ## 「能 parse」不等于「是计划」
 *
 * 候选里混进了推理块的碎片时，它**往往也是合法 JSON**——只是没有 `summary`、
 * 或者命令类型不在词汇表里。所以判定标准不是「能不能 parse」，而是
 * 「能不能 normalize 成一份计划」：不是计划就记下原因，接着试下一个候选。
 *
 * 这里踩过坑：早期版本 parse 成功就 `break`，于是第一个合法 JSON（推理块里的
 * `{"reasoning": "..."}` 之类）把整个解析锁死，后面的真计划根本没机会被看到，
 * 对外报的是「模型返回的计划缺少 summary」——模型明明给对了计划。
 */
export function parsePlanResponse(raw: string): AiCommandPlan {
  const text = raw.trim();
  if (!text) throw new PlanParseError("模型没有返回任何内容");

  const candidates = collectJsonCandidates(text);
  let parseFailure: string | undefined;
  let planFailure: string | undefined;
  // 「模型说没有要改的」也是合法结论，但要先把其它候选试完：
  // 推理块里可能先冒出一个空壳，真计划在后面。
  let emptyPlan: PlanEmptyError | undefined;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch (error) {
      parseFailure = error instanceof Error ? error.message : String(error);
      continue;
    }
    try {
      return normalizePlan(parsed);
    } catch (error) {
      if (error instanceof PlanEmptyError) {
        emptyPlan ??= error;
        continue;
      }
      // 这个候选不是计划（多半是推理块里的 JSON 碎片），记下来，试下一个。
      // 记**第一个**失败原因：候选是从外往里扫的，外层（也就是模型真正写的那份
      // 计划）的报错最有信息量。内层的碎片报错会把它盖掉。
      planFailure ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (emptyPlan) throw emptyPlan;
  const truncated = looksTruncated(text) ? "（回复被截断：max_tokens 预算不够，或生成被中断）" : "";
  throw new PlanParseError(
    planFailure
      ? `模型回复里找不到合法的 JSON 计划${truncated}：${planFailure}`
      : `模型回复里找不到合法的 JSON 计划${truncated}${parseFailure ? `：${parseFailure}` : ""}`,
  );
}

/**
 * 文本里有没配平的 `{` —— 回复多半被截断了。
 *
 * 截断的报错必须说清楚：模型确实给了计划，只是没写完。此时若报「缺少 summary」，
 * 排查的人会跑去改提示词，而真正要调的是 max_tokens——方向完全错了。
 */
function looksTruncated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth > 0;
}

/** 收集所有可能的 JSON 候选：先剥推理块、再剥围栏、最后原文，逐个变体扫配平对象。 */
function collectJsonCandidates(text: string): string[] {
  const variants = [stripReasoning(text), stripFence(text), text];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    for (const candidate of extractJsonObjects(variant)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * 剥掉推理块。
 *
 * 推理模型的正文长这样：`<think>先想一遍…</think>\n\n{计划}`。推理里可能带
 * 花括号，所以必须**先剥掉**再找 JSON。未闭合的推理块说明回复被截断了——
 * 后面不会再有正文，截掉即可。
 */
function stripReasoning(text: string): string {
  const stripped = text.replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, "");
  const opened = stripped.search(/<(think|thinking|reasoning|thought)>/i);
  return opened === -1 ? stripped : stripped.slice(0, opened);
}

function stripFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match ? match[1] : text;
}

/**
 * 扫出所有配平的 JSON 对象。
 *
 * 嵌套的也要：模型有时把计划包一层外壳（`{"plan": {…}}`），只扫顶层就永远看不到
 * 里头的计划。外壳先被试掉（它 normalize 不了），里头的接着试。
 */
function extractJsonObjects(text: string): string[] {
  const found: string[] = [];
  const scan = (from: number, to: number): void => {
    let index = text.indexOf("{", from);
    while (index !== -1 && index < to) {
      const end = findObjectEnd(text, index);
      if (end === -1) {
        // 这个 `{` 没有配平（多半是推理里的碎片，或回复被截断），换下一个继续找。
        index = text.indexOf("{", index + 1);
        continue;
      }
      found.push(text.slice(index, end + 1));
      // 外壳里可能直接装着计划，继续往里扫一层。
      scan(index + 1, end);
      index = text.indexOf("{", end + 1);
    }
  };
  scan(0, text.length);
  return found;
}

function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizePlan(value: unknown): AiCommandPlan {
  if (!isRecord(value)) throw new PlanParseError("模型返回的计划不是 JSON 对象");

  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) throw new PlanParseError("模型返回的计划缺少 summary");

  if (!Array.isArray(value.commands)) throw new PlanParseError("模型返回的计划缺少 commands 数组");
  if (!value.commands.length) throw new PlanEmptyError();

  const commands: DesignCommand[] = value.commands.map((command, index) => normalizeCommand(command, index));

  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  return { summary, commands, assumptions };
}

function normalizeCommand(command: unknown, index: number): DesignCommand {
  if (!isRecord(command)) throw new PlanParseError(`第 ${index + 1} 条命令不是对象`);
  if (!isCommandType(command.type)) {
    throw new PlanParseError(`第 ${index + 1} 条命令的类型 "${String(command.type)}" 不在允许的词汇表里`);
  }
  if (!isRecord(command.payload)) {
    throw new PlanParseError(`第 ${index + 1} 条命令（${command.type}）缺少 payload 对象`);
  }
  return { type: command.type, payload: command.payload } as DesignCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
