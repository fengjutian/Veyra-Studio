import { useId, useState, type ReactNode } from "react";
import { Icon } from "../icons";

export const COLLAPSIBLE_SECTION_STORAGE_KEY = "veyra:property-sections";

type SectionState = Record<string, boolean>;

export function readSectionState(storage?: Pick<Storage, "getItem">): SectionState {
  if (!storage) return {};
  try {
    const value = storage.getItem(COLLAPSIBLE_SECTION_STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SectionState : {};
  } catch {
    return {};
  }
}

export function writeSectionState(id: string, open: boolean, storage?: Pick<Storage, "getItem" | "setItem">): void {
  if (!storage) return;
  try {
    storage.setItem(COLLAPSIBLE_SECTION_STORAGE_KEY, JSON.stringify({ ...readSectionState(storage), [id]: open }));
  } catch {
    // Storage can be unavailable in private browsing or a sandboxed preview.
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function CollapsibleSection({ id, title, defaultOpen = true, children }: { id: string; title: string; defaultOpen?: boolean; children: ReactNode }) {
  const contentId = useId();
  const storage = browserStorage();
  const [open, setOpen] = useState(() => readSectionState(storage)[id] ?? defaultOpen);
  const toggle = () => setOpen(current => {
    const next = !current;
    writeSectionState(id, next, storage);
    return next;
  });

  return (
    <section className={`property-section${open ? " is-open" : ""}`}>
      <button type="button" className="property-section-trigger" aria-expanded={open} aria-controls={contentId} onClick={toggle}>
        <span>{title}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      <div id={contentId} className="property-section-content" hidden={!open}>{children}</div>
    </section>
  );
}
