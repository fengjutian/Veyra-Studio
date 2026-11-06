/**
 * 应用内弹窗 —— 替换浏览器原生 `window.prompt` / `window.confirm`。
 *
 * 原生弹窗的问题：样式不可控（不跟随深色主题）、阻塞主线程、无法做输入校验、
 * 无法做无障碍定制。Radix 只提供行为与焦点管理，视觉仍在 `styles.css` 里。
 *
 * 用法：
 *   const prompt = usePrompt();
 *   const name = await prompt({ title: "新项目名称", defaultValue: "未命名设计" });
 *   if (!name) return;
 *
 *   const confirm = useConfirm();
 *   if (!await confirm({ title: "删除项目", description: "…", destructive: true })) return;
 */
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export interface PromptRequest {
  title: string;
  /** 输入框上方的说明文字。 */
  description?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** 返回错误文案表示校验不通过；返回 undefined 表示通过。 */
  validate?: (value: string) => string | undefined;
}

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除等）用红色确认按钮。 */
  destructive?: boolean;
}

/** 三选一弹窗的选项。 */
export interface ChoiceOption {
  value: string;
  label: string;
  /** 危险操作用红色按钮。 */
  destructive?: boolean;
}

export interface ChoiceRequest {
  title: string;
  description?: string;
  options: ChoiceOption[];
  cancelLabel?: string;
}

type Pending =
  | { kind: "prompt"; request: PromptRequest }
  | { kind: "confirm"; request: ConfirmRequest }
  | { kind: "choice"; request: ChoiceRequest };

interface DialogApi {
  prompt(request: PromptRequest): Promise<string | null>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** 返回被选项的 value；取消或关闭返回 null。 */
  choice(request: ChoiceRequest): Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

/** 打开一个输入弹窗；取消或关闭返回 null。 */
export function usePrompt(): DialogApi["prompt"] {
  const api = useContext(DialogContext);
  if (!api) throw new Error("usePrompt 必须在 <DialogProvider> 内使用");
  return api.prompt;
}

/** 打开一个确认弹窗；取消或关闭返回 false。 */
export function useConfirm(): DialogApi["confirm"] {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useConfirm 必须在 <DialogProvider> 内使用");
  return api.confirm;
}

/** 打开一个多选一弹窗；返回被选项的 value，取消或关闭返回 null。 */
export function useChoice(): DialogApi["choice"] {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useChoice 必须在 <DialogProvider> 内使用");
  return api.choice;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  // resolve 存在 ref 里：setState 的 updater 可能是不可信的副作用位置（StrictMode 会调用两次）。
  const resolveRef = useRef<((value: string | null | boolean) => void) | null>(null);

  const prompt = useCallback((request: PromptRequest) => new Promise<string | null>(resolve => {
    resolveRef.current = resolve as (value: string | null | boolean) => void;
    setDraft(request.defaultValue ?? "");
    setError(undefined);
    setPending({ kind: "prompt", request });
  }), []);

  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>(resolve => {
    resolveRef.current = resolve as (value: string | null | boolean) => void;
    setPending({ kind: "confirm", request });
  }), []);

  const choice = useCallback((request: ChoiceRequest) => new Promise<string | null>(resolve => {
    resolveRef.current = resolve as (value: string | null | boolean) => void;
    setPending({ kind: "choice", request });
  }), []);

  const api = useMemo<DialogApi>(() => ({ prompt, confirm, choice }), [prompt, confirm, choice]);

  const settle = (value: string | null | boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    setError(undefined);
    resolve?.(value);
  };

  const submitPrompt = (event: React.FormEvent) => {
    event.preventDefault();
    if (!pending || pending.kind !== "prompt") return;
    const message = pending.request.validate?.(draft);
    if (message) {
      setError(message);
      return;
    }
    settle(draft);
  };

  const promptRequest = pending?.kind === "prompt" ? pending.request : undefined;
  const confirmRequest = pending?.kind === "confirm" ? pending.request : undefined;
  const choiceRequest = pending?.kind === "choice" ? pending.request : undefined;

