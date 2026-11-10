import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { MAX_INSPECTOR_WIDTH, MIN_INSPECTOR_WIDTH, clampInspectorWidth } from "./inspector-resize";

interface InspectorResizeHandleProps {
  width: number;
  onResize: (width: number) => void;
}

export function InspectorResizeHandle({ width, onResize }: InspectorResizeHandleProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | undefined>(undefined);

  const resize = (nextWidth: number) => onResize(clampInspectorWidth(nextWidth, window.innerWidth));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    resize(drag.current.startWidth + drag.current.startX - event.clientX);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") resize(width + step);
    else if (event.key === "ArrowRight") resize(width - step);
    else if (event.key === "Home") resize(MIN_INSPECTOR_WIDTH);
    else if (event.key === "End") resize(MAX_INSPECTOR_WIDTH);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="inspector-resize-handle"
      role="separator"
      aria-label="调整右侧面板宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_INSPECTOR_WIDTH}
      aria-valuemax={MAX_INSPECTOR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
