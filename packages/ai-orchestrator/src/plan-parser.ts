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
  // 整份计划解析不了，先试试按命令抢救——别让「一处少写一个括号」毁掉整页。
  const salvaged = salvagePlan(text);
  if (salvaged) return salvaged;
  const structure = describeStructureProblem(text);  throw new PlanParseError(
    [
      "模型回复里找不到合法的 JSON 计划",
      structure ? `（${structure}）` : "",
      planFailure ? `：${planFailure}` : parseFailure ? `：${parseFailure}` : "",
    ].join(""),
  );
}

/**
 * 从坏掉的回复里**抢救命令**。
 *
 * ## 为什么需要
 *
 * 整份计划是一个巨大的 JSON 对象。模型在一条命令末尾少写一个 `}`，
 * 整份 JSON 就不配平，于是**整页**几十条命令全部作废——重新生成一遍要几十秒，
 * 而且模型很可能在同一个地方再错一次。
 *
 * 实测一份 58 条命令、3 万字的回复里只错了两处括号：按命令切块之后，
 * 57 条命令单独拿出来都是好的。少写括号这种「差一点」的失败，没理由整页扔掉。
 *
 * ## 为什么安全
 *
 * 抢救出来的命令**照样走 dry-run、结构审查与事务提交**——安全网一点没松：
 * 语法坏掉的命令会被丢掉，语义错的命令会被 dry-run 拦下。
 * 唯一多出来的是「这份计划可能不完整」，所以摘要里明说，不静默。
 *
 * ## 边界
 *
 * 只在**整份计划的 JSON 是坏的**时候才启用：
 *
 * - JSON 本身没问题、只是内容不合计划要求（比如缺 summary）→ 不抢救，照实报错；
 * - 回复明显是**被截断**的（结尾停在半句话上）→ 不抢救，报错要指��调 token 预算。
 *
 * 能正常解析的回复走老路径，行为不变。
 */
function salvagePlan(text: string): AiCommandPlan | undefined {
  // 前提一：JSON 是坏的（外层对象要么不配平，要么 parse 不过）。
  if (!isMalformedJson(text)) return undefined;
  // 前提二：回复像是写完了的。被截断的回复结尾停在半句话上，
  // 那种情况要报「被截断」，抢救出来的半截计划反而会掩盖真正的问题。
  if (!/[}\]]\s*$/.test(text.trim())) return undefined;

  const starts = findCommandStarts(text);
  if (!starts.length) return undefined;

  const commands: DesignCommand[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]!;
    const to = index + 1 < starts.length ? starts[index + 1]! : text.length;
    const extracted = extractCommandObject(text, from, to);
    if (extracted === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted) as unknown;
    } catch {
      // 这一块自己也坏了，丢掉。
      continue;
    }
    try {
      commands.push(normalizeCommand(parsed, commands.length));
    } catch {
      // 类型不在词汇表 / 缺 payload：不是一条可用命令，丢掉。
    }
  }
  if (!commands.length) return undefined;
  // 前提三：救回的是「大部分」命令。救回零星几条说明回复多半是被砍断的，
  // 那不该悄悄给出一份残缺的计划。
  if (commands.length * 2 < starts.length) return undefined;

  const summary = extractSummary(text);
  const note = `模型回复的 JSON 不完整（少写或多了括号），已从回复中抢救出 ${commands.length} 条命令`;
  return {
    summary: summary ? `${note}：${summary}` : note,
    commands,
    assumptions: [note],
  };
}

/**
 * 回复里的 JSON 是不是**坏的**。
 *
 * 看的是**最外层**那个对象：它要么不配平（模型少写括号），要么 parse 不过
 * （结构写错了）。最外层能 parse 成功，说明 JSON 本身没问题——那就不是
 * 「结构坏了」，不该走抢救。
 */
function isMalformedJson(text: string): boolean {
  for (const variant of [stripReasoning(text), stripFence(text), text]) {
    const start = variant.indexOf("{");
    if (start === -1) continue;
    const end = findObjectEnd(variant, start);
    if (end === -1) continue; // 外层不配平：坏掉了。
    try {
      JSON.parse(variant.slice(start, end + 1));
      return false; // 外层能 parse：JSON 没问题。
    } catch {
      // parse 不过：坏掉了，继续看下一个变体。
    }
  }
  return true;
}

