import type { BooleanOperation } from "@ufira/design-schema";
import type { IconName } from "./icons";

export type { BooleanOperation } from "@ufira/design-schema";

/**
 * 布尔运算的展示元数据。
 *
 * 几何与语义已经移到 `@ufira/design-schema`（`boolean.ts`）：文档里存的是**运算树**，
 * 读取时按操作数实时计算，所以这里只剩 UI 需要的标签与图标。
 */
export interface BooleanOperationSpec {
  id: BooleanOperation;
  label: string;
  icon: IconName;
  /** 事务历史里的一句话。 */
  summary: string;
}

export const BOOLEAN_OPERATIONS: readonly BooleanOperationSpec[] = [
  { id: "union", label: "合并", icon: "booleanUnion", summary: "合并形状" },
  { id: "subtract", label: "减去", icon: "booleanSubtract", summary: "减去形状" },
  { id: "intersect", label: "交集", icon: "booleanIntersect", summary: "形状交集" },
  { id: "exclude", label: "排除", icon: "booleanExclude", summary: "排除重叠" },
];
