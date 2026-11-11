import { Icon } from "../icons";

export type FeedbackTone = "neutral" | "success" | "warning" | "error";

export function feedbackTone(message: string): FeedbackTone {
  if (/失败|错误|无法|不合法|缺失|拒绝|中断/.test(message)) return "error";
  if (/警告|跳过|未配置|没有|取消|待修/.test(message)) return "warning";
  if (/已|成功|完成|就绪/.test(message)) return "success";
  return "neutral";
}

export function WorkbenchFeedback({ message, busy, onDismiss }: { message: string; busy: boolean; onDismiss(): void }) {
  if (!message || message === "就绪") return null;
  const tone = feedbackTone(message);
  return <div className={`workbench-feedback is-${tone}${busy ? " is-busy" : ""}`} role={tone === "error" ? "alert" : "status"} aria-live="polite">
    <span className="workbench-feedback-dot" aria-hidden="true" />
    <span className="workbench-feedback-message" title={message}>{message}</span>
    <button className="icon-only" aria-label="关闭提示" onClick={onDismiss}><Icon name="close" size={12} /></button>
  </div>;
}
