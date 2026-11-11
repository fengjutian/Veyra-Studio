export type InspectorTabId = "properties" | "export" | "history" | "data" | "ai" | "settings";

export interface InspectorTabDefinition {
  id: InspectorTabId;
  label: string;
  /** 标题右侧的上下文摘要：当前选中、导出范围、当前版本、模型名。 */
  meta: string;
  /** 需要用户处理的条目数；为 0 时不显示角标。 */
  badge?: number;
}

export interface InspectorTabInput {
  /** 选中的节点数。 */
  selectionCount: number;
  /** 唯一选中节点的名字；未选中或多选时为空。 */
  selectedName?: string;
  exportScope: "page" | "selection";
  revision: number;
  assetCount: number;
  componentCount: number;
  diagnosticCount: number;
  warningCount: number;
  missingAssetCount: number;
  /** 启用真实模型时的模型名；未配置时回退到演示规划器。 */
  aiModel?: string;
}

/**
 * 右侧栏的分段定义。
 *
 * 一个分段只负责一类信息：节点属性、导出诊断、版本历史、文档数据、AI。标题右侧
 * 显示当前分段的上下文，角标只在真有需要处理的条目时出现——否则整条属性、历史、
 * 存储、AI 的长列表会被塞进 280px 宽的侧栏，用户只能一直滚动。
 */
export function inspectorTabs(input: InspectorTabInput): InspectorTabDefinition[] {
  return [
    { id: "properties", label: "属性", meta: selectionMeta(input), badge: badge(input.warningCount) },
    { id: "export", label: "导出", meta: input.exportScope === "selection" ? "导出选区" : "导出整页", badge: badge(input.diagnosticCount) },
    { id: "history", label: "历史", meta: `当前 r${input.revision}` },
    { id: "data", label: "数据", meta: `${input.assetCount} 资源 · ${input.componentCount} 组件`, badge: badge(input.missingAssetCount) },
    { id: "ai", label: "AI", meta: input.aiModel || "演示规划器" },
    { id: "settings", label: "设置", meta: "偏好与服务" },
  ];
}

function badge(count: number): number | undefined {
  return count > 0 ? count : undefined;
}

function selectionMeta(input: InspectorTabInput): string {
  if (input.selectionCount > 1) return `已选 ${input.selectionCount} 个`;
  if (input.selectionCount === 1) return input.selectedName || "未命名节点";
  return "未选中";
}
