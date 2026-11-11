import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export interface ToolbarMenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

export function ToolbarMenu({ label, icon, iconOnly = false, items, children }: {
  label: string;
  icon?: IconName;
  iconOnly?: boolean;
  items: ToolbarMenuItem[];
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  const triggerRect = open ? trigger.current?.getBoundingClientRect() : undefined;
  const menuPosition: CSSProperties | undefined = triggerRect
    ? { top: triggerRect.bottom + 5, right: Math.max(8, window.innerWidth - triggerRect.right) }
    : undefined;

  return <div className="toolbar-menu" ref={root}>
    <button ref={trigger} className={`toolbar-menu-trigger${iconOnly ? " icon-only" : ""}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {icon ? <Icon name={icon} /> : null}
      {iconOnly ? null : <><span>{children ?? label}</span><Icon name="chevronDown" size={11} /></>}
    </button>
    {open ? <div className="toolbar-menu-content" role="menu" aria-label={label} style={menuPosition}>
      {items.map(item => <button
        key={item.label}
        type="button"
        role="menuitem"
        className={item.danger ? "toolbar-menu-item is-danger" : "toolbar-menu-item"}
        disabled={item.disabled}
        onClick={() => { setOpen(false); item.onSelect(); }}
      >
        {item.icon ? <Icon name={item.icon} /> : <span className="toolbar-menu-icon" />}
        <span>{item.label}</span>
      </button>)}
    </div> : null}
  </div>;
}
