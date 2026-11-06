/**
 * 统一的悬浮提示。
 *
 * 替代原生 `title` 属性：原生提示延迟约 1 秒、样式跟随操作系统（不匹配深色主题）、
 * 键盘用户看不到、滚动时消失。
 *
 * 触发器用 `<span>` 包一层而不是直接把按钮当触发器：`disabled` 的按钮不会派发鼠标
 * 事件，包一层后 hover 仍能命中外层 span，而按钮自身的焦点事件会冒泡到 span，
 * 所以键盘聚焦也能弹出提示。
 */
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <span className="tooltip-anchor">{children}</span>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="tooltip" side={side} sideOffset={6}>
          {label}
          <TooltipPrimitive.Arrow className="tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
