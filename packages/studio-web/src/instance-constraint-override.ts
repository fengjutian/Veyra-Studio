import type { Constraints, DesignDocument, DesignNode } from "@ufira/design-schema";
import { overridableFields } from "@ufira/design-schema";

/**
 * 组件实例内的约束覆盖。
 *
 * 组件实例的子树在实例化时就被**物化**成 `instanceId--sourceId` 的真实节点，所以
 * 「在这个实例里改掉约束」技术上只是改这些副本的 `constraints`。
 *
 * 让这次覆盖**语义成立**（改的是这个实例，不是组件定义，也不是别的实例）需要三层都认账：
 *
 * - design-schema：`OverrideField` 有 `"constraints"`，`overridableFields` 放行；
 * - design-runtime：`component.override` 的 payload patch 能带 constraints，
 *   `overrideInstanceNode` 校验并写进副本与 `instance.overrides`，
 *   `applyOverrides` 在物化时把覆盖应用到副本上，`resetOneOverride` 恢复组件定义的值；
 * - studio-web：本模块负责目标解析与补丁形状，界面在 `main.tsx` 里发命令。
 *
 * 三层都已就位，所以下面这个开关是 true。
 */

/**
 * 运行时是否已经接受 constraints 覆盖。
 *
 * true：design-schema 的白名单放行了 `constraints`，design-runtime 的
 * `component.override` 也会把它写进副本与 `instance.overrides`。
 */
export const INSTANCE_CONSTRAINT_OVERRIDE_SUPPORTED = true;

/** 实例里可覆盖约束的一个目标节点。 */
export interface InstanceConstraintTarget {
  /** 实例里物化出来的副本 id。 */
  copyId: string;
  /** 组件定义里的源节点 id（覆盖记录用它做键）。 */
  sourceNodeId: string;
  /** 界面标签。 */
  name: string;
  /** 副本当前的约束。 */
  constraints?: Constraints;
  /** 源节点是否允许被覆盖约束（取决于 design-schema 的白名单）。 */
  overridable: boolean;
}

/** 一次约束覆盖的补丁形状。 */
export interface InstanceConstraintOverridePlan {
  /** 运行时是否接受这次覆盖。 */
  supported: boolean;
  /** `component.override` 的 payload.patch 形状。 */
  patch: { constraints: Constraints };
  /** 不支持时的原因：界面要把它显示出来，而不是默默失败。 */
  reason?: string;
}

/**
 * 节点是不是某个实例里的物化副本。
 *
 * 插槽内容（id 里带 `--slot--`）不算：那是用户填进去的，不属于组件定义，
 * 也就没有「组件定义里的源节点」可键。
 */
export function findInstanceCopy(document: DesignDocument, nodeId: string): { instanceId: string; sourceNodeId: string } | undefined {
  let current: DesignNode | undefined = document.nodes[nodeId];
  while (current) {
    if (current.type === "instance") {
      const prefix = `${current.id}--`;
      if (nodeId.startsWith(prefix) && !nodeId.includes("--slot--")) {
        return { instanceId: current.id, sourceNodeId: nodeId.slice(prefix.length) };
      }
      return undefined;
    }
    const parentId = current.parentId;
    current = parentId ? document.nodes[parentId] : undefined;
  }
  return undefined;
}

/** 实例里所有可以设约束的物化副本。 */
export function collectInstanceConstraintTargets(document: DesignDocument, instanceId: string): InstanceConstraintTarget[] {
  const prefix = `${instanceId}--`;
  const targets: InstanceConstraintTarget[] = [];
  const walk = (id: string): void => {
    const node = document.nodes[id];
    if (!node) return;
    if (id.startsWith(prefix) && !id.includes("--slot--")) {
      const sourceNodeId = id.slice(prefix.length);
      const source = document.nodes[sourceNodeId];
      if (source) {
        targets.push({
          copyId: id,
          sourceNodeId,
          name: node.name,
          constraints: node.constraints,
          overridable: allowsConstraintOverride(source),
        });
      }
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(instanceId);
  return targets;
}

/** 源节点是否允许被覆盖约束（看 design-schema 的可覆盖字段白名单）。 */
function allowsConstraintOverride(source: DesignNode): boolean {
  const fields = overridableFields(source) as readonly string[];
  return fields.includes("constraints");
}

/**
 * 规划一次实例内的约束覆盖。
 *
 * 运行时还不支持时**不发命令**：界面会显示原因，而不是让运行时抛一个
 * 「cannot override constraints」把整次操作打回去。
 */
export function planInstanceConstraintOverride(target: InstanceConstraintTarget, constraints: Constraints): InstanceConstraintOverridePlan {
  const patch = { constraints };
  if (!INSTANCE_CONSTRAINT_OVERRIDE_SUPPORTED) {
    return {
      supported: false,
      patch,
      reason: "运行时还不接受实例内的约束覆盖：design-schema 的 OverrideField 与 design-runtime 的 component.override 都要先放行 constraints",
    };
  }
  if (!target.overridable) {
    return { supported: false, patch, reason: `节点「${target.name}」不在可覆盖字段白名单里` };
  }
  return { supported: true, patch };
}
