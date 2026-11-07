/**
 * 画布右键菜单 —— 基于 Radix ContextMenu（MIT）。
 *
 * 菜单项集合对标 Excalidraw 的 context menu（复制/粘贴/重复/删除/图层顺序/锁定），
 * 但每一条都直接落到 Studio 已有的命令函数上，不新增业务逻辑。
 *
 * 用法：<ContextMenuRoot> 包住 <ContextMenuTrigger> 与 <ContextMenuContent>。
 * Trigger 用 `asChild` 把事件挂到已有画布元素上，因此右键命中的是画布本身而不是包装层。
 */
import type { MouseEvent, ReactElement, ReactNode } from "react";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "../icons";

export function ContextMenuRoot({ children }: { children: ReactNode }) {
  return <RadixContextMenu.Root>{children}</RadixContextMenu.Root>;
}

/**
 * 右键触发器。`onContextMenu` 会在 Radix 打开菜单之前触发，因此这里可以安全地
 * 读取 `event.target` 判断命中了哪个节点；不要调用 `preventDefault`，那会阻断菜单打开。
 */
export function ContextMenuTrigger({
  children,
  onContextMenu,
}: {
  children: ReactElement;
  onContextMenu?(event: MouseEvent<HTMLElement>): void;
}) {
  return (
    <RadixContextMenu.Trigger asChild onContextMenu={onContextMenu}>
      {children}
    </RadixContextMenu.Trigger>
  );
}

export function ContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content className="context-menu" sideOffset={4} align="start" collisionPadding={8}>
        {children}
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  children,
  icon,
  shortcut,
  danger,
  disabled,
  onSelect,
}: {
  children: ReactNode;
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?(): void;
}) {
  return (
    <RadixContextMenu.Item
      className={danger ? "context-menu-item context-menu-danger" : "context-menu-item"}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon ? <Icon name={icon} size={13} /> : <span className="context-menu-icon" />}
      <span className="context-menu-label">{children}</span>
      {shortcut ? <span className="context-menu-shortcut">{shortcut}</span> : null}
    </RadixContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className="context-menu-separator" />;
}

/** 二级菜单，例如「图层顺序」「对齐」「添加」。 */
export function ContextMenuSub({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <RadixContextMenu.Sub>
      <RadixContextMenu.SubTrigger className="context-menu-item">
        {icon ? <Icon name={icon} size={13} /> : <span className="context-menu-icon" />}
        <span className="context-menu-label">{label}</span>
        <span className="context-menu-shortcut">›</span>
      </RadixContextMenu.SubTrigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.SubContent className="context-menu" sideOffset={2} alignOffset={-4} collisionPadding={8}>
          {children}
        </RadixContextMenu.SubContent>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Sub>
  );
}
