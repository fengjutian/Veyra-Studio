import type { ProviderCapabilities } from "./provider-matrix";

/**
 * 真实 Provider 验收记录。
 *
 * 能力矩阵里的「支持 json 模式 / 支持流式」以前是**读文档抄下来的**——那不是验收。
 * 这里的每一条都是拿真服务跑出来的结论，由 `npm run ai:provider:acceptance` 测得，
 * 用 `--verify` 可以再测一遍并与仓库里的记录对账。
 *
 * 记录里**不含密钥**：验收工具只从环境变量读密钥，报告里也不带。
 */
export interface ProviderAcceptance {
  /** 对应能力矩阵里的预设 id；自建端点记 "custom"。 */
  providerId: string;
  baseUrl: string;
  model: string;
  /** 验收日期（YYYY-MM-DD）。 */
  verifiedAt: string;
  checks: {
    /** `/models` 能列出模型，且包含被测模型。 */
    models: boolean;
    /** 普通对话能通。 */
    chat: boolean;
    /** `response_format: json_object` 被遵守。 */
    jsonMode: boolean;
    /** SSE 流式能收到增量。 */
    stream: boolean;
    /** 规划器往返：提示 → 回复 → 命令计划 → dry-run 落地。 */
    planRoundTrip: boolean;
    /** Bearer 鉴权可用。 */
    bearerAuth: boolean;
    /**
     * 能看图（多模态输入）。
     *
     * 实测方式：发一张已知内容的小图，看模型能不能描述出来。没测过的端点
     * **不写这个字段**——「没验过」不等于「不支持」。
     */
    vision?: boolean;
    /**
     * 带图的规划器往返：仓库提示 + 一张画着文档的图 → 模型 → 命令计划 → dry-run。
     *
     * `vision` 只证明「模型能看图」，这一项才证明「模型能看着图给出本产品能
     * 执行的命令」。
     */
    visionPlanRoundTrip?: boolean;
  };
  /** 每项检查的细节（给人看的）。 */
  notes: string[];
}

/**
 * 已实测的 Provider。
 *
 * 空数组表示「都还没实测」——面板会把预设里的能力标成**文档推断**而不是**实测**，
 * 不会拿没验过的结论当事实卖。
 */
export const PROVIDER_ACCEPTANCE: ProviderAcceptance[] = [
  {
    providerId: "minimax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
    verifiedAt: "2026-11-10",
    checks: {
      models: true,
      chat: true,
      jsonMode: true,
      stream: true,
      planRoundTrip: true,
      bearerAuth: true,
      vision: true,
      visionPlanRoundTrip: true,
    },
    notes: [
      "models：可用 9 个模型（MiniMax-M3.1-Flash / M3 / M2.7 / M2.5 / M2.1 / M2 及 highspeed 变体）",
      "chat：普通对话正常返回",
      "jsonMode：接受 response_format=json_object，但正文带 <think>…</think> 推理前缀——解析器必须先剥推理块再找 JSON",
      "stream：SSE 增量正常，能收到多段 content",
      "planRoundTrip：真实规划器提示 → 回复 → 命令计划 → dry-run 全通",
      "编排循环：真实模型 1 轮收敛（stopReason=converged）——此前因词汇表的颜色写法错误而震荡",
      "鉴权：Bearer 正常；未测 401 后的换钥行为（用密钥环本地验证）",
      "vision：发一张已知内容的 PNG，模型在推理里描述出了图中的颜色与形状——确认能吃 image_url",
      "visionPlanRoundTrip：仓库提示 + 一张画着样例文档的图 → 模型给出命令计划 → dry-run 通过",
      "2026-11-10 复验：vision 改用纯蓝 32×32 PNG 复测（模型答出蓝色），visionPlanRoundTrip 复测通过；其余各项一并复跑",
    ],
  },
];

/** 验收记录对应的能力结论：有实测就以实测为准。 */
export function capabilitiesFromAcceptance(acceptance: ProviderAcceptance): ProviderCapabilities {
  return {
    jsonMode: acceptance.checks.jsonMode,
    stream: acceptance.checks.stream,
    auth: acceptance.checks.bearerAuth ? "bearer" : "none",
    // 没测过看图就**不标**这个字段：标成 false 会让界面误以为「不支持」，
    // 而实际可能只是没验。
    ...(acceptance.checks.vision !== undefined ? { vision: acceptance.checks.vision } : {}),
  };
}

/** 某个地址有没有实测记录。 */
export function findAcceptance(baseUrl: string): ProviderAcceptance | undefined {
  const target = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  return PROVIDER_ACCEPTANCE.find(item => {
    const known = item.baseUrl.trim().toLowerCase().replace(/\/+$/, "");
    return target === known || target.startsWith(`${known}/`);
  });
}
