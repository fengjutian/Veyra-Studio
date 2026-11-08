import { useEffect, useRef } from "react";
import type { GridTrack } from "@ufira/design-schema";
import { isResizableGridTrack } from "@ufira/design-layout";
import {
  addGridTrack,
  layoutGridTracks,
  removeGridTrack,
  resizeGridTrackBoundary,
  type GridTrackModel,
} from "./grid-track-model";

/**
 * Grid 轨道可视化编辑器。
 *
 * 规格见 `docs/grid-layout.md`。
 *
 * 组件是**完全受控**的：它不持有轨道状态，每次改动都通过 `onChange` 回调，
 * 由属性面板把新的轨道声明写回文档。这样轨道条上看到的宽度、
 * 文档里存的声明、画布上画出来的布局是同一份数据。
 *
 * 轨道宽度怎么算、约束怎么夹，全部在 `grid-track-model.ts`（纯函数）里，
 * 这里只负责把指针事件翻译成模型调用。
 */

export interface GridTrackEditorProps {
  /** 轨道声明。 */
  tracks: GridTrack[];
  /** 轨道之间的间隙（对应 `GridSpec.columnGap`）。 */
  gutter?: number;
  /** 网格四周留白（视图层概念，不写回文档）。 */
  margin?: number;
  /** 容器内容区宽度——轨道宽度的换算基准。 */
  containerWidth: number;
  /** 内容轨道的实测宽度（与轨道顺序对齐）；缺项按最小宽度估算。 */
  contentWidths?: (number | undefined)[];
  /** 面板是否只读。 */
  disabled?: boolean;
  /** 轨道条的视图宽度（px）。容器更宽时按比例缩放显示。 */
  viewWidth?: number;
  /** 轨道或间隙变化时回调。 */
  onChange(next: { tracks: GridTrack[]; gutter: number }): void;
}

export function GridTrackEditor({
  tracks,
  gutter = 0,
  margin = 0,
  containerWidth,
  contentWidths,
  disabled,
  viewWidth = 240,
  onChange,
}: GridTrackEditorProps) {
  const model: GridTrackModel = { tracks, gutter, margin, containerWidth, contentWidths };
  const layout = layoutGridTracks(model);
  // 容器比轨道条宽时按比例缩放显示；拖拽位移会除以缩放比，还原成真实像素。
  const scale = containerWidth > viewWidth && containerWidth > 0 ? viewWidth / containerWidth : 1;

  // 拖拽过程中组件不重算模型，而是把位移量累加到最新的模型上。
  const modelRef = useRef(model);
  modelRef.current = model;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const dragRef = useRef<{ index: number; lastX: number } | null>(null);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = (event.clientX - drag.lastX) / scaleRef.current;
      if (!delta) return;
      drag.lastX = event.clientX;
      const next = resizeGridTrackBoundary(modelRef.current, drag.index, delta);
      onChangeRef.current({ tracks: next.tracks, gutter: next.model.gutter });
    };
    const handleUp = () => { dragRef.current = null; };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, []);

  const handleAdd = () => {
    if (disabled) return;
    const next = addGridTrack(model, "fixed");
    onChange({ tracks: next.tracks, gutter: next.model.gutter });
  };

  const handleRemove = () => {
    if (disabled || tracks.length <= 1) return;
    const next = removeGridTrack(model, tracks.length - 1);
    onChange({ tracks: next.tracks, gutter: next.model.gutter });
  };

  const handlePointerDown = (index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { index, lastX: event.clientX };
  };

  const barWidth = Math.max(0, layout.availableWidth * scale);

  return (
    <div className="field">
      <span className="field-label">轨道</span>
      <div className="grid-track-editor" style={{ display: "grid", gap: 6 }}>
        <div
          className="grid-track-editor-bar"
          style={{
            position: "relative",
            width: barWidth,
            height: 26,
            borderRadius: 6,
            overflow: "hidden",
            background: "#0b0d12",
            border: "1px solid #363d4b",
          }}
        >
          {layout.widths.map((width, index) => (
            <div
              key={index}
              className="grid-track-editor-cell"
              title={`轨道 ${index + 1}：${Math.round(width)}px`}
              style={{
                position: "absolute",
                left: layout.offsets[index] * scale,
                width: Math.max(1, width * scale),
                top: 0,
                bottom: 0,
                boxSizing: "border-box",
                background: "#2b2140",
                borderRight: "1px solid #4c1d95",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: "#c4b5fd",
                overflow: "hidden",
              }}
            >
              {index + 1}
            </div>
          ))}
          {layout.model.gutter > 0 && layout.widths.slice(0, -1).map((_, index) => (
            <div
              key={`gap-${index}`}
              className="grid-track-editor-gutter"
              style={{
                position: "absolute",
                left: (layout.offsets[index] + layout.widths[index]) * scale,
                width: Math.max(1, layout.model.gutter * scale),
                top: 0,
                bottom: 0,
                boxSizing: "border-box",
                background: "#0b0d12",
                borderLeft: "1px dashed #363d4b",
                borderRight: "1px dashed #363d4b",
                pointerEvents: "none",
              }}
            />
          ))}
          {layout.tracks.slice(0, -1).map((track, index) => {
            const boundary = (layout.offsets[index] + layout.widths[index]) * scale;
            // 相邻两条都是内容轨道时没有可调整的对象——把手柄标成不可用。
            const adjustable = isResizableGridTrack(track) || isResizableGridTrack(layout.tracks[index + 1]);
            return (
              <button
                key={`handle-${index}`}
                type="button"
                className="grid-track-editor-handle"
                aria-label={`调整轨道 ${index + 1} 与 ${index + 2} 的边界`}
                title={adjustable ? "拖拽调整轨道宽度" : "内容轨道宽度由内容决定"}
                disabled={disabled || !adjustable}
                onPointerDown={handlePointerDown(index)}
                style={{
                  position: "absolute",
                  left: boundary - 4,
                  top: 0,
                  bottom: 0,
                  width: 8,
                  display: "block",
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: adjustable ? "col-resize" : "not-allowed",
                  touchAction: "none",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: 2,
                    height: "100%",
                    margin: "0 auto",
                    background: adjustable ? "#8b5cf6" : "#363d4b",
                    opacity: 0.6,
                  }}
                />
              </button>
            );
          })}
        </div>
        <div className="grid-track-editor-actions" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" className="grid-track-add" disabled={disabled} onClick={handleAdd}>
            + 轨道
          </button>
          <button type="button" className="grid-track-add" disabled={disabled || tracks.length <= 1} onClick={handleRemove}>
            − 轨道
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#98a2b3" }}>
            {tracks.length} 条 · 间隙 {layout.model.gutter}px
          </span>
        </div>
        {layout.diagnostics.map(diagnostic => (
          <div key={`${diagnostic.code}-${diagnostic.index ?? ""}`} className="warning-row">
            <span className="warning-code">{diagnostic.code}</span>
            <span className="warning-message">{diagnostic.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
