/**
 * Grid 命名区域编辑器。
 *
 * 规格见 `docs/grid-layout.md`。
 *
 * 两件事放在一起，因为它们共用同一份模板：
 *
 * 1. 模板文本域（每行一个字符串，`.` 是空位），带实时校验；
 * 2. 子节点 → 区域的下拉框（`按顺序` 表示退回顺序填充）。
 *
 * 组件是**受控**的：所有改动都通过 `onChange` 交给属性面板写回文档，
 * 自己只持有文本域的草稿（用户打字打到一半的模板不能直接进文档）。
 */

import { useEffect, useState } from "react";
import type { GridCell, GridSpec, NodeId } from "@ufira/design-schema";
import {
  applyGridAreaText,
  checkGridAreaText,
  formatGridAreaText,
  gridAreaTemplateNames,
  setGridChildArea,
} from "./grid-areas-model";

export interface GridAreaEditorProps {
  grid: GridSpec;
  /** 容器的子节点（顺序 = 文档里的图层顺序，也是「按顺序」的排布顺序）。 */
  childIds: readonly NodeId[];
  /** 子节点显示名；缺省用 id。 */
  nodeName?(id: NodeId): string;
  disabled?: boolean;
  onChange(changes: { areas?: string[]; cells?: Record<NodeId, GridCell> }): void;
}

export function GridAreaEditor({ grid, childIds, nodeName, disabled, onChange }: GridAreaEditorProps) {
  const current = formatGridAreaText(grid.areas);
  const [draft, setDraft] = useState(current);
  // 文档被别处改动（切节点、撤销、AI 提交）时，草稿跟随。
  useEffect(() => { setDraft(current); }, [current]);

  const dirty = draft !== current;
  const issues = dirty ? checkGridAreaText(draft, grid) : [];
  const names = gridAreaTemplateNames(grid.areas);
  const cells = grid.cells ?? {};
  const pending = dirty && issues.length === 0 && draft.trim() !== current.trim();

  const apply = () => {
    if (disabled) return;
    const result = applyGridAreaText(draft, grid, grid.cells, childIds);
    if (!result.ok) return;
    onChange({ areas: result.areas, cells: result.cells });
  };

  const clear = () => {
    if (disabled) return;
    const result = applyGridAreaText("", grid, grid.cells, childIds);
    onChange({ areas: result.areas, cells: result.cells });
    setDraft("");
  };

  const assign = (nodeId: NodeId, index: number, value: string) => {
    if (disabled) return;
    onChange({ cells: setGridChildArea(grid.cells, nodeId, value || undefined, index, grid.columns.length) });
  };

  return (
    <div className="field">
      <span className="field-label">命名区域</span>
      <div style={{ display: "grid", gap: 6 }}>
        <textarea
          rows={Math.max(3, grid.rows.length)}
          value={draft}
          disabled={disabled}
          aria-label="命名区域模板，每行一个字符串"
          placeholder={'header header\nsidebar main'}
          spellCheck={false}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}
          onChange={event => setDraft(event.target.value)}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" className="grid-track-add" disabled={disabled || !pending} onClick={apply}>
            应用模板
          </button>
          <button type="button" className="grid-track-add" disabled={disabled || (!current && !draft)} onClick={clear}>
            清除
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#98a2b3" }}>
            {grid.areas?.length ? `${grid.areas.length} 行 · ${names.length} 个区域` : "未启用"}
          </span>
        </div>
        {issues.map(issue => (
          <div key={`${issue.code}-${issue.message}`} className="warning-row">
            <span className="warning-code">{issue.code}</span>
            <span className="warning-message">{issue.message}</span>
          </div>
        ))}
        {!issues.length && pending && (
          <div style={{ fontSize: 11, color: "#98a2b3" }}>
            模板有 {draft.split(/\r?\n/).filter(line => line.trim()).length} 行、列数与轨道一致，可以应用。
          </div>
        )}
        {names.length > 0 && (
          <div style={{ display: "grid", gap: 4 }}>
            <span className="field-label">子节点区域</span>
            {childIds.map((nodeId, index) => (
              <label key={nodeId} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {nodeName?.(nodeId) ?? nodeId}
                </span>
                <select
                  value={cells[nodeId]?.area ?? ""}
                  disabled={disabled}
                  aria-label={`${nodeName?.(nodeId) ?? nodeId} 的网格区域`}
                  onChange={event => assign(nodeId, index, event.target.value)}
                >
                  <option value="">按顺序</option>
                  {names.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
