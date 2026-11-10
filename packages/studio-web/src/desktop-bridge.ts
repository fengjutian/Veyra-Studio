/**
 * 桌面端（Tauri）桥接。
 *
 * 这一层刻意**不依赖 @tauri-apps/api**：studio-web 的同一份前端要能同时跑在浏览器
 * 和桌面端，引入 Tauri 的 npm 包会把桌面专用代码打进网页构建里。Tauri v2 打开
 * `withGlobalTauri` 后会把 `window.__TAURI__` 挂在全局上，这里按鸭子类型探测：
 * 桌面上有就用，没有就走浏览器分支，网页构建里这段代码等于不存在。
 *
 * 桥接的形状只有两个动作：把字节写到用户选的位置（原生「另存为」），
 * 以及报回桌面端的落盘路径。别的桌面能力将来再加，不预先铺接口。
 */

interface TauriInvoke {
  (command: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriGlobal {
  core?: { invoke?: TauriInvoke };
}

interface TauriInternals {
  invoke?: TauriInvoke;
}

/**
 * 取出 Tauri 的 invoke 通道；不在桌面端时返回 undefined。
 *
 * `__TAURI__.core.invoke` 是打开 `withGlobalTauri` 后的公开入口，
 * `__TAURI_INTERNALS__.invoke` 是它底下的实现，两个都认，缺一个不至于整条链断掉。
 */
function tauriInvoke(): TauriInvoke | undefined {
  const scope = globalThis as { __TAURI__?: TauriGlobal; __TAURI_INTERNALS__?: TauriInternals };
  const core = scope.__TAURI__?.core;
  const invoke = core?.invoke ?? scope.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") return undefined;
  return (command, args) => invoke.call(core ?? scope.__TAURI_INTERNALS__, command, args);
}

/** 当前是否跑在桌面端外壳里。 */
export function isDesktop(): boolean {
  return tauriInvoke() !== undefined;
}

/**
 * 字节数组 → base64。
 *
 * IPC 的 JSON 通道只认文本，裸二进制会被展开成「数字数组」：一张 PNG 能顶到几十万个
 * 数字，序列化和解析都白费力气，base64 是这里最省事也最稳的编码。
 *
 * 分块转换：`String.fromCharCode(...bytes)` 一次喂太多元素会爆调用栈。
 */
export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * 桌面端保存文件：弹原生「另存为」，把内容写到用户选的位置。
 *
 * 返回真实落盘路径；用户取消返回 undefined。
 */
export async function saveFileOnDesktop(name: string, bytes: Uint8Array): Promise<string | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) return undefined;
  const path = await invoke("save_file", { name, contents: encodeBase64(bytes) });
  return typeof path === "string" ? path : undefined;
}