/**
 * 找出回复里所有**命令对象**的起始位置。
 *
 * 边界必须认准：`fills` 里也有 `"type":"solid"`，所以光看 `"type":` 会把
 * 每个填充色都当成一条命令。认的是 `{"type":"<命令类型>"}`，且类型要过词汇表。
 */
function findCommandStarts(text: string): number[] {
  const starts: number[] = [];
  const pattern = /\{"type":"([a-zA-Z][a-zA-Z0-9.]*)"/g;
  let match = pattern.exec(text);
  while (match) {
    if (isCommandType(match[1]!)) starts.push(match.index);
    match = pattern.exec(text);
  }
  return starts;
}

/**
 * 从一段文本里取出**一个命令对象**。
 *
 * 命令对象里没有裸的 `]`（数组都是配对的 `[…]`），所以遇到一个没有对应 `[` 的 `]`
 * 就说明**外层结构的收尾提前插进来了**——那正是「模型少写了一个 `}`」的连锁反应：
 * 少一个 `}`，外层数组的 `]` 就提前闭合。命令到这里就结束，后面的 `]` `}` 不要。
 *
 * 三种结尾都要处理：
 *
 * 1. 结尾正常——深度回到 0 的那个 `}` 就是命令对象的末尾；
 * 2. 结尾缺 `}`——模型少写了闭合括号，深度到最后还差几层，补齐即可；
 * 3. 字符串没闭合——这块被截断了，补也没用，丢掉。
 */
function extractCommandObject(text: string, from: number, to: number): string | undefined {
  // 块末尾是「逗号分隔符」——补 `}` 之前要先把它去掉，否则补出来的 JSON 结尾是 `},}`。
  const chunk = text.slice(from, to).replace(/[\s,]+$/, "");
  let depth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "[") {
      arrayDepth += 1;
      continue;
    }
    if (char === "]") {
      if (arrayDepth > 0) {
        arrayDepth -= 1;
        continue;
      }
      // 裸 `]`：外层结构的收尾提前插进来了，命令到这里结束。
      return closeChunk(chunk.slice(0, index));
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return chunk.slice(0, index + 1);
      if (depth < 0) return undefined;
    }
  }
  if (inString) return undefined;
  return closeChunk(chunk);
}

/** 补齐末尾缺的 `}`；已经配平就原样返回。 */
function closeChunk(chunk: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of chunk) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth > 0 ? chunk + "}".repeat(depth) : chunk;
}

/** 从坏掉的回复里把摘要抠出来（正则匹配，值里的引号按 JSON 字符串规则解）。 */
function extractSummary(text: string): string {
  const match = /"summary"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (!match) return "";
  try {
    const value = JSON.parse(match[1]!) as unknown;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 括号配平情况：配平 / 少写 / 字符串没闭合，并给出第一处出问题的位置。
 */
interface BraceBalance {
  kind: "balanced" | "unclosed" | "string";
  /** 第一处出问题的字符下标（少写时是最外层那个一直没闭合的 `{`）。 */
  position: number;
  /** 结束时仍未闭合的 `{` 的个数。 */
  depth: number;
}

function braceBalance(text: string): BraceBalance {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let openAt = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) openAt = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) openAt = 0;
    }
  }
  if (inString) return { kind: "string", position: openAt, depth };
  if (depth > 0) return { kind: "unclosed", position: openAt, depth };
  return { kind: "balanced", position: 0, depth: 0 };
}

/**
 * 括号没配平时给出的诊断。
 *
 * 「少写 N 个闭合括号」比「回复被截断」有用得多：前者指向**模型写漏了**，
 * 后者指向**预算不够**——两者的修法完全不同（改模板/改闭合 vs 调 max_tokens）。
 */
function describeStructureProblem(text: string): string | undefined {
  const balance = braceBalance(text);
  if (balance.kind === "balanced") return undefined;
  const tail = text.slice(-40).replace(/\s+/g, " ");
  if (balance.kind === "string") {
    // 结尾停在一个没关上的字符串里——这就是被截断的样子（多半是 token 预算打满）。
    return `回复被截断：max_tokens 预算不够，或生成被中断（结尾是「…${tail}」，而且第 ${balance.position} 字符处的引号没关上）`;
  }
  const looksFinished = /[}\]]\s*$/.test(text);
  if (looksFinished) {
    return `回复里的 JSON 括号没配平：有 ${balance.depth} 个「{」一直没闭合——模型多半少写了闭合括号，不是回复被截断`;
  }
  return `回复被截断：max_tokens 预算不够，或生成被中断（结尾是「…${tail}」）`;
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
