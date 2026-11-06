import { withAutosave, type AutosaveRepository, type AutosaveStatus } from "@ufira/design-persistence";
import { DexieProjectRepository } from "./browser-repository";

/**
 * 工作台使用的仓库：底层是浏览器 IndexedDB，外面套一层自动保存。
 *
 * 事务日志即时写入（那是恢复的依据），快照合并写入（连续几次编辑只落一份盘）。
 */

const listeners = new Set<(status: AutosaveStatus) => void>();
let status: AutosaveStatus = { state: "idle", quotaExceeded: false, pendingCount: 0 };

export const repository: AutosaveRepository = withAutosave(new DexieProjectRepository(), {
  delayMs: 800,
  onStatusChange: next => {
    status = next;
    for (const listener of listeners) listener(next);
  },
});

export function subscribeAutosave(listener: (status: AutosaveStatus) => void): () => void {
  listeners.add(listener);
  listener(status);
  return () => { listeners.delete(listener); };
}

export function currentAutosaveStatus(): AutosaveStatus {
  return status;
}

/** 页面被关闭或切到后台时把待写快照立刻落盘。 */
export function installAutosaveFlush(): () => void {
  const flush = () => { void repository.flush(); };
  const onVisibilityChange = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
