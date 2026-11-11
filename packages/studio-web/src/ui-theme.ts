export type UiTheme = "dark" | "light";

export const UI_THEME_STORAGE_KEY = "veyra:ui-theme";

export function readUiTheme(storage: Pick<Storage, "getItem"> = localStorage): UiTheme {
  try {
    return storage.getItem(UI_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyUiTheme(theme: UiTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.uiTheme = theme;
  root.style.colorScheme = theme;
}

export function writeUiTheme(theme: UiTheme, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching remains useful when storage is unavailable (private mode or policy).
  }
}
