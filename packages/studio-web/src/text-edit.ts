/**
 * Pure rules for editing text directly on the canvas.
 *
 * The canvas editor itself is a React component, but the decisions that say
 * whether a keystroke commits the text, inserts a line break or cancels the
 * edit are business rules. They live here so they can be unit tested without
 * a DOM.
 */

export type TextEditAction = "commit" | "newline" | "cancel";

/**
 * Decides what a keystroke means while editing text on the canvas.
 *
 * Enter commits the edit, Shift+Enter inserts a line break and Escape cancels
 * it. Every other key is handled by the textarea itself.
 */
export function textEditAction(key: string, shiftKey: boolean): TextEditAction | undefined {
  if (key === "Escape") return "cancel";
  if (key === "Enter") return shiftKey ? "newline" : "commit";
  return undefined;
}

/**
 * Returns the text to persist, or undefined when the edit changed nothing.
 *
 * An empty string is a legitimate text value, so only an unchanged draft counts
 * as "no edit" — that keeps a double click that did not change anything from
 * bumping the revision counter.
 */
export function commitText(original: string, draft: string): string | undefined {
  return draft === original ? undefined : draft;
}
