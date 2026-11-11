import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description: ReactNode;
  action?: { label: string; icon?: IconName; disabled?: boolean; onClick(): void };
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <div className={`empty-state${compact ? " is-compact" : ""}`}>
      <span className="empty-state-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <strong className="empty-state-title">{title}</strong>
      <p className="empty-state-description">{description}</p>
      {action && <button type="button" className="empty-state-action" disabled={action.disabled} onClick={action.onClick}>
        {action.icon && <Icon name={action.icon} size={14} />}{action.label}
      </button>}
    </div>
  );
}
