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
 * 不做严格的"整段就是 JSON"假设，而是扫描出第一个配平的 JSON 对象再解析。
 */
export function parsePlanResponse(raw: string): AiCommandPlan {
  const text = raw.trim();
  if (!text) throw new PlanParseError("模型没有返回任何内容");

  const candidates = [stripFence(text), text];
  let parsed: unknown;
  let failure: string | undefined;
  for (const candidate of candidates) {
    const json = extractJsonObject(candidate);
    if (!json) continue;
    try {
      parsed = JSON.parse(json) as unknown;
      break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  if (parsed === undefined) {
    throw new PlanParseError(`模型回复里找不到合法的 JSON 计划${failure ? `：${failure}` : ""}`);
  }
  return normalizePlan(parsed);
}

function stripFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match ? match[1] : text;
}

/** 扫描出第一个配平的 JSON 对象，字符串里的括号不算。 */
function extractJsonObject(text: string): string | undefined {
  for (let index = text.indexOf("{"); index !== -1; index = text.indexOf("{", index + 1)) {
    const end = findObjectEnd(text, index);
    if (end !== -1) return text.slice(index, end + 1);
  }
  return undefined;
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