  return (
    <DialogContext.Provider value={api}>
      {children}

      <DialogPrimitive.Root
        open={Boolean(promptRequest)}
        onOpenChange={open => { if (!open) settle(null); }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="dialog-overlay" />
          <DialogPrimitive.Content
            className="dialog-content"
            onOpenAutoFocus={event => {
              event.preventDefault();
              inputRef.current?.focus();
              inputRef.current?.select();
            }}
          >
            <DialogPrimitive.Title className="dialog-title">
              {promptRequest?.title ?? ""}
            </DialogPrimitive.Title>
            {promptRequest?.description
              ? <DialogPrimitive.Description className="dialog-description">{promptRequest.description}</DialogPrimitive.Description>
              : <DialogPrimitive.Description className="dialog-description dialog-description-empty" />}
            <form onSubmit={submitPrompt}>
              {promptRequest?.label
                ? <label className="dialog-field">
                    <span className="dialog-field-label">{promptRequest.label}</span>
                    <input
                      ref={inputRef}
                      className="dialog-input"
                      value={draft}
                      placeholder={promptRequest.placeholder}
                      onChange={event => { setDraft(event.target.value); setError(undefined); }}
                    />
                  </label>
                : <input
                  ref={inputRef}
                  className="dialog-input"
                  value={draft}
                  placeholder={promptRequest?.placeholder}
                  onChange={event => { setDraft(event.target.value); setError(undefined); }}
                />}
              {error ? <p className="dialog-error" role="alert">{error}</p> : null}
              <div className="dialog-actions">
                <button type="button" onClick={() => settle(null)}>取消</button>
                <button type="submit" className="dialog-primary">{promptRequest?.confirmLabel ?? "确定"}</button>
              </div>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <AlertDialogPrimitive.Root
        open={Boolean(confirmRequest)}
        onOpenChange={open => { if (!open) settle(false); }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="dialog-overlay" />
          <AlertDialogPrimitive.Content className="dialog-content">
            <AlertDialogPrimitive.Title className="dialog-title">
              {confirmRequest?.title ?? ""}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="dialog-description">
              {confirmRequest?.description ?? ""}
            </AlertDialogPrimitive.Description>
            <div className="dialog-actions">
              <AlertDialogPrimitive.Cancel asChild>
                <button type="button">{confirmRequest?.cancelLabel ?? "取消"}</button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                {/* 必须在这里结算：Radix 的 Action 关闭弹窗时会再触发一次 onOpenChange，
                    不先结算的话 promise 会被那次关闭覆盖成 false。 */}
                <button type="button" className={confirmRequest?.destructive ? "dialog-danger" : "dialog-primary"} onClick={() => settle(true)}>
                  {confirmRequest?.confirmLabel ?? "确定"}
                </button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>

      <AlertDialogPrimitive.Root
        open={Boolean(choiceRequest)}
        onOpenChange={open => { if (!open) settle(null); }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="dialog-overlay" />
          <AlertDialogPrimitive.Content className="dialog-content">
            <AlertDialogPrimitive.Title className="dialog-title">
              {choiceRequest?.title ?? ""}
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="dialog-description">
              {choiceRequest?.description ?? ""}
            </AlertDialogPrimitive.Description>
            <div className="dialog-actions">
              {choiceRequest?.options.map(option => (
                <AlertDialogPrimitive.Action key={option.value} asChild>
                  <button type="button" className={option.destructive ? "dialog-danger" : "dialog-primary"} onClick={() => settle(option.value)}>
                    {option.label}
                  </button>
                </AlertDialogPrimitive.Action>
              ))}
              <AlertDialogPrimitive.Cancel asChild>
                <button type="button">{choiceRequest?.cancelLabel ?? "取消"}</button>
              </AlertDialogPrimitive.Cancel>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </DialogContext.Provider>
  );
}
